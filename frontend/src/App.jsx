// src/App.jsx
import React, { useState, useRef } from "react";
import "./chat.css";

export default function App() {
  const [messages, setMessages] = useState([
    { id: 1, role: "system", text: "You can upload PDFs and ask questions. Answers will cite pages." },
  ]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]);
  const [uploadId, setUploadId] = useState(null); // <-- added
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState([]);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);

  function appendMessage(msg) {
    setMessages((m) => [...m, { id: Date.now() + Math.random(), ...msg }]);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  function onFilesSelected(e) {
    // selecting files implies the user wants to upload new files -> clear previous uploadId
    if (uploadId) setUploadId(null);
    const list = Array.from(e.target.files || []);
    setFiles(list);
  }

  async function handleSend(e) {
    e?.preventDefault();
    setError(null);
    const question = input.trim();
    // If no question and no files and no uploadId -> error
    if (!question && files.length === 0 && !uploadId) {
      setError("Please type a question or attach PDFs.");
      return;
    }

    appendMessage({ role: "user", text: question || (files.length ? "(uploaded files)" : "(using previous upload)") });
    setInput("");

    const form = new FormData();

    // If we already have an uploadId from a prior upload, send it instead of files.
    if (uploadId) {
      form.append("uploadId", uploadId);
    } else {
      // first-time upload: attach files
      files.forEach((f) => form.append("pdf", f, f.name));
    }

    form.append("question", question || "Summarize the uploaded files.");

    setLoading(true);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);

      const res = await fetch("/ask", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Server error ${res.status}: ${body}`);
      }

      const data = await res.json();

      // save uploadId returned by server (if any) for follow-ups
      if (data.uploadId) {
        setUploadId(data.uploadId);
      }

      appendMessage({ role: "assistant", text: data.answer || "(no answer)" });
      setSources(Array.isArray(data.sources) ? data.sources : []);

      // Clear local file handles (we keep uploadId so follow-ups work)
      if (!uploadId) {
        // if this was the first upload, clear file inputs after server stored them
        setFiles([]);
        if (fileInputRef.current) fileInputRef.current.value = null;
      }
    } catch (err) {
      console.error(err);
      if (err.name === "AbortError") setError("Request timed out.");
      else setError(String(err.message || err));
      appendMessage({ role: "assistant", text: "Error: " + (err.message || String(err)) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen min-w-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl bg-white rounded-2xl shadow-lg overflow-hidden flex flex-col">
        {/* Header */}
        <header className="px-6 py-4 border-b flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-600 to-blue-500 flex items-center justify-center text-white font-semibold">
              AI
            </div>
            <div>
              <div className="text-lg font-semibold text-gray-900">Doc Chat</div>
              <div className="text-sm text-gray-500">Upload PDFs · Ask questions · Cited answers</div>
            </div>
          </div>

          <div>
            <button
              className="text-sm px-3 py-1 rounded-lg bg-gray-100 hover:bg-gray-200"
              onClick={() => {
                setMessages([{ id: 1, role: "system", text: "You can upload PDFs and ask questions. Answers will cite pages." }]);
                setSources([]);
                setUploadId(null);
                setFiles([]);
                if (fileInputRef.current) fileInputRef.current.value = null;
              }}
            >
              Reset
            </button>
          </div>
        </header>

        {/* Messages */}
        <main className="flex-1 overflow-auto p-6">
          <div className="flex flex-col space-y-4">
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={`max-w-[75%] px-4 py-3 rounded-lg break-words ${m.role === "user" ? "bg-indigo-600 text-white rounded-br-sm" : "bg-gray-100 text-gray-900 rounded-bl-sm"
                    }`}
                >
                  <div className="text-sm whitespace-pre-wrap">{m.text}</div>
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="max-w-[75%] px-4 py-3 rounded-lg bg-gray-100 text-gray-700 animate-pulse">Thinking...</div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </main>

        {/* Sources */}
        <section className="px-6 py-4 border-t bg-white">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-gray-800">Sources</div>
            <div className="text-sm text-gray-500">
              {sources.length} document(s)
              {uploadId ? <span className="text-xs text-gray-400 ml-2">· uploadId: <code className="bg-gray-100 px-2 py-0.5 rounded">{uploadId}</code></span> : null}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {sources.map((s, i) => (
              <div key={i} className="p-3 border rounded-lg bg-white">
                <div className="font-medium text-sm text-gray-800">{s.filename}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {s.pages.map((p, idx) => (
                    <span key={idx} className="text-xs bg-gray-100 px-2 py-1 rounded-full text-gray-600">Page {p.page}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Composer */}
        <form className="px-6 py-4 border-t bg-stone-50 text-black" onSubmit={handleSend}>
          <div className="flex flex-col sm:flex-row items-end gap-4">
            <div className="flex-1">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type your question here..."
                rows={2}
                className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />

              <div className="mt-3 flex items-center gap-3 flex-wrap">
                {/* Hidden input */}
                <input
                  ref={fileInputRef}
                  onChange={onFilesSelected}
                  type="file"
                  accept="application/pdf"
                  multiple
                  className="hidden"
                  id="fileUpload"
                />

                {/* Styled button triggers input */}
                <label
                  htmlFor="fileUpload"
                  className="cursor-pointer px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium 
               hover:bg-indigo-700 active:bg-indigo-800 transition"
                >
                  📄 Upload PDF
                </label>
                <div className="text-sm text-gray-500">{files.length} file(s) selected</div>

                <div className="flex gap-2 flex-wrap ml-auto sm:ml-0">
                  {files.map((f, idx) => (
                    <span key={idx} className="text-xs bg-gray-100 px-2 py-1 rounded">{f.name}</span>
                  ))}
                </div>
              </div>

              {uploadId && (
                <div className="mt-2 text-sm text-gray-500">
                  Using stored upload <span className="font-mono bg-gray-100 px-2 py-0.5 rounded">{uploadId}</span>. Select files to replace.
                </div>
              )}
            </div>

            <div className="flex-shrink-0">
              <button
                type="submit"
                disabled={loading}
                className="bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>

          {error && <div className="mt-3 text-sm text-red-600">{error}</div>}
        </form>
      </div>
    </div>
  );
  ;
}
