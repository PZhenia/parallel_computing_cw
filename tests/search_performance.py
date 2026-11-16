#!/usr/bin/env python3
import argparse
import csv
import itertools
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock
import requests

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FormatStrFormatter
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET_PATH = PROJECT_ROOT / "data" / "batched"
DEFAULT_OUTPUT_CSV = str(PROJECT_ROOT / "tests" / "results" / "search_performance.csv")
DEFAULT_OUTPUT_PLOT = str(PROJECT_ROOT / "docs" / "tests" / "search_throughput.png")
MAX_DATA_FILES = 12


def resolve_project_path(value):
    path = Path(value)
    return path if path.is_absolute() else PROJECT_ROOT / path


def select_dataset_files(files, limit=MAX_DATA_FILES):
    if len(files) <= limit:
        return files
    if limit == 1:
        return [files[0]]

    indexes = {
        round(index * (len(files) - 1) / (limit - 1))
        for index in range(limit)
    }
    return [files[index] for index in sorted(indexes)]


def title_to_query(title):
    words = re.findall(r"[A-Za-z0-9]+", title.lower())
    return " ".join(words[:6])


def load_queries(custom_path=None, dataset_path=DEFAULT_DATASET_PATH, maximum=60):
    if maximum <= 0:
        raise ValueError("The maximum number of search queries must be greater than zero.")

    if custom_path:
        query_file = resolve_project_path(custom_path)
        if not query_file.is_file():
            raise FileNotFoundError(f"Query file not found: {query_file}")
        with query_file.open("r", encoding="utf-8") as query_stream:
            queries = [
                line.strip()
                for line in query_stream
                if line.strip() and not line.lstrip().startswith("#")
            ]
        if not queries:
            raise ValueError(f"No search queries found in: {query_file}")
        return queries, str(query_file)

    data_path = resolve_project_path(dataset_path)
    if data_path.is_file():
        files = [data_path]
    elif data_path.is_dir():
        files = sorted(data_path.glob("*.jsonl"))
    else:
        files = []
    if not files:
        raise FileNotFoundError(f"No JSONL product data found at: {data_path}")

    sample_files = select_dataset_files(files)
    per_file_limit = max(1, math.ceil(maximum / len(sample_files)))
    queries = []
    seen = set()

    for file_path in sample_files:
        file_query_count = 0
        try:
            with file_path.open("r", encoding="utf-8") as data_stream:
                for line in data_stream:
                    if len(queries) >= maximum or file_query_count >= per_file_limit:
                        break
                    try:
                        product = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    title = product.get("title")
                    if not isinstance(title, str):
                        continue
                    query = title_to_query(title)
                    if query and query not in seen:
                        queries.append(query)
                        seen.add(query)
                        file_query_count += 1
        except OSError as error:
            raise OSError(f"Could not read product data from {file_path}: {error}") from error

    if not queries:
        raise ValueError(f"No product titles found in dataset: {data_path}")
    return queries, str(data_path)


def check_server(base_url):
    try:
        health_resp = requests.get(f"{base_url}/health", timeout=3)
        if health_resp.status_code != 200:
            return False, "Server /api/health returned non-200"
        stats_resp = requests.get(f"{base_url}/stats", timeout=3)
        docs = stats_resp.json().get("documents", 0)
        return True, docs
    except Exception as exc:
        return False, str(exc)


def resolve_concurrency_levels(range_args: list[int] | None, step_arg: int | None, clients_args: list[int] | None) -> list[int]:
    if range_args:
        if len(range_args) == 1:
            minimum_clients = 1
            maximum_clients = range_args[0]
            client_step = step_arg or (5 if maximum_clients <= 50 else 10)
        elif len(range_args) == 2:
            minimum_clients = range_args[0]
            maximum_clients = range_args[1]
            client_step = step_arg or (5 if maximum_clients <= 50 else 10)
        else:
            minimum_clients = range_args[0]
            maximum_clients = range_args[1]
            client_step = range_args[2]

        if minimum_clients > maximum_clients:
            minimum_clients, maximum_clients = maximum_clients, minimum_clients

        if client_step <= 0:
            client_step = 1

        points = []
        if minimum_clients == 1 and client_step > 1:
            points.append(1)
            current_client_count = client_step
            while current_client_count <= maximum_clients:
                points.append(current_client_count)
                current_client_count += client_step
            if points[-1] < maximum_clients:
                points.append(maximum_clients)
        else:
            current_client_count = minimum_clients
            while current_client_count <= maximum_clients:
                points.append(current_client_count)
                current_client_count += client_step
            if points[-1] < maximum_clients:
                points.append(maximum_clients)

        return sorted(list(set(points)))

    if clients_args:
        pts = []
        for item in clients_args:
            if isinstance(item, int):
                if item > 0:
                    pts.append(item)
            else:
                for part in str(item).replace(",", " ").split():
                    if part.strip().isdigit() and int(part.strip()) > 0:
                        pts.append(int(part.strip()))
        return sorted(list(set(pts))) if pts else [1, 5, 10, 20, 30, 50, 75, 100]

    return [1, 5, 10, 20, 30, 50, 75, 100]


def measure_search_load(search_endpoint, client_count, duration_seconds, warmup_seconds, search_queries):
    if not search_queries:
        raise ValueError("At least one dataset-derived search query is required.")
    measurement_stop = Event()
    successful_latencies_ms = []
    successful_request_count = 0
    failed_request_count = 0
    request_timeout_seconds = 20
    query_sequence = itertools.count()
    query_sequence_lock = Lock()

    def choose_query():
        with query_sequence_lock:
            return search_queries[next(query_sequence) % len(search_queries)]

    def send_requests():
        nonlocal successful_request_count, failed_request_count
        session = requests.Session()
        connection_pool = requests.adapters.HTTPAdapter(
            pool_connections=client_count,
            pool_maxsize=client_count,
        )
        session.mount("http://", connection_pool)

        while not measurement_stop.is_set():
            query = choose_query()
            payload = {"query": query, "top": 5}
            request_started_at = time.perf_counter()
            try:
                response = session.post(search_endpoint, json=payload, timeout=request_timeout_seconds)
                response_received_at = time.perf_counter()
                if response.status_code == 200:
                    successful_latencies_ms.append((response_received_at - request_started_at) * 1000.0)
                    successful_request_count += 1
                else:
                    failed_request_count += 1
            except Exception:
                failed_request_count += 1

    if warmup_seconds > 0:
        warmup_stop = Event()

        def warmup_requests():
            warmup_session = requests.Session()
            while not warmup_stop.is_set():
                try:
                    warmup_session.post(
                        search_endpoint,
                        json={"query": search_queries[0], "top": 5},
                        timeout=request_timeout_seconds,
                    )
                except Exception:
                    pass

        with ThreadPoolExecutor(max_workers=min(client_count, 4)) as warmup_pool:
            for _ in range(min(client_count, 4)):
                warmup_pool.submit(warmup_requests)
            time.sleep(warmup_seconds)
            warmup_stop.set()

    measurement_started_at = time.perf_counter()
    with ThreadPoolExecutor(max_workers=client_count) as measurement_pool:
        for _ in range(client_count):
            measurement_pool.submit(send_requests)
        time.sleep(duration_seconds)
        measurement_stop.set()

    elapsed_seconds = time.perf_counter() - measurement_started_at
    total_request_count = successful_request_count + failed_request_count
    throughput_rps = successful_request_count / elapsed_seconds if elapsed_seconds > 0 else 0.0

    successful_latencies_ms.sort()
    average_latency_ms = (
        sum(successful_latencies_ms) / len(successful_latencies_ms)
        if successful_latencies_ms
        else 0.0
    )
    p50_latency_ms = successful_latencies_ms[int(len(successful_latencies_ms) * 0.50)] if successful_latencies_ms else 0.0
    p95_latency_ms = successful_latencies_ms[int(len(successful_latencies_ms) * 0.95)] if successful_latencies_ms else 0.0
    p99_latency_ms = successful_latencies_ms[int(len(successful_latencies_ms) * 0.99)] if successful_latencies_ms else 0.0

    return {
        "clients": client_count,
        "total_requests": total_request_count,
        "success_requests": successful_request_count,
        "failed_requests": failed_request_count,
        "duration_sec": elapsed_seconds,
        "rps": throughput_rps,
        "avg_lat_ms": average_latency_ms,
        "p50_lat_ms": p50_latency_ms,
        "p95_lat_ms": p95_latency_ms,
        "p99_lat_ms": p99_latency_ms,
    }


def print_search_summary(results: list[dict]):
    print("\n" + "=" * 92)
    print("          SEARCH PERFORMANCE TEST SUMMARY (OLLAMA QUERY EXPANSION)")
    print("=" * 92)
    print(f"{'#':<3} | {'Clients':<8} | {'Requests':<10} | {'RPS':<10} | {'Avg Lat':<12} | {'P50':<10} | {'P95':<10} | {'Errors':<7}")
    print("-" * 92)
    for idx, r in enumerate(results, start=1):
        print(f"{idx:<3} | {r['clients']:<8} | {r['total_requests']:<10,} | {r['rps']:<10.3f} | "
              f"{r['avg_lat_ms']:>8.3f} ms | {r['p50_lat_ms']:>6.3f} ms | {r['p95_lat_ms']:>6.3f} ms | {r['failed_requests']:<7}")
    print("=" * 92 + "\n")


def save_search_results(results, path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["clients", "rps", "avg_lat_ms", "p50_lat_ms", "p95_lat_ms", "p99_lat_ms", "total_requests", "failed_requests"])
        for r in results:
            writer.writerow([
                r["clients"],
                f"{r['rps']:.3f}",
                f"{r['avg_lat_ms']:.3f}",
                f"{r['p50_lat_ms']:.3f}",
                f"{r['p95_lat_ms']:.3f}",
                f"{r['p99_lat_ms']:.3f}",
                r["total_requests"],
                r["failed_requests"]
            ])


def load_search_results(path):
    if not os.path.exists(path):
        print(f"[ERROR] CSV file not found: {path}", file=sys.stderr)
        sys.exit(1)
    results = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                results.append({
                    "clients": int(row["clients"]),
                    "rps": float(row["rps"]),
                    "avg_lat_ms": float(row["avg_lat_ms"]),
                    "p50_lat_ms": float(row["p50_lat_ms"]),
                    "p95_lat_ms": float(row["p95_lat_ms"]),
                    "p99_lat_ms": float(row.get("p99_lat_ms", 0.0)),
                    "total_requests": int(float(row.get("total_requests", 0))),
                    "failed_requests": int(float(row.get("failed_requests", 0))),
                })
            except (ValueError, KeyError):
                continue
    return results


def plot_search_charts(results, path):
    if not HAS_MATPLOTLIB:
        print("[WARN] matplotlib not installed; skipping plot generation.")
        return

    if not results:
        return

    out_dir = os.path.dirname(os.path.abspath(path)) if path.endswith(".png") else os.path.abspath(path)
    os.makedirs(out_dir, exist_ok=True)

    measurements_by_client_count = {}
    for r in results:
        client_count = int(r["clients"])
        if client_count not in measurements_by_client_count:
            measurements_by_client_count[client_count] = []
        measurements_by_client_count[client_count].append(r)

    concurrency_levels = sorted(measurements_by_client_count)
    throughput_rps = []
    mean_latency_ms = []
    p95_latency_ms = []

    for client_count in concurrency_levels:
        measurements = measurements_by_client_count[client_count]
        throughput_rps.append(sum(item["rps"] for item in measurements) / len(measurements))
        mean_latency_ms.append(sum(item["avg_lat_ms"] for item in measurements) / len(measurements))
        p95_latency_ms.append(sum(item["p95_lat_ms"] for item in measurements) / len(measurements))

    max_concurrency = max(concurrency_levels) if concurrency_levels else 100
    if max_concurrency <= 20:
        tick_interval = 2
    elif max_concurrency <= 50:
        tick_interval = 5
    elif max_concurrency <= 100:
        tick_interval = 10
    elif max_concurrency <= 250:
        tick_interval = 20
    else:
        tick_interval = 50

    concurrency_ticks = list(range(0, max_concurrency + 1, tick_interval))
    if concurrency_ticks[-1] < max_concurrency:
        concurrency_ticks.append(max_concurrency)

    throughput_path = os.path.join(out_dir, "search_throughput.png")
    fig, throughput_axis = plt.subplots(figsize=(10, 5.5), facecolor="#F7F2EA")
    throughput_axis.set_facecolor("#FCFAF6")
    throughput_axis.plot(
        concurrency_levels,
        throughput_rps,
        marker="o",
        markersize=6,
        color="#367D75",
        linewidth=2.4,
        label="Successful requests per second",
    )
    throughput_axis.set_ylabel("Requests per second", fontsize=11, fontweight="bold")
    throughput_axis.yaxis.set_major_formatter(FormatStrFormatter("%.3f"))
    throughput_axis.set_xlabel("Concurrent clients", fontsize=11, fontweight="bold")
    throughput_axis.set_title("Search throughput by concurrency", fontsize=13, fontweight="bold", pad=14, color="#453C3A")
    throughput_axis.set_xticks(concurrency_ticks)
    throughput_axis.set_xlim(0, max_concurrency * 1.02)
    throughput_axis.grid(True, axis="y", linestyle=":", alpha=0.55, color="#A89D91")
    throughput_axis.set_axisbelow(True)
    throughput_axis.spines["top"].set_visible(False)
    throughput_axis.spines["right"].set_visible(False)
    throughput_axis.spines["left"].set_color("#C8BFB5")
    throughput_axis.spines["bottom"].set_color("#C8BFB5")
    throughput_axis.legend(loc="upper left", frameon=False)
    plt.tight_layout()
    plt.savefig(throughput_path, dpi=300)
    plt.close()
    print(f"[OK] Throughput plot saved to: {throughput_path}")

    latency_path = os.path.join(out_dir, "search_latency.png")
    fig, latency_axis = plt.subplots(figsize=(10, 5.5), facecolor="#F7F2EA")
    latency_axis.set_facecolor("#FCFAF6")
    latency_axis.plot(
        concurrency_levels,
        mean_latency_ms,
        marker="s",
        markersize=5,
        color="#9B5368",
        linewidth=2.4,
        label="Mean latency",
    )
    latency_axis.plot(
        concurrency_levels,
        p95_latency_ms,
        marker="^",
        markersize=6,
        color="#D97757",
        linewidth=2.2,
        linestyle="--",
        label="95th percentile latency",
    )
    latency_axis.set_xlabel("Concurrent clients", fontsize=11, fontweight="bold")
    latency_axis.set_ylabel("Response time (milliseconds)", fontsize=11, fontweight="bold")
    latency_axis.yaxis.set_major_formatter(FormatStrFormatter("%.3f"))
    latency_axis.set_title("Search response time by concurrency", fontsize=13, fontweight="bold", pad=14, color="#453C3A")
    latency_axis.set_xticks(concurrency_ticks)
    latency_axis.set_xlim(0, max_concurrency * 1.02)
    latency_axis.grid(True, axis="y", linestyle=":", alpha=0.55, color="#A89D91")
    latency_axis.set_axisbelow(True)
    latency_axis.spines["top"].set_visible(False)
    latency_axis.spines["right"].set_visible(False)
    latency_axis.spines["left"].set_color("#C8BFB5")
    latency_axis.spines["bottom"].set_color("#C8BFB5")
    latency_axis.legend(loc="upper left", frameon=False)
    plt.tight_layout()
    plt.savefig(latency_path, dpi=300)
    plt.close()
    print(f"[OK] Latency plot saved to: {latency_path}")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(
        description="Measure search performance using product titles from the project dataset."
    )
    parser.add_argument(
        "--range",
        nargs="+",
        type=int,
        metavar=("MIN", "MAX"),
        help="Client range as: MIN MAX [STEP] (e.g. --range 1 50 or --range 10 100 10)"
    )
    parser.add_argument(
        "--step", "-s",
        type=int,
        help="Step size for client range increments"
    )
    parser.add_argument(
        "--clients", "-c",
        nargs="+",
        help="Explicit list of concurrent client levels (e.g. -c 1 5 10 20 30 50 75 100)"
    )
    parser.add_argument(
        "--duration", "-d", "--time",
        type=int,
        default=10,
        help="Test duration per concurrency level in seconds (default: 10)"
    )
    parser.add_argument(
        "--warmup", "-w",
        type=int,
        default=2,
        help="Warmup duration in seconds before measurement (default: 2)"
    )
    parser.add_argument(
        "--dataset",
        default=str(DEFAULT_DATASET_PATH),
        help=f"JSONL product file or directory used to create search queries (default: {DEFAULT_DATASET_PATH})"
    )
    parser.add_argument(
        "--max-queries",
        type=int,
        default=60,
        help="Maximum number of product-title queries sampled from the dataset (default: 60)"
    )
    parser.add_argument(
        "--url",
        default="http://localhost:8080/api/search",
        help="Target search endpoint (default: http://localhost:8080/api/search)"
    )
    parser.add_argument(
        "--queries", "-q",
        default=None,
        help="Optional text file with explicit queries; by default queries come from product titles in --dataset"
    )
    parser.add_argument(
        "--from-csv",
        help="Rebuild charts and summary from saved CSV results"
    )
    parser.add_argument(
        "--output-csv", "--csv",
        default=DEFAULT_OUTPUT_CSV,
        help=f"CSV output path (default: {DEFAULT_OUTPUT_CSV})"
    )
    parser.add_argument(
        "--output-plot", "--output-dir",
        default=DEFAULT_OUTPUT_PLOT,
        help=f"Output directory or plot path (default: {DEFAULT_OUTPUT_PLOT})"
    )

    args = parser.parse_args()

    if args.from_csv:
        print(f"Loading saved search test results from: {args.from_csv}")
        results = load_search_results(args.from_csv)
        print_search_summary(results)
        plot_search_charts(results, args.output_plot)
        return

    try:
        queries, queries_source = load_queries(
            args.queries,
            args.dataset,
            args.max_queries,
        )
    except (OSError, ValueError) as error:
        print(f"[ERROR] Could not load search queries: {error}", file=sys.stderr)
        return 1

    api_base = args.url.rsplit("/", 1)[0]
    ok, info = check_server(api_base)
    if not ok:
        print(f"[ERROR] Cannot connect to search server at {api_base}: {info}", file=sys.stderr)
        sys.exit(1)

    doc_count = info
    print(f"[INFO] Server is online. Indexed documents: {doc_count:,}")
    if doc_count == 0:
        print("[WARN] Index is empty! Search results may not reflect realistic load.", file=sys.stderr)

    concurrency_levels = resolve_concurrency_levels(args.range, args.step, args.clients)

    print(f"[INFO] Loaded {len(queries)} product queries from: {queries_source}")
    print(f"[INFO] Starting load test on: {args.url}")
    print(f"[INFO] Query processing: Ollama expansion | Client levels: {concurrency_levels} ({len(concurrency_levels)} points)")
    print(f"[INFO] Duration per level: {args.duration}s | Warmup: {args.warmup}s")
    print("-" * 88)

    results = []
    total_steps = len(concurrency_levels)

    for idx, client_count in enumerate(concurrency_levels, start=1):
        print(f"[{idx}/{total_steps}] Testing with {client_count} clients (duration: {args.duration}s)... ", end="", flush=True)
        res = measure_search_load(
            args.url,
            client_count,
            args.duration,
            args.warmup,
            search_queries=queries,
        )
        results.append(res)
        print("DONE")

    print_search_summary(results)

    save_search_results(results, args.output_csv)
    print(f"[OK] CSV results saved to: {args.output_csv}")

    plot_search_charts(results, args.output_plot)
    return 0


if __name__ == "__main__":
    main()
