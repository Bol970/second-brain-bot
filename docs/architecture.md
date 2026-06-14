# Architecture Notes

## Capture Flow

1. Telegram sends an update to `/telegram/webhook`.
2. Worker validates `X-Telegram-Bot-Api-Secret-Token`.
3. Worker checks that the sender matches `OWNER_TELEGRAM_ID`.
4. Text is classified as save/search/command. Links go through Tavily Extract. Explicit web-search requests go through Tavily Search.
5. OpenRouter enriches saved content with title, summary, type, tags, entities, reminder dates, and importance.
6. D1 stores the searchable record. R2 stores media.
7. The bot replies in Telegram with the saved item ID or an answer.

## Item Types

- `thought` - free-form thoughts and notes.
- `link` - pages saved from URLs.
- `movie` - films, series, documentaries, and watch ideas.
- `recipe` - recipes and cooking ideas.
- `image` - photos with optional captions.
- `book` - books and articles to read.
- `place` - places to visit.
- `task` - follow-up actions.
- `quote` - quotes.
- `other` - fallback.

## Search Strategy

Default search is hybrid without a separate vector database:

1. Parse the user query into keywords and likely item types.
2. Search D1 text fields and tags with bounded `LIKE` patterns.
3. Pull matching chunks for context.
4. Ask OpenRouter to answer using only the retrieved items.

The bot does not browse the internet for ordinary questions. If the local D1 search has no match, it suggests an explicit internet search instead. Internet search runs only when the message says something like "поищи в интернете" or uses `/web`.

This avoids Cloudflare Vectorize and embedding costs at the start. A later upgrade can add Vectorize when semantic search becomes necessary.

## Raw Extract Strategy

Linked pages keep long `raw_content` by default, bounded by a Worker/D1 safety cap. Search uses a smaller `search_text` projection and fixed-size chunks, so large raw extracts do not have to be scanned in full for every question.

If a saved page becomes too heavy, `/compact id` removes only `raw_content`. The record keeps its title, body, summary, tags, and chunks, so it remains searchable and useful for answers.

## Tasks And Reminders

Tasks are normal `items` with type `task`, plus a row in `reminders` for status and optional `due_at`.

- `/task` saves a pending task with no due date.
- `/remind` asks for a due date if it cannot extract one.
- `/reminders` lists active tasks and reminders.
- `/done` marks a task/reminder as done.

The Worker includes a `scheduled` handler that sends due reminders and marks them as sent. A Cloudflare cron trigger can call it every few minutes.

## Media Strategy

For Telegram photos, Telegram already gives multiple resized variants. The bot chooses the largest variant below the configured target size instead of storing the full original. On Cloudflare it then tries an image transformation with `cf.image` before saving to R2.

R2 setup values are local deployment configuration:

- bucket: `R2_BUCKET_NAME`
- Worker binding: `MEDIA`
- D1 stores only the R2 key and attachment metadata.

Default target:

- max dimension: 1280 px
- JPEG quality hint: 82
- max accepted media bytes: 8 MB

Documents are stored only if they are image-like and below the configured size cap.

## Decisions

- Ordinary questions search only saved data.
- Explicit internet search is allowed through Tavily Search.
- Ambiguous saves can ask a clarifying question.
- Tasks/reminders live in the same bot.
- Long raw extracts are kept by default and compacted only on request.
- R2 media storage is enabled, but it should be monitored because R2 is metered after included free usage.
