import ProductResult from "./ProductResult.jsx";

export default function ResultsList({ results, onView }) {
  const count = results.length;

  return (
    <section className="results-section" aria-labelledby="results-heading">
      <div className="results-header">
        <div>
          <p className="section-kicker results-kicker">Your search</p>
          <h2 id="results-heading">
            {count.toLocaleString()} {count === 1 ? "product" : "products"} found
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
