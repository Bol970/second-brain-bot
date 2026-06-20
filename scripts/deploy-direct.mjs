import { readFile } from "node:fs/promises";
import { loadDotEnv } from "./load-env.mjs";

await loadDotEnv();

// In sandboxed/proxied environments global fetch (undici) ignores HTTPS_PROXY,
// which makes API calls hang. Route them through the proxy when one is set.
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
if (proxyUrl) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch {
    // undici not available; fall back to direct connection
  }
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const scriptName = process.env.WORKER_NAME || "second-brain-bot";
const compatibilityDate = process.env.WORKER_COMPATIBILITY_DATE || "2026-06-14";
const botDisplayName = process.env.BOT_DISPLAY_NAME || "Second Brain";
const databaseId = process.env.D1_DATABASE_ID;
const r2BucketName = process.env.R2_BUCKET_NAME || "";

if (!accountId || !apiToken) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
}

if (!databaseId) {
  throw new Error("D1_DATABASE_ID is required");
}

const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const headers = {
  Authorization: `Bearer ${apiToken}`
};

const workerSource = await readFile("src/index.js");
const bindings = [
  { type: "d1", name: "DB", id: databaseId },
  { type: "plain_text", name: "BOT_DISPLAY_NAME", text: botDisplayName }
];

if (r2BucketName) {
  bindings.splice(1, 0, { type: "r2_bucket", name: "MEDIA", bucket_name: r2BucketName });
}

const metadata = {
  main_module: "index.js",
  compatibility_date: compatibilityDate,
  bindings,
  annotations: {
    "workers/message": r2BucketName ? "Second brain bot upload with R2" : "Second brain bot upload"
  }
};

const form = new FormData();
form.append("metadata", JSON.stringify(metadata));
form.append(
  "index.js",
  new Blob([workerSource], { type: "application/javascript+module" }),
  "index.js"
);

await cfFetch(`${apiBase}/workers/scripts/${scriptName}/content`, {
  method: "PUT",
  headers,
  body: form
});

console.log(`uploaded ${scriptName}`);

const accountSubdomain = await getAccountSubdomain();
if (accountSubdomain) {
  await cfFetch(`${apiBase}/workers/scripts/${scriptName}/subdomain`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Cloudflare-Workers-Script-Api-Date": "2025-08-01"
    },
    body: JSON.stringify({ enabled: true, previews_enabled: true })
  });
  console.log(`workers_dev_url=https://${scriptName}.${accountSubdomain}.workers.dev`);
} else {
  console.log("workers_dev_url=missing-account-subdomain");
}

async function getAccountSubdomain() {
  const response = await fetch(`${apiBase}/workers/subdomain`, { headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    console.log("account_subdomain=not_configured");
    return "";
  }
  return data.result?.subdomain || "";
}

async function cfFetch(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!response.ok || data.success === false) {
      const message = data.errors?.map((error) => `${error.code}: ${error.message}`).join("; ") || text;
      throw new Error(`Cloudflare API failed ${response.status}: ${message}`);
    }
    return data.result;
  } finally {
    clearTimeout(timeout);
  }
}
