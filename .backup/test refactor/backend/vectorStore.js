// vectorStore.js
import { InferenceClient } from "@huggingface/inference";
import cosineSimilarity from "cosine-similarity";

const client = new InferenceClient(process.env.HF_TOKEN);

// In-memory vector store
export const vectorDB = [];   // { embedding, textChunk }

export async function embedText(text) {
  const res = await client.featureExtraction({
    model: "sentence-transformers/all-MiniLM-L6-v2",
    inputs: text
  });

  return res; // array of floats
}

// split long text into smaller chunks
export function chunkText(text, chunkSize = 500) {
  const words = text.split(/\s+/);
  const chunks = [];

  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
  }

  return chunks;
}

// insert text chunks into vector DB
export async function indexDocument(fullText) {
  const chunks = chunkText(fullText);
  vectorDB.length = 0; // clear previous

  for (const chunk of chunks) {
    const embedding = await embedText(chunk);
    vectorDB.push({ embedding, text: chunk });
  }

  return vectorDB.length;
}

// search
export async function searchRelevant(question, topK = 5) {
  const qEmbed = await embedText(question);

  const scored = vectorDB.map((item) => ({
    text: item.text,
    score: cosineSimilarity(qEmbed, item.embedding)
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
