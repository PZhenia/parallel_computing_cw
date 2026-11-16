# Parallel Computing Coursework: Parallel Search Pipeline

A full-text search engine with a custom thread pool, parallel inverted index construction, a custom thread-safe hash map, and integration with a local LLM (Ollama) for query expansion.

---

## Tech Stack & Architecture

- **Backend**: C# / ASP.NET Core (.NET 10)
  - Custom `ThreadPool` and `ThreadSafeTaskQueue` (implemented via `Monitor.Wait`/`PulseAll`).
  - Custom thread-safe `CustomHashMap` with fine-grained segment locking and lock-free `ConcurrentPostingList` using CAS.
  - TF-based search ranking and Top-K extraction.
  - WebSocket handler for real-time pipeline streaming.
- **LLM Integration**: Local Ollama container running `llama3.2:1b` for automated query expansion.
- **Frontend**: React + Vite application for interactive indexing and searching.
- **CLI Clients**: Node.js scripts for terminal-based index control and searching.
- **Infrastructure**: Docker Compose orchestration.

---

## Getting Started (Docker Compose)

1. Start all services:
   ```bash
   docker compose up --build -d
   ```
