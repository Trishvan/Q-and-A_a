import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import { askWithLlama } from "./llama.js";
import { vectorSearchForPdfBuffer } from "./vectorStore.js";
import crypto from "crypto";

const app = express();
app.use(express.json());

// ---------- Upload persistence setup ----------
const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log("Created upload dir:", UPLOAD_DIR);
}

// store files on disk with original name + timestamp to avoid collisions
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-z0-9.\-_]/gi, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage });

// Optional: lightweight index dir scaffolding (for future caching of pages/embeddings)
const INDEX_DIR = path.resolve(process.cwd(), "indexes");
if (!fs.existsSync(INDEX_DIR)) {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
}
// helper functions (not used by default, but ready if you want caching later)
function getIndexPathFor(filename) {
  return path.join(INDEX_DIR, `${filename}.pages.json`);
}
function loadIndexIfExists(filename) {
  const p = getIndexPathFor(filename);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.warn("Failed to load index for", filename, e);
    return null;
  }
}
function saveIndex(filename, indexObj) {
  const p = getIndexPathFor(filename);
  fs.writeFileSync(p, JSON.stringify(indexObj, null, 2), "utf8");
}

// improved route with robust logging and abort detection (multi-PDF support)
app.post("/ask", upload.array("pdf"), async (req, res) => {
  const start = Date.now();
  let finished = false;
  let answer = null;

  req.on("close", () => {
    if (!finished) console.warn("Client closed connection before response finished (aborted).");
  });

  try {
    console.log("--- /ask called (multi-pdf, uploadId support) ---");
    console.log("Headers:", req.headers["content-type"]);
    console.log("Body keys:", Object.keys(req.body || {}));

    // Multer has now processed any uploaded files into UPLOAD_DIR as file.path
    // req.files may be empty on follow-ups. We'll support both flows:
    // 1) New upload: req.files present -> create a new uploadId folder and move files into it.
    // 2) Follow-up: req.files empty but req.body.uploadId provided -> load files from that folder.

    // collect all uploaded parts (may be empty)
    const allFiles = req.files || [];
    console.log("raw uploaded parts count:", allFiles.length);

    // read uploadId from body (if client supplied it for follow-up)
    let uploadIdFromClient = req.body && req.body.uploadId ? String(req.body.uploadId) : null;

    // If there were uploaded files, create a new uploadId (unless client explicitly supplied one)
    // We will store files in uploads/<uploadId>/...
    let uploadId = uploadIdFromClient;
    if (allFiles.length > 0 && !uploadId) {
      // generate a stable random id
      uploadId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const dir = path.join(UPLOAD_DIR, uploadId);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // move each multer-saved file into the uploadId folder
      for (const f of allFiles) {
        const dest = path.join(dir, f.filename);
        try {
          fs.renameSync(f.path, dest); // move file
          // update f.path to new location so later code can read it
          f.path = dest;
          f.savedToUploadId = uploadId;
          console.log(`Moved uploaded file ${f.originalname} -> ${dest}`);
        } catch (mvErr) {
          console.warn("Failed to move uploaded file to uploadId folder, attempting copy then unlink:", mvErr);
          fs.copyFileSync(f.path, dest);
          fs.unlinkSync(f.path);
          f.path = dest;
          f.savedToUploadId = uploadId;
        }
      }
    }

    // If no files were uploaded in this request, but the client supplied uploadId,
    // load the saved files from that upload folder
    let files = [];
    if ((allFiles.length === 0) && uploadIdFromClient) {
      const dir = path.join(UPLOAD_DIR, uploadIdFromClient);
      console.log("No files in request. Attempting to load files from uploadId:", uploadIdFromClient, "dir:", dir);
      if (fs.existsSync(dir)) {
        const names = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith(".pdf"));
        files = names.map(fname => {
          const full = path.join(dir, fname);
          return {
            originalname: fname.replace(/^\d+_/, ""), // best-effort original name (we saved with timestamp prefix)
            filename: fname,
            mimetype: "application/pdf",
            size: fs.statSync(full).size,
            path: full
          };
        });
        console.log("Loaded", files.length, "files from uploadId");
        // keep uploadId variable consistent
        uploadId = uploadIdFromClient;
      } else {
        console.warn("Requested uploadId not found:", uploadIdFromClient);
        // leave files empty so we return the existing 400 later
      }
    } else {
      // use files from the current upload (after possible moved-to-folder)
      files = allFiles;
    }

    console.log("Effective files count for processing:", files.length, "uploadId:", uploadId || "(none)");

    const { question } = req.body;
    if (!files.length) {
      finished = true;
      return res.status(400).json({ error: "No PDFs uploaded (field name must be 'pdf') or uploadId missing/invalid" });
    }
    if (!question) {
      finished = true;
      return res.status(400).json({ error: "No question provided" });
    }

    // process each file as before — use file.path which points to saved file on disk
    const perDocTopPages = [];
    const docContexts = [];

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      console.log(`--- Processing file ${fi + 1}/${files.length}: ${file.originalname} (path:${file.path}) ---`);

      let result;
      try {
        // robust parse (read buffer from disk)
        try {
          const parser = new PDFParse({ buffer: fs.readFileSync(file.path) });
          result = await parser.getText();
          if (parser?.destroy) await parser.destroy();
          console.log(`Parsed ${file.originalname} (from disk) with PDFParse({ buffer })`);
        } catch (e1) {
          console.warn(`PDFParse({ buffer }) failed for ${file.originalname}:`, e1 && e1.message ? e1.message : e1);
          try {
            const uint8 = new Uint8Array(fs.readFileSync(file.path));
            const parser2 = new PDFParse({ data: uint8 });
            result = await parser2.getText();
            if (parser2?.destroy) await parser2.destroy();
            console.log(`Parsed ${file.originalname} (from disk) with PDFParse({ data: Uint8Array })`);
          } catch (e2) {
            console.warn(`PDFParse({ data: Uint8Array }) failed for ${file.originalname}:`, e2 && e2.message ? e2.message : e2);
            const pdfParseV1 = (await import("pdf-parse")).default || (await import("pdf-parse"));
            result = await pdfParseV1(fs.readFileSync(file.path));
            console.log(`Parsed ${file.originalname} (from disk) with pdf-parse v1 fallback`);
          }
        }

        const pdfText = result?.text || "";
        console.log(`${file.originalname} PDF text length:`, pdfText.length);

        // vector search for this file
        const buffer = fs.readFileSync(file.path);
        const { topPages, contextForLlama } = await vectorSearchForPdfBuffer(buffer, question, { topK: 5 });

        const taggedContext = contextForLlama.replace(/--- Page (\d+) \(score=([0-9.]+)\) ---/g, (m, pnum, score) => {
          return `--- Document: ${file.originalname} — Page ${pnum} (score=${parseFloat(score).toFixed(4)}) ---`;
        });

        perDocTopPages.push({ filename: file.originalname, topPages, contextForLlama: taggedContext });
        docContexts.push(taggedContext);
      } catch (fileErr) {
        console.error(`Error processing file ${file.originalname}:`, fileErr);
        finished = true;
        return res.status(500).json({ error: `Error parsing/indexing file ${file.originalname}`, details: String(fileErr) });
      }
    }

    // combined prompt and LLM call (unchanged)
    const instruction = `You are an AI assistant. Use ONLY the information in the provided document page contexts.
Answer the user's question and for each fact or claim cite the document and page number in parentheses, e.g. "(Doc: invoice.pdf — Page 3)". 
If the answer cannot be found in the provided pages, reply exactly: "Not found in the document."`;
    const combinedContext = `${instruction}\n\n${docContexts.join("\n\n")}`;

    console.log("Calling Llama with combined context...");
    try {
      answer = await askWithLlama(combinedContext, question);
    } catch (hfErr) {
      console.error("Hugging Face / Llama error:", hfErr);
      finished = true;
      return res.status(500).json({ error: "LLM inference failed", details: String(hfErr) });
    }

    const sources = perDocTopPages.map(d => ({
      filename: d.filename,
      pages: d.topPages.map(p => ({ page: p.pageNumber, score: p.score })),
    }));

    finished = true;
    console.log("Total request time (ms):", Date.now() - start);
    // return uploadId so client can reference for follow-ups
    return res.json({ answer, sources, uploadId: uploadId || null });
  } catch (err) {
    finished = true;
    console.error("Route error:", err);
    return res.status(500).json({ error: "Error processing request", details: String(err) });
  }
});
// create server object so we can tweak timeouts
const server = app.listen(5000, () => {
  console.log("Server running at http://localhost:5000");
});

// increase timeouts to allow slow LLM responses
// 10 minutes server timeout (adjust as needed). 0 disables timeout but not recommended for production.
server.setTimeout(10 * 60 * 1000); // 10 minutes
// Optional: extend headers timeout if needed (Node sometimes requires headersTimeout > setTimeout)
server.headersTimeout = 11 * 60 * 1000; // 11 minutes

// graceful logging of client errors
server.on("clientError", (err, socket) => {
  console.warn("clientError event:", err && err.message);
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch (e) {
    // ignore
  }
});
