// test_vector_ask_multi.js
// Usage: node test_vector_ask_multi.js
// Edit the filenames array below to point to your PDFs.

import fs from "fs";
import FormData from "form-data";
import axios from "axios";
import path from "path";

async function main() {
  // put the full paths to the PDFs you want to test
  const filenames = [
    "C:/Users/dabbi/Downloads/test.pdf",
    "C:/Users/dabbi/Downloads/tst.pdf"
  ];

  for (const f of filenames) {
    if (!fs.existsSync(f)) {
      console.error("File not found:", f);
      return process.exit(1);
    }
  }

  const form = new FormData();
  // append multiple files with the same field name 'pdf'
  for (const f of filenames) {
    form.append("pdf", fs.createReadStream(f), { filename: path.basename(f) });
  }
  form.append("question", "give me a summary");

  const getLength = () =>
    new Promise((resolve, reject) => {
      form.getLength((err, length) => {
        if (err) reject(err);
        else resolve(length);
      });
    });

  try {
    const length = await getLength();
    const headers = {
      ...form.getHeaders(),
      "Content-Length": length
    };

    console.log("Uploading files:", filenames);
    const res = await axios.post("http://localhost:5000/ask", form, {
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 10 * 60 * 1000,
      validateStatus: () => true,
    });

    console.log("Status:", res.status);
    console.log("Response:", JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("Upload failed:", err && err.message ? err.message : err);
    if (err.response) console.error("server:", err.response.status, err.response.data);
  }
}

main();
