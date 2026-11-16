import { useCallback, useEffect, useState } from "react";
import { getHealth, getStats } from "../lib/api.js";

const initialStatus = {
  server: "checking",
  ollama: "checking",
  index: "checking",
  documents: 0,
  buildTimeMs: 0,
};

export default function useSystemStatus() {
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
