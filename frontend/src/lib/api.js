const configuredApiUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";
export const API_BASE_URL = configuredApiUrl.replace(/\/+$/, "");

const apiAddress = new URL(API_BASE_URL);
const socketProtocol = apiAddress.protocol === "https:" ? "wss:" : "ws:";
export const SEARCH_SOCKET_URL =
  import.meta.env.VITE_SEARCH_WS_URL ||
  `${socketProtocol}//${apiAddress.host}/ws/search`;

async function readJson(response) {
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }

  return response.json();
}

export async function getHealth() {
  return readJson(await fetch(`${API_BASE_URL}/api/health`, { cache: "no-store" }));
}

export async function getStats() {
  return readJson(await fetch(`${API_BASE_URL}/api/stats`, { cache: "no-store" }));
}

export async function buildIndex(threads) {
  const response = await fetch(`${API_BASE_URL}/api/index`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threads }),
  });

  return readJson(response);
}
