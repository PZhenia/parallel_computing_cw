import { useState } from "react";
import ExpandedKeywords from "./ExpandedKeywords.jsx";
import ResultsList from "./ResultsList.jsx";

export default function SearchPanel({
  indexReady,
  ollamaOnline,
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
  const [maximumResults, setMaximumResults] = useState("5");

  function handleSubmit(event) {
    event.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery || !indexReady || isSearching) {
      return;
    }

    const parsedLimit = Number.parseInt(maximumResults, 10);
    onSearch(trimmedQuery, Number.isNaN(parsedLimit) ? 5 : Math.min(50, Math.max(1, parsedLimit)));
  }

  return (
    <section className="workflow-section search-section" aria-labelledby="search-heading">
      <div className="section-kicker">
        <span className="step-number">02</span>
        <span>Find something good</span>
      </div>

      <div className="section-heading-row">
        <div>
          <h2 id="search-heading">Search the grocery catalog</h2>
          <p className="section-description">
            Describe what you need. AI will expand your words with related product terms.
          </p>
        </div>
        <span className="search-spark" aria-hidden="true">✳</span>
      </div>

      <form className="search-form" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="grocery-query">Search grocery products</label>
        <div className="search-input-wrap">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            id="grocery-query"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Try coffee beans, chocolate cookies, or olive oil"
            autoComplete="off"
          />
        </div>
        <label className="result-limit" htmlFor="maximum-results">
          <span>Maximum results</span>
          <input
            id="maximum-results"
            type="number"
            min="1"
            max="50"
            value={maximumResults}
            onChange={(event) => setMaximumResults(event.target.value)}
          />
        </label>
        <button
          className="button button-primary"
          type="submit"
          disabled={!indexReady || isSearching || !query.trim()}
        >
          {isSearching ? "Searching…" : "Search products"}
          <span aria-hidden="true">↗</span>
        </button>
      </form>

      {!indexReady && (
        <p className="inline-note note-muted" role="status">
          Build the product index above to enable search.
        </p>
      )}
      {indexReady && !ollamaOnline && (
        <p className="inline-note note-warning" role="status">
          AI keyword expansion is offline. Search will still use your original query.
        </p>
      )}
      {stage && (
        <p className="search-stage" role="status" aria-live="polite">
          <span className="stage-pulse" aria-hidden="true" />
          {stage}
        </p>
      )}
      {error && <p className="inline-note note-error" role="alert">{error}</p>}

      {expandedTerms !== null && <ExpandedKeywords terms={expandedTerms} />}
      {hasSearched && <ResultsList results={results} onView={onView} />}
    </section>
  );
}
