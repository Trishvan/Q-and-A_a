// quick_test_llama.js
import { askWithLlama } from "./llama.js";

(async () => {
  try {
    const out = await askWithLlama("This is a tiny context about Paris. Paris is the capital of France.", "What is the capital of France?");
    console.log("LLM answer:", out);
  } catch (e) {
    console.error("LLM failed:", e);
  }
})();
