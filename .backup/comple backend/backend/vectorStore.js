// vectorSearchNoStore.js
// Pure-Node vector search (no Python). Uses @huggingface/inference InferenceClient
// with provider "nebius" and model "Qwen/Qwen3-Embedding-8B" (works with read tokens).

import * as pdfParseModule from "pdf-parse";
import { InferenceClient } from "@huggingface/inference";

const client = new InferenceClient(process.env.HF_TOKEN);

// model + provider
const EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-8B";
const EMBEDDING_PROVIDER = "nebius";

/** normalize provider embedding response for single or batch inputs */
function normalizeProviderResponse(res, isArrayInput) {
  // Many providers return arrays directly; others return objects.
  // If provider returns plain array for batch: [ [..], [..] ]
  if (Array.isArray(res) && (Array.isArray(res[0]) && typeof res[0][0] === "number")) {
    return isArrayInput ? res : res[0];
  }

  // Some clients return {embedding: [...] } for single or [ { embedding: [...] }, ... ] for batch
  if (!isArrayInput && Array.isArray(res) && typeof res[0] === "object" && Array.isArray(res[0].embedding)) {
    return res[0].embedding;
  }
  if (isArrayInput && Array.isArray(res) && typeof res[0] === "object" && Array.isArray(res[0].embedding)) {
    return res.map(item => item.embedding);
  }

  // Some versions of the HF client return plain arrays for single inputs
  if (!isArrayInput && Array.isArray(res) && typeof res[0] === "number") return res;

  // if provider returns { result: [...] } or { data: [...] } shapes, try common keys
  if (res && typeof res === "object") {
    if (Array.isArray(res.data)) {
      // data: [ { embedding: [...] }, ... ]
      if (isArrayInput) return res.data.map(d => d.embedding || d);
      return res.data[0]?.embedding || res.data[0];
    }
    if (Array.isArray(res.result)) {
      if (isArrayInput) return res.result.map(d => d.embedding || d);
      return res.result[0]?.embedding || res.result[0];
    }
    if (Array.isArray(res.embedding)) {
      // single
      return isArrayInput ? [res.embedding] : res.embedding;
    }
  }

  throw new Error("Unexpected embedding provider response shape: " + JSON.stringify(res).slice(0, 400));
}

/** call provider embeddings via InferenceClient */
async function callProviderEmbeddings(inputs) {
  const isArray = Array.isArray(inputs);
  try {
    const res = await client.featureExtraction({
      model: EMBEDDING_MODEL,
      provider: EMBEDDING_PROVIDER,
      inputs: inputs,
    });
    return normalizeProviderResponse(res, isArray);
  } catch (e) {
    // surface error details
    throw new Error("Embedding provider call failed: " + String(e));
  }
}

/** cosine similarity */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * vectorSearchForPdfBuffer(buffer, question, opts)
 * - No DB. All in-memory. Per-request page-level embeddings.
 * - Uses the provider embeddings via InferenceClient (nebius).
 * - Returns: { topPages, contextForLlama }
 */
export async function vectorSearchForPdfBuffer(buffer, question, opts = {}) {
  const {
    topK = 5,
    chunkSizeWords = 300,
    maxPages = 400,
    excerptChars = 1500,
    batchSize = 8, // provider batching: smaller batches may be safer depending on provider limits
  } = opts;

  if (!buffer) throw new Error("No PDF buffer provided.");
  if (!question || typeof question !== "string") throw new Error("Question string required.");

  // ---------- Extract text robustly ----------
  let fullText = "";
  try {
    const maybeFunc = pdfParseModule.default || pdfParseModule;
    if (typeof maybeFunc === "function") {
      const parseRes = await maybeFunc(buffer);
      fullText = (parseRes && parseRes.text) ? parseRes.text : (typeof parseRes === "string" ? parseRes : "");
    } else {
      const PDFParseCtor = pdfParseModule.PDFParse || pdfParseModule.default?.PDFParse || pdfParseModule.PDFParser;
      if (typeof PDFParseCtor === "function") {
        let parsed = null;
        try {
          const parser = new PDFParseCtor({ buffer });
          parsed = await parser.getText();
          if (parser?.destroy) await parser.destroy();
        } catch (e1) {
          const uint8 = new Uint8Array(buffer);
          const parser2 = new PDFParseCtor({ data: uint8 });
          parsed = await parser2.getText();
          if (parser2?.destroy) await parser2.destroy();
        }
        fullText = (parsed && parsed.text) ? parsed.text : (typeof parsed === "string" ? parsed : "");
      } else {
        throw new Error("pdf-parse: no usable export found.");
      }
    }
  } catch (err) {
    throw new Error("PDF text extraction failed: " + String(err));
  }

  // ---------- Split into pages ----------
  let pages = [];
  if (fullText.includes("\f")) {
    pages = fullText.split("\f").map(p => p.trim()).filter(Boolean);
  } else {
    const words = fullText.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += chunkSizeWords) {
      pages.push(words.slice(i, i + chunkSizeWords).join(" "));
      if (pages.length >= maxPages) break;
    }
  }
  if (!pages.length) pages = [fullText || ""];

  if (pages.length > maxPages) pages = pages.slice(0, maxPages);

  // ---------- Embed pages in batches using provider ----------
  const pageEmbeddings = new Array(pages.length);
  try {
    for (let i = 0; i < pages.length; i += batchSize) {
      const batch = pages.slice(i, i + batchSize);
      const batchEmb = await callProviderEmbeddings(batch);
      if (!Array.isArray(batchEmb) || batchEmb.length !== batch.length) {
        throw new Error("Provider returned unexpected batch embedding size");
      }
      for (let k = 0; k < batchEmb.length; k++) {
        pageEmbeddings[i + k] = batchEmb[k];
      }
    }
  } catch (e) {
    throw new Error("Embedding pages failed: " + String(e));
  }

  // ---------- Embed question ----------
  let qEmb;
  try {
    qEmb = await callProviderEmbeddings(question); // single -> array
  } catch (e) {
    throw new Error("Embedding question failed: " + String(e));
  }

  // ---------- Score ----------
  const scored = pages.map((text, idx) => {
    const emb = pageEmbeddings[idx];
    const score = Array.isArray(emb) && Array.isArray(qEmb) && emb.length === qEmb.length ? cosineSimilarity(qEmb, emb) : 0;
    return { pageNumber: idx + 1, text, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const topPages = scored.slice(0, Math.min(topK, scored.length));

  // ---------- Build context for Llama ----------
  const contextParts = topPages.map(p => {
    const excerpt = (p.text || "").trim().slice(0, excerptChars);
    return `--- Page ${p.pageNumber} (score=${p.score.toFixed(4)}) ---\n${excerpt}\n`;
  });

  const instruction =
    `You are an AI assistant. Synthesize a concise one-paragraph summary of the documents using ONLY the information in the provided page contexts.\n` +
    `Answer the user's question and for each fact or claim cite the page number in parentheses, e.g. "(Page 3)" or "(Doc: tst.pdf — Page 3)".\n` +
    `If the answer cannot be found in the provided pages, reply exactly: "Not found in the document."`;

  const contextForLlama = `${instruction}\n\n${contextParts.join("\n")}`;

  return { topPages, contextForLlama };
}
