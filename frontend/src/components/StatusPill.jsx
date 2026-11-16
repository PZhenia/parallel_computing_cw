const labels = {
  checking: "Checking",
  online: "Online",
  offline: "Offline",
  unknown: "Unknown",
  ready: "Index ready",
  empty: "Index needed",
};

export default function StatusPill({ label, status }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      <span>{label}: {labels[status] || status}</span>
    </span>
  );
}
