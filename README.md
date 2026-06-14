# Second Brain Telegram Bot

Telegram bot on Cloudflare Workers with D1 and optional R2 media storage. It stores thoughts, links, films, recipes, tasks, reminders, and images, enriches links with Tavily Extract, and uses OpenRouter for classification, summaries, tags, and answer generation.

## Current Architecture

- Worker handles the Telegram webhook and only accepts messages from `OWNER_TELEGRAM_ID`.
- D1 stores items, tags, chunks, reminders/tasks, attachments metadata, and interaction logs.
- R2 stores media bytes. D1 stores only the R2 key and metadata.
- Tavily Extract reads linked pages and returns clean page content. Tavily Search is used only when you explicitly ask for web search.
- OpenRouter is optional but recommended. It classifies notes, extracts task dates, prepares summaries/tags, and answers from retrieved context. Without it, the bot uses simple heuristics.
- Images are kept under control by choosing Telegram's resized photo variant first. On Cloudflare, the Worker also tries `cf.image` resizing before writing to R2; if that fails, it stores the selected Telegram variant.

## Deployment Values

This repository is safe to keep public: real tokens are not committed, and account-specific deployment values should live in local environment variables or ignored local config files.

- Worker URL: `TELEGRAM_WEBHOOK_URL`
- Telegram webhook path: `/telegram/webhook`
- D1 database ID: `D1_DATABASE_ID`
- R2 bucket name: `R2_BUCKET_NAME`
- Worker R2 binding: `MEDIA`
- OpenRouter enrichment is active when `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are set as Cloudflare Secrets.

## Cloudflare Fit

- Workers Free is enough for a private Telegram webhook if usage stays below typical personal limits.
- D1 Free is enough for text notes and extracted pages if this stays a private bot. Raw page extracts are kept by default up to the Worker safety cap, and `/compact` can later remove raw text while keeping summary/chunks.
- R2 is the right place for images and documents, but it is a metered product with included free monthly usage. Keep an eye on R2 usage if images become heavy.
- Cloudflare Images Free can help transform images, but the MVP does not depend on paid Images storage.

## Bot Commands

- `/start` or `/help` - short usage hint.
- `/recent` - latest saved items.
- `/stats` - storage counters.
- `/search query` - search saved notes.
- `/ask question` - answer from saved notes.
- `/movie title` - save a film or series recommendation.
- `/recipe text` - save a recipe.
- `/note text` - save a thought.
- `/task text` - save a task.
- `/remind when + text` - save a reminder/task with a due date.
- `/reminders` - list active tasks and reminders.
- `/done item_id_prefix` - mark a task/reminder done.
- `/web query` - explicit internet search through Tavily Search.
- `/compact item_id_prefix` - delete a saved link's long raw extract while keeping summary/chunks.
- `/delete item_id_prefix` - archive an item.

Natural language also works. Send a plain thought to save it. Send a URL to extract and save the page. Ask things like "что посмотреть сегодня вечером" to search only through saved films and recommendations. The bot searches the web only when the request explicitly says to search the internet, or when you use `/web`.

## Setup With Wrangler

Install Node.js and run:

```bash
npm install
```

Create resources:

```bash
npx wrangler d1 create second_brain
npx wrangler r2 bucket create "$R2_BUCKET_NAME"
```

If R2 is not enabled on the Cloudflare account yet, deploy with `wrangler.jsonc` first. After R2 is enabled and the bucket exists, deploy with `wrangler.r2.jsonc`.

Create local config from environment variables:

```bash
cp .env.example .env
# Fill .env. The scripts load it automatically.
npm run config:render
```

The generated `wrangler.jsonc` and `wrangler.r2.jsonc` files are ignored by git.

Run migrations:

```bash
npx wrangler d1 migrations apply second_brain --remote
```

Set secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put OWNER_TELEGRAM_ID
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put OPENROUTER_MODEL
```

Deploy D1-only:

```bash
npx wrangler deploy
```

Deploy with R2:

```bash
npx wrangler r2 bucket create "$R2_BUCKET_NAME"
npx wrangler deploy --config wrangler.r2.jsonc
```

If Wrangler deploy hangs in your environment, use the direct API deploy script:

```bash
npm run deploy:direct
```

Set Telegram webhook:

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "content-type: application/json" \
  -d "{\"url\":\"$TELEGRAM_WEBHOOK_URL\",\"secret_token\":\"$TELEGRAM_WEBHOOK_SECRET\"}"
```

## Important Security Note

Do not commit real API keys. Use Cloudflare Secrets for bot tokens, Tavily, and OpenRouter. If a token was pasted into a chat or log, rotate it after setup.
