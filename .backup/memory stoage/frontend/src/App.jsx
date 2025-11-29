// src/App.jsx
import React, { useState, useRef } from "react";
import "./chat.css";

export default function App() {
  const [messages, setMessages] = useState([
    { id: 1, role: "system", text: "You can upload PDFs and ask questions. Answers will cite pages." },
  ]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]);
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
    const list = Array.from(e.target.files || []);
    setFiles(list);
  }

  async function handleSend(e) {
    e?.preventDefault();
    setError(null);
    const question = input.trim();
    if (!question && files.length === 0) {
      setError("Please type a question or attach PDFs.");
      return;
    }

    appendMessage({ role: "user", text: question || (files.length ? "(uploaded files)" : "") });
    setInput("");

    const form = new FormData();
    files.forEach((f) => form.append("pdf", f, f.name));
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

      appendMessage({ role: "assistant", text: data.answer || "(no answer)" });
      setSources(Array.isArray(data.sources) ? data.sources : []);
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = null;
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
    <div className="chat-root">
      <div className="chat-card">
        <header className="chat-header">
          <div className="brand">
            <div className="logo">AI</div>
            <div className="brand-text">
              <div className="title">Doc Chat</div>
              <div className="subtitle">Upload PDFs · Ask questions · Cited answers</div>
            </div>
          </div>
          <div>
            <button
              className="btn-muted"
              onClick={() => {
                setMessages([{ id: 1, role: "system", text: "You can upload PDFs and ask questions. Answers will cite pages." }]);
                setSources([]);
              }}
            >
              Reset
            </button>
          </div>
        </header>

        <main className="chat-body">
          <div className="messages">
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "msg-row user" : "msg-row assistant"}>
                <div className={m.role === "user" ? "msg user-msg" : "msg assistant-msg"}>
                  <div className="msg-text">{m.text}</div>
                </div>
              </div>
            ))}

            {loading && (
              <div className="msg-row assistant">
                <div className="msg assistant-msg loading">Thinking...</div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </main>

        <section className="sources">
          <div className="sources-header">
            <div className="sources-title">Sources</div>
            <div className="sources-count">{sources.length} document(s)</div>
          </div>

          <div className="sources-list">
            {sources.map((s, i) => (
              <div key={i} className="source-card">
                <div className="source-name">{s.filename}</div>
                <div className="source-pages">
                  {s.pages.map((p, idx) => (
                    <div key={idx} className="page-pill">Page {p.page}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <form className="composer" onSubmit={handleSend}>
          <div className="composer-left">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your question here..."
              rows={2}
              className="composer-textarea"
            />
            <div className="composer-controls">
              <input ref={fileInputRef} onChange={onFilesSelected} type="file" accept="application/pdf" multiple className="file-input" />
              <div className="file-count">{files.length} file(s) selected</div>
              <div className="file-list">
                {files.map((f, idx) => (
                  <span key={idx} className="file-name">{f.name}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="composer-right">
            <button type="submit" className="btn-primary" disabled={loading}>Send</button>
          </div>
          {error && <div className="error-line">{error}</div>}
        </form>
      </div>
    </div>
  );
}
