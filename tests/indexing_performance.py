#!/usr/bin/env python3
import argparse
import csv
import json
import os
import sys
import time
from pathlib import Path
import urllib.error
import urllib.request

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FormatStrFormatter
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False

DEFAULT_BASE_URL = "http://localhost:8080"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV_PATH = PROJECT_ROOT / "tests" / "results" / "indexing_performance.csv"
DEFAULT_DOCS_DIR = PROJECT_ROOT / "docs" / "tests"


def make_request(url: str, method: str = "GET", payload: dict = None, timeout: int = 600) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload else None
    headers = {"Content-Type": "application/json"} if payload else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def check_health(base_url: str) -> bool:
    try:
        data = make_request(f"{base_url}/api/health", method="GET", timeout=5)
        return data.get("status") == "ok"
    except Exception:
        return False


def request_index_build(base_url: str, worker_count: int) -> dict:
    return make_request(f"{base_url}/api/index", method="POST", payload={"threads": worker_count}, timeout=600)


def resolve_worker_counts(range_args: list[int] | None, thread_args: list[str] | None) -> list[int]:
    worker_counts = []
    if range_args:
        if len(range_args) == 1:
            worker_counts = list(range(1, range_args[0] + 1))
        elif len(range_args) == 2:
            worker_counts = list(range(range_args[0], range_args[1] + 1))
        elif len(range_args) >= 3:
            worker_counts = list(range(range_args[0], range_args[1] + 1, range_args[2]))
    elif thread_args:
        for item in thread_args:
            for part in str(item).replace(",", " ").split():
                if part.strip().isdigit() and int(part.strip()) > 0:
                    worker_counts.append(int(part.strip()))
    else:
        worker_counts = [1, 2, 4, 8, 12, 16, 20, 24, 28, 32]

    worker_counts = sorted(set(worker_counts))
    if 1 not in worker_counts:
        print("[INFO] Thread 1 automatically prepended as the baseline (T1) for speedup calculations.")
        worker_counts = [1] + worker_counts
    return worker_counts


def run_indexing_test(base_url: str, worker_counts: list[int], runs: int) -> list[dict]:
    if not check_health(base_url):
        print(f"[ERROR] Search server unreachable at {base_url}. Ensure Docker container is running.", file=sys.stderr)
        sys.exit(1)

    print("\n" + "=" * 78)
    print("             PARALLEL INDEXING PERFORMANCE TEST")
    print(f"  Target Server : {base_url}")
    print("  Dataset       : Server-configured dataset (Compose default: data/batched)")
    print(f"  Thread Points : {worker_counts} ({len(worker_counts)} test points)")
    print(f"  Runs per Point: {runs}{' (with statistical averaging)' if runs > 1 else ''}")
    print("=" * 78 + "\n")

    results = []
    total_points = len(worker_counts)

    for point_index, worker_count in enumerate(worker_counts, start=1):
        run_durations_ms = []
        indexed_documents = 0

        for run_number in range(1, runs + 1):
            if runs > 1:
                progress = f"[{run_number}/{runs}] [{point_index}/{total_points}]"
            else:
                progress = f"[{point_index}/{total_points}]"

            print(f"{progress} Building with {worker_count} threads... ", end="", flush=True)
            started_at = time.time()
            try:
                res = request_index_build(base_url, worker_count)
                elapsed_wall = time.time() - started_at
                docs = res.get("documents_indexed", 0)
                if docs <= 0:
                    print("ERROR: No products were indexed. Check that data/batched contains valid JSONL files.")
                    break
                server_ms = res.get("time_ms", int(elapsed_wall * 1000))
                run_durations_ms.append(server_ms)
                indexed_documents = docs
                if runs == 1:
                    print("DONE")
                else:
                    server_duration_s = server_ms / 1000.0
                    print(f"DONE: {server_ms:.3f} ms ({server_duration_s:.3f} s) | {docs:,} docs")
            except Exception as e:
                print(f"ERROR: {e}")
                break

        if not run_durations_ms:
            continue

        avg_ms = sum(run_durations_ms) / len(run_durations_ms)
        avg_s = avg_ms / 1000.0
        min_s = min(run_durations_ms) / 1000.0
        max_s = max(run_durations_ms) / 1000.0

        if runs > 1:
            print(f"   ↳ Average for {worker_count} threads: {avg_ms:.3f} ms ({avg_s:.3f} s) [min: {min_s:.3f} s, max: {max_s:.3f} s]\n")

        results.append({
            "threads": worker_count,
            "docs": indexed_documents,
            "runs": len(run_durations_ms),
            "avg_ms": avg_ms,
            "avg_s": avg_s,
            "min_s": min_s,
            "max_s": max_s,
            "raw_ms": run_durations_ms
        })

    return results


def print_indexing_summary(results: list[dict], runs: int) -> float:
    baseline_result = next((item for item in results if item["threads"] == 1), None)
    base_time_s = baseline_result["avg_s"] if baseline_result and baseline_result["avg_s"] > 0 else (results[0]["avg_s"] if results else 1.0)

    for item in results:
        item["speedup"] = (base_time_s / item["avg_s"]) if item["avg_s"] > 0 else 1.0

    print("\n" + "=" * 78)
    print("                 INDEXING TEST SUMMARY")
    print("=" * 78)

    if runs > 1:
        print(f"{'#':<3} | {'Threads':<7} | {'Documents':<11} | {'Avg (ms)':<9} | {'Avg (s)':<8} | {'Min (s)':<8} | {'Max (s)':<8} | {'Speedup':<10}")
        print("-" * 78)
        for idx, item in enumerate(results, start=1):
            sp_str = f"{item['speedup']:.3f}x"
            if item["threads"] == 1:
                sp_str += " (base)"
            print(f"{idx:<3} | {item['threads']:<7} | {item['docs']:<11,} | {item['avg_ms']:<9.3f} | {item['avg_s']:<8.3f} | {item['min_s']:<8.3f} | {item['max_s']:<8.3f} | {sp_str:<10}")
    else:
        print(f"{'#':<3} | {'Threads':<7} | {'Documents':<11} | {'Time (ms)':<10} | {'Time (s)':<9} | {'Speedup':<12}")
        print("-" * 78)
        for idx, item in enumerate(results, start=1):
            sp_str = f"{item['speedup']:.3f}x"
            if item["threads"] == 1:
                sp_str += " (base)"
            print(f"{idx:<3} | {item['threads']:<7} | {item['docs']:<11,} | {item['avg_ms']:<10.3f} | {item['avg_s']:<9.3f} | {sp_str:<12}")

    print("=" * 78)
    return base_time_s


def save_indexing_csv(results: list[dict], csv_path: str):
    os.makedirs(os.path.dirname(os.path.abspath(csv_path)), exist_ok=True)
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Threads", "Documents", "Time_ms", "Time_s", "Speedup", "Runs", "Min_s", "Max_s"])
        for item in results:
            writer.writerow([
                item["threads"],
                item["docs"],
                f"{item['avg_ms']:.3f}",
                f"{item['avg_s']:.3f}",
                f"{item['speedup']:.3f}",
                item.get("runs", 1),
                f"{item.get('min_s', item['avg_s']):.3f}",
                f"{item.get('max_s', item['avg_s']):.3f}"
            ])
    print(f"\n[INFO] Test results saved to: {csv_path}")


def load_indexing_csv(csv_path: str) -> list[dict]:
    if not os.path.exists(csv_path):
        print(f"[ERROR] CSV file not found: {csv_path}", file=sys.stderr)
        sys.exit(1)

    results = []
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                t = int(row["Threads"])
                docs = int(float(row.get("Documents", 0)))
                avg_ms = float(row.get("Time_ms", 0))
                avg_s = float(row.get("Time_s", avg_ms / 1000.0))
                sp = float(row.get("Speedup", 1.0))
                runs = int(row.get("Runs", 1))
                min_s = float(row.get("Min_s", avg_s))
                max_s = float(row.get("Max_s", avg_s))
                results.append({
                    "threads": t,
                    "docs": docs,
                    "avg_ms": avg_ms,
                    "avg_s": avg_s,
                    "speedup": sp,
                    "runs": runs,
                    "min_s": min_s,
                    "max_s": max_s
                })
            except (ValueError, KeyError):
                continue
    return results


def plot_indexing_charts(results: list[dict], output_dir: str):
    if not HAS_MATPLOTLIB:
        print("[WARNING] matplotlib is not installed. Skipping plot generation.")
        return

    if not results:
        return

    os.makedirs(output_dir, exist_ok=True)
    worker_counts = [item["threads"] for item in results]
    average_build_seconds = [item["avg_s"] for item in results]
    minimum_build_seconds = [item["min_s"] for item in results]
    maximum_build_seconds = [item["max_s"] for item in results]
    speedup_factors = [item["speedup"] for item in results]
    indexed_document_count = results[0]["docs"]
    max_worker_count = max(worker_counts)

    tick_interval = 2 if max_worker_count <= 16 else (4 if max_worker_count <= 32 else 8)
    worker_ticks = [1] + [count for count in range(tick_interval, max_worker_count + 1, tick_interval)]
    if worker_ticks[-1] < max_worker_count:
        worker_ticks.append(max_worker_count)

    # 1. Execution Time Plot
    time_path = os.path.join(output_dir, "indexing_time.png")
    fig, build_time_axis = plt.subplots(figsize=(10, 5.5), facecolor="#F7F2EA")
    build_time_axis.set_facecolor("#FCFAF6")
    has_range = any(high > low for high, low in zip(maximum_build_seconds, minimum_build_seconds))
    if has_range:
        build_time_axis.fill_between(worker_counts, minimum_build_seconds, maximum_build_seconds, color="#D9A441", alpha=0.22, label="Run range")
    build_time_axis.plot(worker_counts, average_build_seconds, marker="o", markersize=6, color="#9B5368", linewidth=2.4, label="Average build time")
    build_time_axis.set_xlabel("Worker threads", fontsize=11, fontweight="bold")
    build_time_axis.set_ylabel("Build duration (seconds)", fontsize=11, fontweight="bold")
    build_time_axis.yaxis.set_major_formatter(FormatStrFormatter("%.3f"))
    subtitle = f" | {indexed_document_count:,} products" if indexed_document_count > 0 else ""
    build_time_axis.set_title(f"Index build duration{subtitle}", fontsize=13, fontweight="bold", pad=14, color="#453C3A")
    build_time_axis.set_xticks(worker_ticks)
    build_time_axis.set_xlim(0, max_worker_count * 1.02)
    build_time_axis.grid(True, axis="y", linestyle=":", alpha=0.55, color="#A89D91")
    build_time_axis.set_axisbelow(True)
    build_time_axis.spines["top"].set_visible(False)
    build_time_axis.spines["right"].set_visible(False)
    build_time_axis.spines["left"].set_color("#C8BFB5")
    build_time_axis.spines["bottom"].set_color("#C8BFB5")
    build_time_axis.legend(loc="upper right", frameon=False)
    plt.tight_layout()
    plt.savefig(time_path, dpi=300)
    plt.close()
    print(f"[OK] Build time plot saved to: {time_path}")

    # 2. Speedup Plot
    speedup_path = os.path.join(output_dir, "parallel_speedup.png")
    fig, speedup_axis = plt.subplots(figsize=(10, 5.5), facecolor="#F7F2EA")
    speedup_axis.set_facecolor("#FCFAF6")
    speedup_axis.plot(worker_counts, speedup_factors, marker="D", markersize=5, color="#367D75", linewidth=2.4, label="Observed speedup")
    speedup_axis.axhline(1.0, color="#9B5368", linewidth=1.2, linestyle="--", alpha=0.75, label="Single-thread baseline")

    speedup_axis.set_xlabel("Worker threads", fontsize=11, fontweight="bold")
    speedup_axis.set_ylabel("Relative speedup (×)", fontsize=11, fontweight="bold")
    speedup_axis.yaxis.set_major_formatter(FormatStrFormatter("%.3f"))
    speedup_axis.set_title("Indexing speedup by worker count", fontsize=13, fontweight="bold", pad=14, color="#453C3A")
    speedup_axis.set_xticks(worker_ticks)
    speedup_axis.set_xlim(0, max_worker_count * 1.02)
    speedup_axis.grid(True, axis="y", linestyle=":", alpha=0.55, color="#A89D91")
    speedup_axis.set_axisbelow(True)
    speedup_axis.spines["top"].set_visible(False)
    speedup_axis.spines["right"].set_visible(False)
    speedup_axis.spines["left"].set_color("#C8BFB5")
    speedup_axis.spines["bottom"].set_color("#C8BFB5")
    speedup_axis.legend(loc="upper left", frameon=False)
    plt.tight_layout()
    plt.savefig(speedup_path, dpi=300)
    plt.close()
    print(f"[OK] Speedup plot saved to: {speedup_path}")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(
        description="Measure parallel index build time against the configured product dataset."
    )
    parser.add_argument(
        "--range",
        nargs="+",
        type=int,
        metavar=("MIN", "MAX"),
        help="Thread range as: MIN MAX [STEP] (e.g., --range 1 32 or --range 2 32 2)"
    )
    parser.add_argument(
        "--threads", "-t",
        nargs="+",
        help="Explicit thread counts to test (e.g., -t 1 2 4 8 16 32)"
    )
    parser.add_argument(
        "--runs", "-r", "--repeat",
        type=int,
        default=1,
        help="Number of runs per thread count for averaging (default: 1)"
    )
    parser.add_argument(
        "--url",
        default=DEFAULT_BASE_URL,
        help=f"Base search server URL (default: {DEFAULT_BASE_URL})"
    )
    parser.add_argument(
        "--csv",
        default=DEFAULT_CSV_PATH,
        help=f"Path to save/load test results CSV (default: {DEFAULT_CSV_PATH})"
    )
    parser.add_argument(
        "--from-csv",
        help="Rebuild charts and summary from saved CSV results"
    )
    parser.add_argument(
        "--output-dir",
        default=DEFAULT_DOCS_DIR,
        help=f"Directory to save generated plots (default: {DEFAULT_DOCS_DIR})"
    )
    parser.add_argument(
        "--no-plot",
        action="store_true",
        help="Run the test and export CSV results without charts"
    )

    args = parser.parse_args()

    if args.from_csv:
        print(f"Loading saved indexing test results from: {args.from_csv}")
        results = load_indexing_csv(args.from_csv)
        runs_count = results[0].get("runs", 1) if results else 1
        print_indexing_summary(results, runs_count)
        if not args.no_plot:
            plot_indexing_charts(results, args.output_dir)
        return 0

    worker_counts = resolve_worker_counts(args.range, args.threads)
    results = run_indexing_test(args.url, worker_counts, args.runs)
    if not results:
        print("[ERROR] No indexing test runs completed successfully.", file=sys.stderr)
        return 1

    print_indexing_summary(results, args.runs)
    save_indexing_csv(results, args.csv)

    if not args.no_plot:
        plot_indexing_charts(results, args.output_dir)

    return 0


if __name__ == "__main__":
    sys.exit(main())
