# Parallel Search Pipeline

A parallel full-text search system for grocery and food products. It builds an in-memory inverted index from a JSONL product catalog, ranks matching products, and can expand search queries with a locally hosted language model.

## Overview

The application has three runtime services:

1. **React web client** — provides catalog indexing controls, search, live pipeline status, and product detail views.
2. **ASP.NET Core search server** — indexes the product dataset in parallel, exposes HTTP endpoints for health, statistics, indexing, and search, and streams search stages to the browser over WebSockets.
3. **Ollama** — runs `llama3.2:1b` locally to suggest related product terms. Search still works with the original query if Ollama is unavailable.

The product dataset is stored as JSON Lines files in `data/batched/`. Docker Compose mounts that directory into the server container. Indexing is an explicit action; starting the services alone does not build the index.

### Search and indexing flow

- When an index is built, the server splits the dataset files into work chunks and processes them with its custom thread pool. The resulting in-memory inverted index uses a custom segmented hash map and concurrent posting lists.
- A query is expanded by Ollama, then searched against the inverted index. Matching products are ranked by term frequency and the top results are returned with snippets and raw product data.
- The web client uses HTTP for status and index building, then a WebSocket for search. The socket streams query-expansion and keyword-search stages.

```text
Browser (React + Vite) ── HTTP / WebSocket ──> ASP.NET Core search server
Node.js CLI client ────── HTTP ──────────────>          │
Python benchmarks ─────── HTTP ──────────────>          ├── JSONL files in data/batched/
                                                        └── HTTP ──> Ollama (llama3.2:1b)
```

### Technology stack

- **Backend:** C# and ASP.NET Core on **.NET 10**
- **Frontend:** **React** and **Vite**
- **Query expansion:** **Ollama** with `llama3.2:1b`
- **Orchestration:** **Docker Compose**
- **CLI clients:** **Node.js**
- **Performance scripts:** **Python** (with `requests`; `matplotlib` is optional for charts)

## Prerequisites

### For Docker Compose (recommended)

- Docker Desktop (or Docker Engine) with the Compose plugin
- Git, if cloning the repository
- Enough disk space for the product dataset, Docker images, and the Ollama model

Docker builds the .NET and React services and downloads the Ollama model on first startup. The initial start can take several minutes.

### For running services directly on your machine

- .NET 10 SDK
- Node.js 22 recommended (the frontend container uses Node 22; the CLI requires Node.js with built-in `fetch`)
- Python 3.10 or later and `pip`
- Ollama installed locally, with the `llama3.2:1b` model available

## Run with Docker Compose

Run these commands from the repository root:

```bash
docker compose up --build -d
```

Compose starts the Ollama, search-server, and frontend services. Ollama pulls `llama3.2:1b` if it is not already in its persistent volume. Follow startup progress with:

```bash
docker compose ps
docker compose logs -f ollama search-server frontend
```

Once ready, open the web application at **http://localhost:5173**. The search server is available at **http://localhost:8080**, and Ollama is exposed at **http://localhost:11434**.

The index starts empty. Use **Build index** in the web interface or the Node.js CLI below before searching. The first index build may take a while, depending on the dataset and machine.

Stop the services while retaining the Ollama model:

```bash
docker compose down
```

To also delete the downloaded model volume:

```bash
docker compose down -v
```

## Run locally (without Docker)

Start Ollama and make sure the model is installed:

```bash
ollama serve
ollama pull llama3.2:1b
```

In another terminal, start the backend from the repository root:

```bash
dotnet run --project backend/SearchServer.csproj -- --urls http://localhost:8080
```

The launch profile uses port `5089`; the `--urls` argument above overrides it to keep local setup consistent with the Docker Compose port and the clients' default URL. The backend reads the dataset from `data/batched/` by default. To use a different dataset directory, set `SEARCH_DATASET_PATH` before starting the server.

In another terminal, install frontend dependencies and start Vite:

```bash
cd frontend
npm ci
npm run dev
```

Open the Vite URL printed in the terminal (normally **http://localhost:5173**). The frontend defaults to the backend at `http://localhost:8080`. If the backend is hosted elsewhere, set `VITE_API_BASE_URL` to its base URL before starting Vite. The frontend also derives its WebSocket URL from that setting; `VITE_SEARCH_WS_URL` can override it if needed.

## Test the application

### 1. Check backend health and index statistics

The health endpoint reports the server status and whether Ollama is reachable. The statistics endpoint reports the current in-memory index state:

```bash
curl http://localhost:8080/api/health
curl http://localhost:8080/api/stats
```

Example responses:

```json
{"status":"ok","ollama":true}
{"documents":0,"index_build_time_ms":0,"threads_used":0}
```

`documents` is zero until an index has been built. To verify the indexing endpoint directly:

```bash
curl -X POST http://localhost:8080/api/index \
  -H "Content-Type: application/json" \
  -d "{\"threads\":8}"
```

The response includes `documents_indexed` and `time_ms`. Then request stats again to see the updated document count and last build details.

On Windows PowerShell, use `curl.exe` (rather than the `curl` alias) and escape the JSON body as follows:

```powershell
curl.exe -X POST http://localhost:8080/api/index -H "Content-Type: application/json" -d '{"threads":8}'
```

### 2. Use the React web interface

1. Open **http://localhost:5173**.
2. Confirm that the server and Ollama status indicators are online. The catalog indicator will show that indexing is needed until a build completes.
3. Choose a worker-thread count and select **Build index**. Wait for the indexed product count and build time.
4. Enter a product query (for example, `organic pasta`) and search. The interface displays query-expansion and catalog-search progress, then ranked product matches.
5. Open a result to inspect its product details.

### 3. Run the Node.js indexing/status CLI

From the repository root, build the index using eight worker threads:

```bash
node cli-client/index.js --threads 8
```

Check backend, Ollama, and index status:

```bash
node cli-client/index.js --status
```

The indexing client defaults to `http://localhost:8080`. Point it to another backend with `--url`:

```bash
node cli-client/index.js --status --url http://localhost:8080
```

### 4. Search with the Node.js CLI

Pass a query to run one search and exit:

```bash
node cli-client/search.js "organic pasta" --top 5
```

Show the complete raw product JSON in each result:

```bash
node cli-client/search.js "organic pasta" --top 5 --raw
```

Omit the query to enter interactive search mode:

```bash
node cli-client/search.js
```

In interactive mode, enter search terms at the prompt. Use `:top 10` (or `:k 10`) to change the result count, `:raw` to toggle raw product data, and `q` or `exit` to leave. The CLI warns if the index is empty; build it first with `node cli-client/index.js --threads 8`.

The search CLI accepts `--url` to change the search endpoint and `--stats-url` to change its index-status endpoint. Run either client with `--help` for all available options.

### 5. Run the Python performance benchmarks

Both scripts target a running backend at `http://localhost:8080` by default. Build the index first, especially before the search load test. Create and activate a virtual environment if desired, then install the benchmark dependencies:

```bash
python -m venv .venv
```

Activate it and install packages:

```bash
# macOS/Linux
source .venv/bin/activate

# Windows PowerShell (use this instead of the previous activation command)
.\.venv\Scripts\Activate.ps1

python -m pip install requests matplotlib
```

`requests` is required by the concurrent search benchmark. `matplotlib` is optional; without it the scripts still print and save measurements as CSV, but skip chart generation.

#### Parallel indexing benchmark

This script repeatedly rebuilds the server's index with different worker counts and measures the server-reported build duration. For a focused run:

```bash
python tests/indexing_performance.py --threads 1 2 4 8 --runs 2
```

To test every count from 1 through 32 (more time-consuming):

```bash
python tests/indexing_performance.py --range 1 32 --runs 3
```

The script automatically includes one worker as the speedup baseline if it is not specified. By default, it writes `tests/results/indexing_performance.csv` and build-time/speedup plots under `docs/tests/`. Use `--no-plot` to skip charts, `--url http://localhost:8080` to choose another server, or `--help` to see additional options.

#### Concurrent search-load benchmark

This script samples product titles from `data/batched/` to generate queries, sends concurrent search requests to the backend, and reports throughput, average latency, p50/p95/p99 latency, and failed requests. For a shorter test with three concurrency levels:

```bash
python tests/search_performance.py --clients 1 5 10 --duration 5 --warmup 1
```

For example, to test client counts from 1 to 50 in steps of 10:

```bash
python tests/search_performance.py --range 1 50 --step 10 --duration 10 --warmup 2
```

By default, the script targets `http://localhost:8080/api/search`, derives sample queries from the local dataset, and saves `tests/results/search_performance.csv` plus throughput and latency plots under `docs/tests/`. Use `--queries path/to/queries.txt` for one query per line, `--max-queries 30` to limit generated queries, `--url` to set the search endpoint, or `--help` for all options. Each benchmark request uses the normal search API, including Ollama query expansion when available.

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Server status and Ollama availability |
| `GET` | `/api/stats` | Indexed document count, last build time, and worker count |
| `POST` | `/api/index` | Build or rebuild the index; JSON body may specify `threads` |
| `POST` | `/api/search` | Search with JSON body such as `{"query":"organic pasta","top":5}` |
| WebSocket | `/ws/search` | Stream query-expansion and keyword-search stages for the web client |

Search result limits default to five and are capped at 100 on the backend. The WebSocket endpoint expects a JSON message with `query` and optional `top`.

## Repository layout

```text
backend/       ASP.NET Core server and parallel indexing/search implementation
cli-client/    Node.js index-management and search clients
data/batched/  Product catalog JSONL files
frontend/      React + Vite web application
tests/         Python indexing and concurrent-search benchmarks
docs/          Benchmark output and project documentation
docker-compose.yaml
```
