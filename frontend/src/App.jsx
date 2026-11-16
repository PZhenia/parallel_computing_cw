import { useCallback, useEffect, useRef, useState } from "react";
import DocumentModal from "./components/DocumentModal.jsx";
import IndexingPanel from "./components/IndexingPanel.jsx";
import SearchPanel from "./components/SearchPanel.jsx";
import StatusPill from "./components/StatusPill.jsx";
import useSystemStatus from "./hooks/useSystemStatus.js";
import { buildIndex, SEARCH_SOCKET_URL } from "./lib/api.js";

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
        throw new Error(
          "No products were indexed. Check that the dataset contains JSONL files with parent_asin values.",
        );
      }

      const timeMs = Number(response.time_ms) || 0;
      setBuildHistory((history) => [
        { id: `${Date.now()}-${threads}`, documents, threads, timeMs },
        ...history,
      ]);
      setIndexMessage(
        `Catalog ready — ${documents.toLocaleString()} products indexed in ${(timeMs / 1000).toFixed(2)} seconds.`,
      );
    } catch (error) {
      setIndexError(error.message || "Index build failed. Please try again.");
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
      setSearchError(error.message || "Could not open the search connection.");
      return;
    }

    socket.onopen = () => {
      setSearchStage("Expanding your query with related food terms…");
      socket.send(JSON.stringify({ query, top }));
    };

    socket.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        failed = true;
        setSearchError("The search service returned an unreadable response.");
        socket.close(1000, "Invalid response");
        return;
      }

      if (payload.stage === "error") {
        failed = true;
        setSearchError(payload.message || "Search failed.");
        setIsSearching(false);
        setSearchStage("");
        socket.close(1000, "Search error");
        return;
      }

      if (payload.stage === "query_expansion") {
        setExpandedTerms(
          Array.isArray(payload.data?.expanded_terms)
            ? payload.data.expanded_terms
            : [],
        );
        setSearchStage("Searching the catalog…");
      } else if (payload.stage === "keyword_search") {
        setResults(
          Array.isArray(payload.data?.results) ? payload.data.results : [],
        );
        setHasSearched(true);
        setSearchStage("Loading product matches…");
      } else if (payload.stage === "done") {
        completed = true;
        setIsSearching(false);
        setSearchStage("");
        socket.close(1000, "Search complete");
      }
    };

    socket.onerror = () => {
      failed = true;
      setIsSearching(false);
      setSearchStage("");
      setSearchError(
        `Could not connect to the search service at ${SEARCH_SOCKET_URL}.`,
      );
    };

    socket.onclose = (event) => {
      if (!completed && !failed) {
        setIsSearching(false);
        setSearchStage("");
        setSearchError(
          event.code === 1000
            ? "The search connection closed before results were complete."
            : `The search connection ended unexpectedly (${event.code}).`,
        );
      }
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#" aria-label="Marketfield home">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <span className="brand-name">MARKETFIELD</span>
        </a>
        <div className="system-status" aria-label="System status">
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
            ollamaOnline={system.ollama === "online"}
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
