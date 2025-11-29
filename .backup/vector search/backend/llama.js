import { InferenceClient } from "@huggingface/inference";

const client = new InferenceClient(process.env.HF_TOKEN);

export async function askWithLlama(pdfText, question) {
  const prompt = `
  You are an AI assistant. Answer ONLY using the information in the context.
  If the answer is not found in the document, say: "Not found in the document."

  Context:
  ${pdfText}

  Question:
  ${question}
  `;

  const response = await client.chatCompletion({
    model: "meta-llama/Llama-3.1-8B-Instruct",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 300,
  });

  return response.choices[0].message.content;
}
