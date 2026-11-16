import { useEffect, useState } from "react";

function formatDuration(milliseconds) {
  if (milliseconds >= 1000) {
    return `${(milliseconds / 1000).toFixed(2)} s`;
  }

  return `${milliseconds} ms`;
}

export default function IndexingPanel({
  serverOnline,
  documents,
  isIndexing,
  message,
  error,
  history,
  onBuild,
}) {
  const [threads, setThreads] = useState("8");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!isIndexing) {
      setElapsedSeconds(0);
      return undefined;
    }

    const startedAt = Date.now();
    const timerId = window.setInterval(() => {
      setElapsedSeconds((Date.now() - startedAt) / 1000);
    }, 200);

    return () => window.clearInterval(timerId);
  }, [isIndexing]);

  function handleSubmit(event) {
    event.preventDefault();
    const value = Number.parseInt(threads, 10);
    if (Number.isInteger(value) && value >= 1 && value <= 128) {
      onBuild(value);
    }
  }

  return (
    <section className="workflow-section indexing-section" aria-labelledby="index-heading">
      <div className="section-kicker">
        <span className="step-number">01</span>
        <span>Prepare your catalog</span>
      </div>

      <div className="section-heading-row">
        <div>
          <h2 id="index-heading">Build the product index</h2>
          <p className="section-description">
            Organize your grocery catalog so products are ready to search.
          </p>
        </div>
        <div className={`index-state ${documents > 0 ? "is-ready" : ""}`}>
          <span className="index-state-icon" aria-hidden="true">
            {documents > 0 ? "✓" : "＋"}
          </span>
          <span>{documents > 0 ? `${documents.toLocaleString()} products` : "Not indexed yet"}</span>
        </div>
      </div>

      <form className="index-controls" onSubmit={handleSubmit}>
        <label className="field-group thread-field" htmlFor="worker-count">
          <span>Worker threads</span>
          <input
            id="worker-count"
            type="number"
            min="1"
            max="128"
            value={threads}
            onChange={(event) => setThreads(event.target.value)}
            disabled={isIndexing}
          />
        </label>
        <button
          className="button button-secondary"
          type="submit"
          disabled={!serverOnline || isIndexing}
        >
          {isIndexing ? "Building index…" : documents > 0 ? "Refresh index" : "Build index"}
          <span aria-hidden="true">↗</span>
        </button>
      </form>

      {!serverOnline && (
        <p className="inline-note note-warning" role="status">
          The search server is offline. Start it before building the index.
        </p>
      )}

      {isIndexing && (
        <div className="progress-card" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <div className="progress-copy">
            <strong>Indexing your catalog</strong>
            <span>{threads} workers · {elapsedSeconds.toFixed(1)} seconds elapsed</span>
          </div>
          <div className="progress-track" aria-hidden="true">
            <span />
          </div>
        </div>
      )}

      {message && !isIndexing && (
        <p className="inline-note note-success" role="status">{message}</p>
      )}
      {error && <p className="inline-note note-error" role="alert">{error}</p>}

      {history.length > 0 && (
        <div className="build-history">
          <h3>Recent builds</h3>
          <div className="history-list">
            {history.slice(0, 3).map((entry, index) => (
              <div className="history-row" key={entry.id}>
                <span className="history-index">{String(index + 1).padStart(2, "0")}</span>
                <span>{entry.documents.toLocaleString()} products</span>
                <span>{entry.threads} workers</span>
                <strong>{formatDuration(entry.timeMs)}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
