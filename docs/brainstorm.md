# Product Brainstorm

## Core Promise

The bot should feel like a frictionless inbox for memory. The main rule: if sending something takes more than a few seconds, the system is too heavy.

## Capture Modes

- Plain text: save as `thought`.
- Intent phrases: "запиши мысль", "сохрани", "добавь" remove the command words and save the useful text.
- Watch ideas: "интересный фильм", "/movie", "запиши что посмотреть" save as `movie`.
- Recipes: "/recipe" or recipe-like words save as `recipe`.
- Links: Tavily extracts page content; D1 stores URL, summary, tags, chunks, and long raw content.
- Photos: R2 stores media; D1 stores captions, tags, dimensions, file sizes, and R2 keys.
- Questions: "что посмотреть сегодня вечером", "найди рецепт..." search the database and answer from saved items.
- Explicit web search: "поищи в интернете..." or `/web` uses Tavily Search without silently mixing web results into personal-memory answers.
- Tasks/reminders: `/task`, `/remind`, `/reminders`, and `/done` keep follow-up actions in the same bot.

## Storage Decisions

- D1 is the source of truth for metadata, tags, searchable text, chunks, and item state.
- R2 is the source of truth for binary media.
- Long web pages keep raw extracts by default up to the Worker/D1 safety cap and are chunked for search.
- `/compact id` removes raw extract text only when requested, leaving summary/chunks/search fields.
- Tags are normalized into a separate table so later UI/filtering stays easy.
- Interactions are logged lightly for debugging and future personalization.

## Search Decisions

Start with D1 hybrid lexical search:

- infer likely item types from the query;
- tokenize query into short bounded tokens;
- search `search_text` and tags;
- rerank by title, summary, tags, body, importance, and type match;
- use OpenRouter to compose an answer from retrieved items.

Future upgrade:

- add Cloudflare Vectorize and an embedding model when the saved archive grows beyond what lexical/tag search handles well.

## Decided Behavior

- Local questions search only the saved database.
- If there is no local match, the bot offers internet search instead of doing it automatically.
- Ambiguous capture can ask a clarifying question.
- Long raw extracts are kept until a manual compact command.

## Media Decisions

Cloudflare Workers cannot run heavy native image libraries like Sharp. The practical free-tier strategy is:

- choose Telegram's already-resized photo variant;
- cap media at 8 MB by default;
- try Cloudflare `cf.image` transform before saving to R2;
- store only metadata and R2 keys in D1.
- monitor R2 because it is metered beyond included free monthly usage.

## Open Questions

1. Do you want a private web UI for browsing, editing, merging tags, and deleting items?
2. Should images be kept forever, or should the bot offer an automatic "keep compressed only" policy?
3. Should reminders use a 5-minute, 15-minute, or hourly cron cadence?
