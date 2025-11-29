// vectorSearchNoStore.js
import { InferenceClient } from "@huggingface/inference";
import pdfParseModule from "pdf-parse";

/**
 * vectorSearchForPdfBuffer(buffer, question, opts)
 * - No DB. All in-memory, per-request.
 * - Embeds per-PAGE when possible (pdf-parse usually separates pages with \f).
 *
 * Returns:
 *   { topPages: [{ pageNumber, text, score }], contextForLlama: string }
 */
export async function vectorSearchForPdfBuffer(buffer, question, opts = {}) {
  const {
    topK = 5,
    model = "sentence-transformers/all-MiniLM-L6-v2",
    chunkSizeWords = 300,
    maxPages = 400,
  } = opts;

  const HF_TOKEN = process.env.HF_TOKEN;
  if (!HF_TOKEN) throw new Error("HF_TOKEN missing in environment for embeddings.");
  const hfClient = new InferenceClient({ apiKey: HF_TOKEN });

  // 1) extract text
  let fullText = "";
  try {
    const pdfParse = pdfParseModule.default || pdfParseModule;
    const parseRes = await pdfParse(buffer);
    fullText = (parseRes && parseRes.text) ? parseRes.text : (typeof parseRes === "string" ? parseRes : "");
  } catch (e) {
    throw new Error("PDF text extraction failed: " + String(e));
  }

  // 2) split into pages (prefer form-feed)
  let pages = [];
  if (fullText.includes("\f")) {
    pages = fullText.split("\f").map(p => p.trim()).filter(Boolean);
  } else {
    const words = fullText.split(/\s+/).filter(Boolean);
    for (let i = 0, p = 1; i < words.length; i += chunkSizeWords, p++) {
      pages.push(words.slice(i, i + chunkSizeWords).join(" "));
      if (pages.length >= maxPages) break;
    }
  }
  if (!pages.length) pages = [fullText || ""];

  if (pages.length > maxPages) pages = pages.slice(0, maxPages);

  // 3) embed pages sequentially (normalize shapes)
  const pageEmbeddings = [];
  for (let i = 0; i < pages.length; i++) {
    const ptext = pages[i] || "";
    const embRes = await hfClient.featureExtraction({ model, inputs: ptext });
    let emb;
    if (Array.isArray(embRes) && Array.isArray(embRes[0]) && typeof embRes[0][0] === "number") emb = embRes[0];
    else if (Array.isArray(embRes) && typeof embRes[0] === "number") emb = embRes;
    else throw new Error("Unexpected embedding shape for page " + (i + 1));
    pageEmbeddings.push(emb);
  }

  // 4) embed question
  const qRes = await hfClient.featureExtraction({ model, inputs: question });
  let qEmb;
  if (Array.isArray(qRes) && Array.isArray(qRes[0]) && typeof qRes[0][0] === "number") qEmb = qRes[0];
  else if (Array.isArray(qRes) && typeof qRes[0] === "number") qEmb = qRes;
  else throw new Error("Unexpected embedding shape for question");

  // 5) cosine similarity
  function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  const scored = pages.map((text, idx) => ({
    pageNumber: idx + 1,
    text,
    score: cosineSimilarity(qEmb, pageEmbeddings[idx]),
  }));

  scored.sort((a, b) => b.score - a.score);
  const topPages = scored.slice(0, Math.min(topK, scored.length));

  // 6) build context for Llama with page labels and instruction to cite pages
  const contextParts = topPages.map(p => {
    const excerpt = (p.text || "").trim().slice(0, 1500);
    return `--- Page ${p.pageNumber} (score=${p.score.toFixed(4)}) ---\n${excerpt}\n`;
  });

  const instruction =
    `You are an AI assistant. Use ONLY the information in the provided page contexts.\n` +
    `Answer the user's question and for each fact or claim cite the page number in parentheses, e.g. "(Page 3)".\n` +
    `If the answer cannot be found in the provided pages, reply exactly: "Not found in the document."`;

  const contextForLlama = `${instruction}\n\n${contextParts.join("\n")}`;
  return { topPages, contextForLlama };
}
