import express from "express";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import { askWithLlama } from "./llama.js"; 
import { vectorSearchForPdfBuffer } from "./vectorStore.js";


const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

// improved route with robust logging and abort detection
app.post("/ask", upload.single("pdf"), async (req, res) => {
  const start = Date.now();
  let finished = false;

  // detect client aborts
  req.on("close", () => {
    if (!finished) {
      console.warn("Client closed connection before response finished (aborted).");
    }
  });

  try {
    console.log("--- /ask called ---");
    console.log("Headers:", req.headers["content-type"]);
    console.log("Body keys:", Object.keys(req.body || {}));

    // log file presence
    console.log("file present?", !!req.file);
    if (req.file) {
      console.log("file.originalname:", req.file.originalname);
      console.log("file.mimetype:", req.file.mimetype);
      console.log("file.size:", req.file.size);
    }

    const { question } = req.body;

    if (!req.file) {
      finished = true;
      return res.status(400).json({ error: "No PDF uploaded (field name must be 'pdf')" });
    }
    if (!question) {
      finished = true;
      return res.status(400).json({ error: "No question provided" });
    }

    // extract text (timing)
    // --- replace the "extract text" block with this robust version ---
console.log("Starting PDF parse...");
console.log("req.file.buffer type:", typeof req.file.buffer, "isBuffer:", Buffer.isBuffer(req.file.buffer));
console.log("req.file.buffer length:", req.file.buffer?.length || 0);

let result;
let parser;
try {
  // 1) Try passing `buffer` directly (what many versions accept)
  try {
    parser = new PDFParse({ buffer: req.file.buffer });
    result = await parser.getText();
    if (parser?.destroy) await parser.destroy();
    console.log("Parsed with PDFParse({ buffer })");
  } catch (e1) {
    console.warn("PDFParse({ buffer }) failed:", e1 && e1.message ? e1.message : e1);

    // 2) Try passing a Uint8Array as `data` (pdfjs likes Uint8Array)
    try {
      const uint8 = new Uint8Array(req.file.buffer);
      parser = new PDFParse({ data: uint8 });
      result = await parser.getText();
      if (parser?.destroy) await parser.destroy();
      console.log("Parsed with PDFParse({ data: Uint8Array })");
    } catch (e2) {
      console.warn("PDFParse({ data: Uint8Array }) failed:", e2 && e2.message ? e2.message : e2);

      // 3) Fallback: use pdf-parse v1 style function if installed
      //    Requires installing pdf-parse@1: `npm i pdf-parse@1`
      try {
        const pdfParseV1 = (await import("pdf-parse")).default || (await import("pdf-parse"));
        result = await pdfParseV1(req.file.buffer);
        console.log("Parsed with pdf-parse v1 function fallback");
      } catch (e3) {
        console.error("All pdf-parse attempts failed:", e3);
        throw e3; // rethrow so outer catch will send an error response
      }
    }
  }

  // result should have .text in all cases
  const pdfText = result?.text || "";
  console.log("PDF text length:", pdfText.length);
  // ... continue with Llama call using pdfText ...

  //----------------------------------------------------
const { topPages, contextForLlama } = await vectorSearchForPdfBuffer(req.file.buffer, question, { topK: 5 });
answer = await askWithLlama(contextForLlama, question);




  //----------------------------------------------------

} catch (parseErr) {
  console.error("PDF parse error (final):", parseErr);
  throw parseErr; // outer route will catch and return error JSON
}


    // optionally trim context if extremely large
    let pdfText = result.text || "";
    if (pdfText.length > 200_000) {
      console.warn("PDF text is large; truncating to 200k chars to avoid huge prompt.");
      pdfText = pdfText.slice(0, 200_000);
    }

    // call Llama (wrap in try/catch to log any HF-related error quickly)
    console.log("Calling Llama...");
    const llamaStart = Date.now();
    let answer;
    try {
      answer = await askWithLlama(pdfText, question);
    } catch (hfErr) {
      console.error("Hugging Face / Llama error:", hfErr);
      finished = true;
      // send explicit error so client doesn't hang
      return res.status(500).json({ error: "LLM inference failed", details: String(hfErr) });
    }
    console.log("Llama done (ms):", Date.now() - llamaStart);

    finished = true;
    console.log("Total request time (ms):", Date.now() - start);
    return res.json({ answer });
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
