export default function ExpandedKeywords({ terms }) {
  return (
    <section className="expanded-card" aria-labelledby="expanded-heading">
      <div className="expanded-icon" aria-hidden="true">✳</div>
      <div className="expanded-content">
        <div className="expanded-heading-row">
          <h3 id="expanded-heading">Expanded search keywords</h3>
          <span className="ai-label">OLLAMA</span>
        </div>
        <p className="expanded-caption">
          Related terms generated to broaden your grocery search.
        </p>
        {terms.length > 0 ? (
          <ul className="keyword-list">
            {terms.map((term, index) => <li key={`${term}-${index}`}>{term}</li>)}
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
