#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const { performance } = require("node:perf_hooks");

const DEFAULT_SEARCH_URL = "http://localhost:8080/api/search";
const DEFAULT_STATS_URL = "http://localhost:8080/api/stats";

function showHelp() {
  console.log(`CLI client for search in the product catalog

Usage: node cli-client/search.js [query] [options]

Options:
  -k, --top <number>       Number of results to return (default: 5)
      --url <url>          Search endpoint (default: ${DEFAULT_SEARCH_URL})
      --stats-url <url>    Stats endpoint (default: ${DEFAULT_STATS_URL})
  -r, --raw, --show-raw    Display full raw product JSON
  -h, --help               Show this help

Each query is always expanded with Ollama before the catalog search.
Omit query to start interactive search mode.
`);
}

function parseArgs(argv) {
  const options = {
    top: 5,
    url: DEFAULT_SEARCH_URL,
    statsUrl: DEFAULT_STATS_URL,
    showRaw: false,
    query: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const [option, inlineValue] = argv[index].split(/=(.*)/s, 2);
    const readValue = () => {
      const value = inlineValue ?? argv[++index];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`Option ${option} requires a value.`);
      }
      return value;
    };

    switch (option) {
      case "--top":
      case "-k": {
        const value = Number(readValue());
        if (!Number.isInteger(value)) {
          throw new Error(`Invalid integer for ${option}.`);
        }
        options.top = value;
        break;
      }
      case "--url":
        options.url = readValue();
        break;
      case "--stats-url":
        options.statsUrl = readValue();
        break;
      case "--show-raw":
      case "--raw":
      case "-r":
        options.showRaw = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--":
        options.query.push(...argv.slice(index + 1));
        index = argv.length;
        break;
      default:
        if (option.startsWith("-")) {
          throw new Error(`Unknown option: ${option}`);
        }
        options.query.push(argv[index]);
    }
  }

  return options;
}

async function requestJson(url, { method = "GET", payload, timeoutMs = 5000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }

  return JSON.parse(body);
}

async function checkIndexStatus(statsUrl) {
  try {
    const data = await requestJson(statsUrl);
    return [true, Number(data.documents) || 0];
  } catch {
    return [false, 0];
  }
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) {
    return milliseconds < 10
      ? `${milliseconds.toFixed(1)} ms`
      : `${Math.round(milliseconds)} ms`;
  }
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

async function runSearch(serverUrl, query, top) {
  const startedAt = performance.now();
  const data = await requestJson(serverUrl, {
    method: "POST",
    payload: { query, top },
    timeoutMs: 30000,
  });
  return [data, performance.now() - startedAt];
}

function printResults(data, query, totalTimeMs, showRaw) {
  const results = Array.isArray(data.results) ? data.results : [];
  const searchTime = data.time_ms ?? "?";
  const synonyms = data.synonyms;

  console.log(`\n${"-".repeat(60)}`);
  console.log(`Search results for: "${query}"`);
  if (totalTimeMs !== undefined) {
    console.log(`Found: ${results.length} | Search: ${searchTime} ms | Total: ${formatDuration(totalTimeMs)}`);
  } else {
    console.log(`Found: ${results.length} | Search: ${searchTime} ms`);
  }
  if (Array.isArray(synonyms) && synonyms.length > 0) {
    console.log(`Synonyms (Ollama): ${synonyms.join(", ")}`);
  }
  console.log("-".repeat(60));

  if (results.length === 0) {
    console.log("No results found for this query.\n");
    return;
  }

  results.forEach((item, index) => {
    const title = item.snippet || "(No product title)";
    const score = Number(item.score) || 0;
    const docId = item.doc_id ?? "?";
    console.log(`${String(index + 1).padStart(2)}. [${score.toFixed(1).padStart(5)}] ${title}`);
    console.log(`     Document ID: ${docId}`);

    if (showRaw && item.raw) {
      console.log("     Raw Document Data:");
      for (const line of JSON.stringify(item.raw, null, 2).split("\n")) {
        console.log(`       ${line}`);
      }
    }
    console.log();
  });
}

async function executeSingleSearch(url, query, top, showRaw = false) {
  try {
    const [data, totalMs] = await runSearch(url, query, top);
    printResults(data, query, totalMs, showRaw);
    return 0;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error("[ERROR] Server returned invalid JSON.");
    } else {
      console.error(`[ERROR] Failed to connect to server (${url}): ${error.message}`);
    }
    return 1;
  }
}

async function interactiveMode(url, top, showRaw = false) {
  let currentShowRaw = showRaw;
  let currentTop = top;
  let interrupted = false;
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  input.on("SIGINT", () => {
    interrupted = true;
    console.log("\nExiting search.");
    input.close();
  });
  const lines = input[Symbol.asyncIterator]();

  console.log("=".repeat(65));
  console.log("                INTERACTIVE SEARCH MODE (CLI)");
  console.log(`  Top: ${currentTop} | Show Raw Data: ${currentShowRaw ? "ON" : "OFF"}`);
  console.log("  Commands:");
  console.log("    :top <N>  / :k <N> - set number of results (e.g. :top 10)");
  console.log("    :raw               - toggle raw data display (ON/OFF)");
  console.log("    q / exit           - quit");
  console.log(`${"=".repeat(65)}\n`);

  while (true) {
    const rawIndicator = currentShowRaw ? "+raw" : "";
    const promptOptions = `${rawIndicator ? `${rawIndicator}, ` : ""}top ${currentTop}`;
    process.stdout.write(`Search [${promptOptions}] > `);

    let line;
    try {
      const next = await lines.next();
      if (next.done) {
        if (!interrupted) {
          console.log("\nExiting search.");
        }
        break;
      }
      line = next.value.trim();
    } catch {
      console.log("\nExiting search.");
      break;
    }

    if (!line) {
      continue;
    }

    const command = line.toLowerCase();
    if (["q", "quit", "exit"].includes(command)) {
      console.log("Exiting search.");
      break;
    }
    if ([":raw", ":show_raw", ":show-raw"].includes(command)) {
      currentShowRaw = !currentShowRaw;
      console.log(`Raw data display: ${currentShowRaw ? "ON" : "OFF"}\n`);
      continue;
    }
    if (command.startsWith(":top") || command.startsWith(":k")) {
      const parts = line.split(/\s+/);
      if (parts.length === 2 && /^\d+$/.test(parts[1]) && Number(parts[1]) > 0) {
        currentTop = Number(parts[1]);
        console.log(`Results limit set to: ${currentTop}\n`);
      } else {
        console.log("Usage: :top <number> (e.g. :top 10)\n");
      }
      continue;
    }

    await executeSingleSearch(url, line, currentTop, currentShowRaw);
  }

  input.close();
  return 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    console.error("Use --help to see available options.");
    return 2;
  }

  if (options.help) {
    showHelp();
    return 0;
  }

  const [serverOk, documentCount] = await checkIndexStatus(options.statsUrl);
  if (!serverOk) {
    console.error(`[WARNING] Failed to check index status at ${options.statsUrl}. Make sure backend is running.`);
  } else if (documentCount === 0) {
    console.log("[WARNING] Index in server memory is empty (0 documents).");
    console.log("  Search will yield empty results. Build the index first:");
    console.log("  node cli-client/index.js --threads 8\n");
  }

  if (options.query.length > 0) {
    return executeSingleSearch(
      options.url,
      options.query.join(" "),
      options.top,
      options.showRaw,
    );
  }

  return interactiveMode(options.url, options.top, options.showRaw);
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exitCode = 1;
  });
