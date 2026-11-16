import { useCallback, useEffect, useRef, useState } from "react";

const configuredApiUrl =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";
const API_BASE_URL = configuredApiUrl.replace(/\/+$/, "");

const apiAddress = new URL(API_BASE_URL);
const socketProtocol = apiAddress.protocol === "https:" ? "wss:" : "ws:";
const SEARCH_SOCKET_URL =
  import.meta.env.VITE_SEARCH_WS_URL ||
  `${socketProtocol}//${apiAddress.host}/ws/search`;

async function readJson(response) {
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
  return response.json();
}

async function getHealth() {
  return readJson(
    await fetch(`${API_BASE_URL}/api/health`, { cache: "no-store" }),
  );
}

async function getStats() {
  return readJson(
    await fetch(`${API_BASE_URL}/api/stats`, { cache: "no-store" }),
  );
}

async function buildIndex(threads) {
  const response = await fetch(`${API_BASE_URL}/api/index`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threads }),
  });
  return readJson(response);
}

const initialStatus = {
  server: "checking",
  ollama: "checking",
  index: "checking",
  documents: 0,
  buildTimeMs: 0,
};

function useSystemStatus() {
  const [status, setStatus] = useState(initialStatus);

  const refresh = useCallback(async () => {
    try {
      const health = await getHealth();
      setStatus((current) => ({
        ...current,
        server: health.status === "ok" ? "online" : "offline",
        ollama: health.ollama ? "online" : "offline",
      }));
    } catch {
      setStatus((current) => ({
        ...current,
        server: "offline",
        ollama: "unknown",
      }));
    }

    try {
      const stats = await getStats();
      const documents = Number(stats.documents) || 0;
      setStatus((current) => ({
        ...current,
        index: documents > 0 ? "ready" : "empty",
        documents,
        buildTimeMs: Number(stats.index_build_time_ms) || 0,
      }));
    } catch {
      setStatus((current) => ({
        ...current,
        index: "unknown",
      }));
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timerId;

    const poll = async () => {
      await refresh();
      if (active) {
        timerId = window.setTimeout(poll, 5000);
      }
    };

    poll();

    return () => {
      active = false;
      window.clearTimeout(timerId);
    };
  }, [refresh]);

  return { ...status, refresh };
}

function StatusPill({ label, status }) {
  return (
    <div className={`status-pill status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      <span>
        {label}: {status}
      </span>
    </div>
  );
}

function IndexingPanel({
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
    <section className="workflow-section indexing-section">
      <div className="section-kicker">
        <span className="step-number">01</span>
        <span>Prepare your catalog</span>
      </div>

      <div className="section-heading-row">
        <div>
          <h2>Build the product index</h2>
          <p className="section-description">
            Organize your grocery catalog so products are ready to search.
          </p>
        </div>
        <div className={`index-state ${documents > 0 ? "is-ready" : ""}`}>
          <span className="index-state-icon" aria-hidden="true">
            {documents > 0 ? "✓" : "＋"}
          </span>
          <span>
            {documents > 0
              ? `${documents.toLocaleString()} products`
              : "Not indexed yet"}
          </span>
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
          {isIndexing
            ? "Building index…"
            : documents > 0
              ? "Refresh index"
              : "Build index"}
          <span aria-hidden="true">↗</span>
        </button>
      </form>

      {!serverOnline && (
        <p className="inline-note note-warning">
          The search server is offline. Start it before building the index.
        </p>
      )}

      {isIndexing && (
        <div className="progress-card">
          <span className="spinner" aria-hidden="true" />
          <div className="progress-copy">
            <strong>Indexing your catalog</strong>
            <span>
              {threads} workers · {elapsedSeconds.toFixed(1)} seconds elapsed
            </span>
          </div>
          <div className="progress-track" aria-hidden="true">
            <span />
          </div>
        </div>
      )}

      {message && !isIndexing && (
        <p className="inline-note note-success">{message}</p>
      )}
      {error && <p className="inline-note note-error">{error}</p>}

      {history.length > 0 && (
        <div className="build-history">
          <h3>Recent builds</h3>
          <div className="history-list">
            {history.slice(0, 3).map((entry, index) => (
              <div className="history-row" key={entry.id}>
                <span className="history-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>{entry.documents.toLocaleString()} products</span>
                <span>{entry.threads} workers</span>
                <strong>{entry.timeMs} ms</strong>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ExpandedKeywords({ terms }) {
  return (
    <section className="expanded-card">
      <div className="expanded-icon" aria-hidden="true">
        ✳
      </div>
      <div className="expanded-content">
        <div className="expanded-heading-row">
          <h3>Expanded search keywords</h3>
          <span className="ai-label">OLLAMA</span>
        </div>
        <p className="expanded-caption">
          Related terms generated to broaden your grocery search.
        </p>
        {terms.length > 0 ? (
          <ul className="keyword-list">
            {terms.map((term, index) => (
              <li key={`${term}-${index}`}>{term}</li>
            ))}
          </ul>
        ) : (
          <p className="expanded-empty">
            No extra keywords were generated; results use your original search.
          </p>
        )}
      </div>
    </section>
  );
}

function ProductResult({ item, onView }) {
  const raw = item.raw || {};
  const title = raw.title || item.snippet || "Untitled product";
  const productId = raw.parent_asin || raw.asin || item.doc_id;
  const store = raw.store;

  return (
    <article className="product-card">
      <div className="product-card-main">
        <div className="product-card-topline">
          <span className="product-type">GROCERY PRODUCT</span>
          <span className="match-score">
            Match {Number(item.score).toFixed(1)}
          </span>
        </div>
        <h3>{title}</h3>
        <div className="product-meta">
          {store && <span>{store}</span>}
          <span className="product-id">ID {productId}</span>
        </div>
      </div>
      <button
        className="button button-quiet"
        type="button"
        onClick={() => onView(item)}
      >
        View details
        <span aria-hidden="true">↗</span>
      </button>
    </article>
  );
}

function ResultsList({ results, onView }) {
  const count = results.length;

  return (
    <section className="results-section">
      <div className="results-header">
        <div>
          <p className="section-kicker results-kicker">Your search</p>
          <h2>
            {count.toLocaleString()} {count === 1 ? "product" : "products"}{" "}
            found
          </h2>
        </div>
        {count > 0 && <span className="sort-note">Sorted by relevance</span>}
      </div>

      {count > 0 ? (
        <div className="product-list">
          {results.map((item) => (
            <ProductResult key={item.doc_id} item={item} onView={onView} />
          ))}
        </div>
      ) : (
        <div className="empty-results">
          <span aria-hidden="true">⌕</span>
          <h3>No matching products yet</h3>
          <p>Try a broader grocery term, such as “coffee” or “chocolate”.</p>
        </div>
      )}
    </section>
  );
}

function SearchPanel({
  indexReady,
  isSearching,
  stage,
  error,
  expandedTerms,
  results,
  hasSearched,
  onSearch,
  onView,
}) {
  const [query, setQuery] = useState("");
  const [top, setTop] = useState("5");

  function handleSubmit(event) {
    event.preventDefault();
    if (!query.trim() || !indexReady || isSearching) return;
    const limit = Number.parseInt(top, 10) || 5;
    onSearch(query.trim(), limit);
  }

  return (
    <section className="workflow-section search-section">
      <div className="section-kicker">
        <span className="step-number">02</span>
        <span>Explore catalog</span>
      </div>

      <div className="section-heading-row">
        <div>
          <h2>Search products with AI expansion</h2>
          <p className="section-description">
            Query the parallel inverted index powered by live Ollama query
            expansion.
          </p>
        </div>
        <span className="search-spark" aria-hidden="true">
          ✦
        </span>
      </div>

      <form className="search-form" onSubmit={handleSubmit}>
        <label className="field-group search-input-wrap" htmlFor="search-query">
          <span>Search query</span>
          <span className="search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            id="search-query"
            type="text"
            placeholder="e.g. organic coffee, dark chocolate..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={!indexReady}
          />
        </label>
        <label className="field-group result-limit" htmlFor="result-limit">
          <span>Top results</span>
          <input
            id="result-limit"
            type="number"
            min="1"
            max="100"
            value={top}
            onChange={(event) => setTop(event.target.value)}
            disabled={!indexReady}
          />
        </label>
        <button
          className="button button-primary"
          type="submit"
          disabled={!indexReady || isSearching || !query.trim()}
        >
          {isSearching ? "Searching…" : "Search"}
          <span aria-hidden="true">→</span>
        </button>
      </form>

      {!indexReady && (
        <p className="inline-note note-muted">
          Build the index above before running searches.
        </p>
      )}

      {isSearching && (
        <div className="search-stage">
          <span className="stage-pulse" aria-hidden="true" />
          <span>{stage}</span>
        </div>
      )}

      {error && <p className="inline-note note-error">{error}</p>}

      {expandedTerms && <ExpandedKeywords terms={expandedTerms} />}

      {hasSearched && <ResultsList results={results} onView={onView} />}
    </section>
  );
}

function DocumentModal({ item, onClose }) {
  const [copyMessage, setCopyMessage] = useState("");

  useEffect(() => {
    if (!item) return undefined;
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [item, onClose]);

  if (!item) return null;

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
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="document-modal">
        <div className="modal-header">
          <div>
            <p className="section-kicker">Product record</p>
            <h2>Product details</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-toolbar">
          <span className="product-id">ID {item.doc_id}</span>
          <div className="copy-actions">
            {copyMessage && <span>{copyMessage}</span>}
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

export default function App() {
  const system = useSystemStatus();
  const socketRef = useRef(null);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexMessage, setIndexMessage] = useState("");
  const [indexError, setIndexError] = useState("");
  const [buildHistory, setBuildHistory] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchStage, setSearchStage] = useState("");
  const [searchError, setSearchError] = useState("");
  const [expandedTerms, setExpandedTerms] = useState(null);
  const [results, setResults] = useState([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);

  const indexReady = system.documents > 0 && !isIndexing;

  useEffect(
    () => () => {
      socketRef.current?.close(1000, "Page closed");
    },
    [],
  );

  async function handleBuildIndex(threads) {
    setIndexMessage("");
    setIndexError("");
    if (system.server !== "online") {
      setIndexError("The search server is offline. Start it and try again.");
      return;
    }

    setIsIndexing(true);
    try {
      const response = await buildIndex(threads);
      const documents = Number(response.documents_indexed) || 0;
      if (documents === 0) {
        throw new Error("No products were indexed.");
      }

      const timeMs = Number(response.time_ms) || 0;
      setBuildHistory((history) => [
        { id: `${Date.now()}-${threads}`, documents, threads, timeMs },
        ...history,
      ]);
      setIndexMessage(
        `Catalog ready — ${documents.toLocaleString()} products indexed.`,
      );
    } catch (error) {
      setIndexError(error.message || "Index build failed.");
    } finally {
      await system.refresh();
      setIsIndexing(false);
    }
  }

  const handleSearch = useCallback((query, top) => {
    socketRef.current?.close(1000, "Search replaced");
    setIsSearching(true);
    setSearchStage("Connecting to the search service…");
    setSearchError("");
    setExpandedTerms(null);
    setResults([]);
    setHasSearched(false);

    let completed = false;
    let failed = false;
    let socket;

    try {
      socket = new WebSocket(SEARCH_SOCKET_URL);
      socketRef.current = socket;
    } catch (error) {
      setIsSearching(false);
      setSearchStage("");
      setSearchError(error.message || "Could not open search connection.");
      return;
    }

    socket.onopen = () => {
      setSearchStage("Expanding query with Ollama…");
      socket.send(JSON.stringify({ query, top }));
    };

    socket.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        failed = true;
        setSearchError("Unreadable response.");
        socket.close(1000, "Invalid response");
        return;
      }

      if (payload.stage === "error") {
        failed = true;
        setSearchError(payload.message || "Search failed.");
        setIsSearching(false);
        setSearchStage("");
        socket.close(1000, "Error");
        return;
      }

      if (payload.stage === "query_expansion") {
        setExpandedTerms(
          Array.isArray(payload.data?.expanded_terms)
            ? payload.data.expanded_terms
            : [],
        );
        setSearchStage("Searching catalog…");
      } else if (payload.stage === "keyword_search") {
        setResults(
          Array.isArray(payload.data?.results) ? payload.data.results : [],
        );
        setHasSearched(true);
        setSearchStage("Loading matches…");
      } else if (payload.stage === "done") {
        completed = true;
        setIsSearching(false);
        setSearchStage("");
        socket.close(1000, "Complete");
      }
    };

    socket.onerror = () => {
      failed = true;
      setIsSearching(false);
      setSearchStage("");
      setSearchError("WebSocket connection error.");
    };

    socket.onclose = () => {
      if (!completed && !failed) {
        setIsSearching(false);
        setSearchStage("");
        setSearchError("Connection closed unexpectedly.");
      }
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#">
          <span className="brand-mark">M</span>
          <span className="brand-name">MARKETFIELD</span>
        </a>
        <div className="system-status">
          <StatusPill label="Server" status={system.server} />
          <StatusPill label="Ollama" status={system.ollama} />
          <StatusPill
            label="Catalog"
            status={isIndexing ? "checking" : system.index}
          />
        </div>
      </header>

      <main className="page-content">
        <section className="hero">
          <p className="hero-eyebrow">
            <span /> GROCERY &amp; FOOD SEARCH
          </p>
          <h1>
            Find good things
            <br />
            <em>for your table.</em>
          </h1>
          <p className="hero-description">
            Search a handpicked world of pantry staples, snacks, and everyday
            favorites.
          </p>
        </section>

        <div className="workflow-card">
          <IndexingPanel
            serverOnline={system.server === "online"}
            documents={system.documents}
            isIndexing={isIndexing}
            message={indexMessage}
            error={indexError}
            history={buildHistory}
            onBuild={handleBuildIndex}
          />
          <div className="workflow-divider" aria-hidden="true">
            <span />
            <span className="divider-mark">✳</span>
            <span />
          </div>
          <SearchPanel
            indexReady={indexReady}
            isSearching={isSearching}
            stage={searchStage}
            error={searchError}
            expandedTerms={expandedTerms}
            results={results}
            hasSearched={hasSearched}
            onSearch={handleSearch}
            onView={setSelectedProduct}
          />
        </div>

        <footer className="page-footer">
          <span>MARKETFIELD</span>
          <span>Thoughtful search for everyday groceries.</span>
        </footer>
      </main>

      <DocumentModal
        item={selectedProduct}
        onClose={() => setSelectedProduct(null)}
      />
    </div>
  );
}
