import express from "express";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import { askWithLlama } from "./llama.js"; 
import { vectorSearchForPdfBuffer } from "./vectorStore.js";


const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

// improved route with robust logging and abort detection
// improved route with robust logging and abort detection (multi-PDF support)
app.post("/ask", upload.array("pdf"), async (req, res) => {
  const start = Date.now();
  let finished = false;
  let answer = null; // single declaration for this route

  // detect client aborts
  req.on("close", () => {
    if (!finished) {
      console.warn("Client closed connection before response finished (aborted).");
    }
  });

  try {
    console.log("--- /ask called (multi-pdf) ---");
    console.log("Headers:", req.headers["content-type"]);
    console.log("Body keys:", Object.keys(req.body || {}));

    // files is an array now
    const files = req.files || [];
    console.log("files count:", files.length);
    if (files.length) {
      files.forEach(f => {
        console.log("file:", f.originalname, f.mimetype, f.size);
      });
    }

    const { question } = req.body;

    if (!files.length) {
      finished = true;
      return res.status(400).json({ error: "No PDFs uploaded (field name must be 'pdf')" });
    }
    if (!question) {
      finished = true;
      return res.status(400).json({ error: "No question provided" });
    }

    // We'll collect per-document top-pages and contexts, then combine
    const perDocTopPages = []; // { filename, topPages: [{pageNumber,text,score}], contextForLlama }
    const docContexts = [];

    // Process each uploaded file sequentially (so logs and errors are easy)
    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      console.log(`--- Processing file ${fi + 1}/${files.length}: ${file.originalname} ---`);
      // attempt parsing similar to your robust parse earlier
      let result;
      try {
        // Try PDFParse class (you already use it)
        try {
          const parser = new PDFParse({ buffer: file.buffer });
          result = await parser.getText();
          if (parser?.destroy) await parser.destroy();
          console.log(`Parsed ${file.originalname} with PDFParse({ buffer })`);
        } catch (e1) {
          console.warn(`PDFParse({ buffer }) failed for ${file.originalname}:`, e1 && e1.message ? e1.message : e1);
          try {
            const uint8 = new Uint8Array(file.buffer);
            const parser2 = new PDFParse({ data: uint8 });
            result = await parser2.getText();
            if (parser2?.destroy) await parser2.destroy();
            console.log(`Parsed ${file.originalname} with PDFParse({ data: Uint8Array })`);
          } catch (e2) {
            console.warn(`PDFParse({ data: Uint8Array }) failed for ${file.originalname}:`, e2 && e2.message ? e2.message : e2);
            // fallback to pdf-parse v1 function if available
            try {
              const pdfParseV1 = (await import("pdf-parse")).default || (await import("pdf-parse"));
              result = await pdfParseV1(file.buffer);
              console.log(`Parsed ${file.originalname} with pdf-parse v1 fallback`);
            } catch (e3) {
              console.error(`All pdf-parse attempts failed for ${file.originalname}:`, e3);
              throw e3;
            }
          }
        }

        const pdfText = result?.text || "";
        console.log(`${file.originalname} PDF text length:`, pdfText.length);

        // Run vector search per-file (no persistent store) - returns topPages + contextForLlama per file
        const { topPages, contextForLlama } = await vectorSearchForPdfBuffer(file.buffer, question, { topK: 5 });

        // we want to tag contexts with the filename so LLM can cite doc + page
        // modify page headers to include document name when combining
        const taggedContext = contextForLlama.replace(/--- Page (\d+) \(score=([0-9.]+)\) ---/g, (m, pnum, score) => {
          return `--- Document: ${file.originalname} — Page ${pnum} (score=${parseFloat(score).toFixed(4)}) ---`;
        });

        perDocTopPages.push({ filename: file.originalname, topPages, contextForLlama: taggedContext });
        docContexts.push(taggedContext);

      } catch (fileErr) {
        // Log and return a helpful error; you could also skip this file and continue if you prefer
        console.error(`Error processing file ${file.originalname}:`, fileErr);
        finished = true;
        return res.status(500).json({ error: `Error parsing/indexing file ${file.originalname}`, details: String(fileErr) });
      }
    } // end for each file

    // Combine all doc contexts into one LLM prompt
    const instruction = `You are an AI assistant. Use ONLY the information in the provided document page contexts.
Answer the user's question and for each fact or claim cite the document and page number in parentheses, e.g. "(Doc: invoice.pdf — Page 3)". 
If the answer cannot be found in the provided pages, reply exactly: "Not found in the document."`;

    const combinedContext = `${instruction}\n\n${docContexts.join("\n\n")}`;

    // Call Llama with combined context
    console.log("Calling Llama with combined context...");
    try {
      answer = await askWithLlama(combinedContext, question);
    } catch (hfErr) {
      console.error("Hugging Face / Llama error:", hfErr);
      finished = true;
      return res.status(500).json({ error: "LLM inference failed", details: String(hfErr) });
    }

    // Format sources (document => pages used)
    const sources = perDocTopPages.map(d => ({
      filename: d.filename,
      pages: d.topPages.map(p => ({ page: p.pageNumber, score: p.score })),
    }));

    finished = true;
    console.log("Total request time (ms):", Date.now() - start);
    return res.json({ answer, sources });
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
