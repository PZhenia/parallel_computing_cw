#!/usr/bin/env node
"use strict";

const DEFAULT_BASE_URL = "http://localhost:8080";

function showHelp() {
  console.log(`CLI client for building and inspecting the search index

Usage: node cli-client/index.js [options]

Options:
  -t, --threads <number>  Number of worker threads (default: 8)
  -s, --status             Check server and index status
      --url <url>          Base search server URL (default: ${DEFAULT_BASE_URL})
  -h, --help               Show this help
`);
}

function parseArgs(argv) {
  const options = { threads: 8, status: false, url: DEFAULT_BASE_URL };

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
      case "--threads":
      case "-t": {
        const value = Number(readValue());
        if (!Number.isInteger(value)) {
          throw new Error(`Invalid integer for ${option}.`);
        }
        options.threads = value;
        break;
      }
      case "--status":
      case "-s":
        options.status = true;
        break;
      case "--url":
        options.url = readValue();
        break;
      case "--benchmark":
      case "-b":
        options.benchmark = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  return options;
}

async function makeRequest(url, { method = "GET", payload, timeoutMs = 600000 } = {}) {
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

function getBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

async function getHealth(baseUrl) {
  return makeRequest(`${baseUrl}/api/health`, { timeoutMs: 5000 });
}

async function getStats(baseUrl) {
  return makeRequest(`${baseUrl}/api/stats`, { timeoutMs: 5000 });
}

async function buildIndex(baseUrl, threads) {
  return makeRequest(`${baseUrl}/api/index`, {
    method: "POST",
    payload: { threads },
  });
}

async function showStatus(baseUrl) {
  console.log(`Checking server status (${baseUrl})...`);

  try {
    const health = await getHealth(baseUrl);
    const ollamaStatus = health.ollama ? "Ready" : "Disabled / unreachable";
    console.log("  Server: Online");
    console.log(`  Ollama (LLM): ${ollamaStatus}`);
  } catch (error) {
    console.log(`  [ERROR] Server unreachable: ${error.message}`);
    return false;
  }

  try {
    const stats = await getStats(baseUrl);
    const documents = Number(stats.documents) || 0;
    const timeMs = Number(stats.index_build_time_ms) || 0;
    const threads = Number(stats.threads_used) || 0;

    if (documents > 0) {
      console.log(`  Index: Built (${documents.toLocaleString("en-US")} documents)`);
      console.log(`  Last build time: ${timeMs} ms (${(timeMs / 1000).toFixed(2)} s)`);
      console.log(`  Worker threads used: ${threads}`);
    } else {
      console.log("  Index: Empty (0 documents). Build required.");
    }
  } catch (error) {
    console.log(`  [ERROR] Failed to retrieve statistics: ${error.message}`);
    return false;
  }

  return true;
}

async function runSingleBuild(baseUrl, threads) {
  console.log(`Connecting to ${baseUrl}...`);

  try {
    await getHealth(baseUrl);
  } catch (error) {
    console.error(`[ERROR] Server unreachable at ${baseUrl}: ${error.message}`);
    return 1;
  }

  console.log(`\nStarting index build with ${threads} threads...`);

  let result;
  try {
    result = await buildIndex(baseUrl, threads);
  } catch (error) {
    console.error(`\n[ERROR] Failed to build index: ${error.message}`);
    return 1;
  }

  const documents = Number(result.documents_indexed) || 0;
  const timeMs = Number(result.time_ms) || 0;

  console.log("\n[SUCCESS] Index built successfully!");
  console.log(`  Documents indexed : ${documents.toLocaleString("en-US")}`);
  console.log(`  Worker threads    : ${threads}`);
  console.log(`  Build time        : ${timeMs} ms (${(timeMs / 1000).toFixed(2)} s)`);
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

  if (options.benchmark) {
    console.log("[INFO] Indexing performance tests are in: tests/indexing_performance.py");
    console.log("Run the dedicated test script:");
    console.log("  python tests/indexing_performance.py --range 1 32 --runs 3");
    return 0;
  }

  const baseUrl = getBaseUrl(options.url);
  if (options.status) {
    return (await showStatus(baseUrl)) ? 0 : 1;
  }

  return runSingleBuild(baseUrl, options.threads);
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exitCode = 1;
  });
