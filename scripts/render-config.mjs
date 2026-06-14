import { writeFile } from "node:fs/promises";
import { loadDotEnv } from "./load-env.mjs";

await loadDotEnv();

const workerName = required("WORKER_NAME", "second-brain-bot");
const compatibilityDate = required("WORKER_COMPATIBILITY_DATE", "2026-06-14");
const botDisplayName = required("BOT_DISPLAY_NAME", "Second Brain");
const databaseId = required("D1_DATABASE_ID");
const r2BucketName = process.env.R2_BUCKET_NAME || "";

const baseConfig = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: workerName,
  main: "src/index.js",
  compatibility_date: compatibilityDate,
  workers_dev: true,
  preview_urls: true,
  observability: {
    enabled: true
  },
  triggers: {
    crons: ["*/15 * * * *"]
  },
  vars: {
    BOT_DISPLAY_NAME: botDisplayName
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: "second_brain",
      database_id: databaseId
    }
  ]
};

await writeFile("wrangler.jsonc", `${JSON.stringify(baseConfig, null, 2)}\n`);

if (r2BucketName) {
  const r2Config = {
    ...baseConfig,
    r2_buckets: [
      {
        binding: "MEDIA",
        bucket_name: r2BucketName
      }
    ]
  };
  await writeFile("wrangler.r2.jsonc", `${JSON.stringify(r2Config, null, 2)}\n`);
}

console.log(r2BucketName ? "Rendered wrangler.jsonc and wrangler.r2.jsonc" : "Rendered wrangler.jsonc");

function required(name, fallback = "") {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}
