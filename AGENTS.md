# Repository Guidelines

## Project Structure & Module Organization

This repository contains `second-brain-bot`, a Telegram bot implemented as a Cloudflare Worker. Main application code lives in `src/index.js`. Cloudflare and deploy helpers live in `scripts/`, database schema changes live in `migrations/`, and supporting documentation lives in `README.md` and `docs/`. Example configuration files are `.env.example`, `.dev.vars.example`, `wrangler.example.jsonc`, and `wrangler.r2.example.jsonc`; generated local config files should stay uncommitted.

## Build, Test, and Development Commands

- `npm install` installs Wrangler and project dependencies.
- `npm run dev` starts `wrangler dev` for local Worker development.
- `npm run config:render` renders local Wrangler config from `.env`.
- `npm run db:migrate:local` applies D1 migrations to the local database.
- `npm run db:migrate:remote` applies D1 migrations to the remote D1 database.
- `npm run deploy` deploys with Wrangler.
- `npm run deploy:direct` deploys through the direct API helper if Wrangler deploy hangs.

There is no automated test script yet. Before shipping, run the Worker locally, exercise relevant Telegram command handlers, and verify `GET /health`.

## Coding Style & Naming Conventions

Use modern ESM JavaScript with two-space indentation, semicolons, `const`/`let`, and `async`/`await`. Keep handler functions small enough to follow, but prefer existing single-file organization unless a change clearly needs extraction. Constants use `UPPER_SNAKE_CASE`, command/type identifiers use lowercase strings, and helper functions use descriptive camelCase names such as `handleTextMessage` or `saveTaskItem`.

## Testing Guidelines

For database changes, add a numbered migration in `migrations/` using the existing `000N_description.sql` pattern, then run `npm run db:migrate:local`. For bot behavior, test the exact commands touched, for example `/search query`, `/remind when + text`, or `/allow telegram_id [note]`. For deployments, check Worker logs and confirm the Telegram webhook still returns `{ "ok": true }`.

## Commit & Pull Request Guidelines

Recent commits use short, imperative, capitalized subjects, for example `Translate documentation to Russian` or `Add Telegram access allowlist commands`. Keep commits focused and mention user-visible behavior when relevant. Pull requests should include a concise summary, affected commands or migrations, required secrets/config changes, and manual verification notes. Include screenshots only for UI-visible Telegram output changes.

## Security & Configuration Tips

Never commit real tokens, account IDs, generated Wrangler config, or `.dev.vars`. Store `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OWNER_TELEGRAM_ID`, Tavily, and OpenRouter values in Cloudflare Secrets or local ignored env files. Rotate any secret that appears in logs or chat.
