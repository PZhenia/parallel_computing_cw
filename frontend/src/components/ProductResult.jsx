export default function ProductResult({ item, onView }) {
  const raw = item.raw || {};
  const title = raw.title || item.snippet || "Untitled product";
  const productId = raw.parent_asin || raw.asin || item.doc_id;
  const store = raw.store;
  const category = Array.isArray(raw.categories) ? raw.categories[0] : null;

  return (
    <article className="product-card">
      <div className="product-card-main">
        <div className="product-card-topline">
          <span className="product-type">GROCERY PRODUCT</span>
          <span className="match-score">Match {Number(item.score).toFixed(1)}</span>
        </div>
        <h3>{title}</h3>
        <div className="product-meta">
          {store && <span>{store}</span>}
          {category && <span>{category}</span>}
          <span className="product-id">ID {productId}</span>
        </div>
      </div>
      <button className="button button-quiet" type="button" onClick={() => onView(item)}>
        View details
        <span aria-hidden="true">↗</span>
      </button>
    </article>
  );
}
