import { useEffect, useState } from "react";

export default function DocumentModal({ item, onClose }) {
  const [copyMessage, setCopyMessage] = useState("");

  useEffect(() => {
    if (!item) {
      return undefined;
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [item, onClose]);

  if (!item) {
    return null;
  }

  const raw = item.raw || {
    doc_id: item.doc_id,
    title: item.snippet,
    score: item.score,
  };
  const formattedJson = JSON.stringify(raw, null, 2);

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(formattedJson);
      setCopyMessage("Copied");
    } catch {
      setCopyMessage("Clipboard unavailable");
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="document-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="document-heading"
      >
        <div className="modal-header">
          <div>
            <p className="section-kicker">Product record</p>
            <h2 id="document-heading">Product details</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close details"
          >
            ×
          </button>
        </div>
        <div className="modal-toolbar">
          <span className="product-id">ID {item.doc_id}</span>
          <div className="copy-actions">
            {copyMessage && <span role="status">{copyMessage}</span>}
            <button
              className="button button-quiet"
              type="button"
              onClick={copyJson}
            >
              Copy JSON
            </button>
          </div>
        </div>
        <pre className="json-view">
          <code>{formattedJson}</code>
        </pre>
      </section>
    </div>
  );
}
