import { InferenceClient } from "@huggingface/inference";
const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) throw new Error("Set HF_TOKEN in env first.");
let client;
try { client = new InferenceClient({ apiKey: HF_TOKEN }); } catch (e) { client = new InferenceClient(HF_TOKEN); }

(async () => {
  const r = await client.featureExtraction({ model: "sentence-transformers/all-MiniLM-L6-v2", inputs: "hello world" });
  console.log("embedding shape:", Array.isArray(r) ? (Array.isArray(r[0]) ? r[0].length : r.length) : typeof r);
})();
