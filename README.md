# Telegram-бот Second Brain

Telegram-бот на Cloudflare Workers с D1 и опциональным R2-хранилищем для медиа. Сохраняет мысли, ссылки, фильмы, рецепты, задачи, напоминания и изображения. Ссылки обогащает через Tavily Extract, а OpenRouter использует для классификации, кратких описаний, тегов и генерации ответов.

## Архитектура

- Worker принимает Telegram webhook и отвечает только владельцу (`OWNER_TELEGRAM_ID`) и тем Telegram ID, которым владелец выдал доступ прямо из бота.
- D1 хранит записи, теги, чанки, задачи/напоминания, метаданные вложений и журнал взаимодействий.
- R2 хранит байты медиафайлов. В D1 попадают только ключ R2 и метаданные.
- Tavily Extract извлекает чистое содержимое страниц по ссылкам. Tavily Search срабатывает только если явно попросить искать в интернете.
- OpenRouter опционален, но рекомендован. Он классифицирует заметки, извлекает даты задач, готовит краткие описания и теги и отвечает по найденному контексту. Без него бот обходится простыми эвристиками.
- Cloudflare Workers AI и Vectorize включают RAG: текстовые chunks превращаются в embeddings и используются в `/ask` вместе с обычным поиском.
- Open Library обогащает книги по `/book`, а TMDB обогащает фильмы по `/movie`, если задан ключ.
- Размер изображений бот старается держать в узде: сначала берёт уже уменьшенный Telegram-вариант фото. На Worker он ещё пробует resize через `cf.image` перед записью в R2, а если не вышло — сохраняет выбранный Telegram-вариант.

## Значения для деплоя

Репозиторий можно держать публичным: реальные токены не коммитятся, а значения, привязанные к конкретному аккаунту, должны лежать в локальных env-переменных или игнорируемых локальных конфигах.

- URL Worker: `TELEGRAM_WEBHOOK_URL`
- Путь Telegram webhook: `/telegram/webhook`
- ID D1 database: `D1_DATABASE_ID`
- Имя R2 bucket: `R2_BUCKET_NAME`
- R2 binding для Worker: `MEDIA`
- Имя Vectorize index: `VECTOR_INDEX_NAME`
- Open Library contact email для User-Agent: `OPENLIBRARY_CONTACT_EMAIL`
- TMDB: `TMDB_API_KEY` или `TMDB_API_TOKEN`
- OpenRouter включается, когда `OPENROUTER_API_KEY` и `OPENROUTER_MODEL` заданы как Cloudflare Secrets.

## Как это ложится на Cloudflare

- Workers Free хватает для приватного Telegram webhook, пока личное использование в обычных пределах.
- D1 Free хватает для текстовых заметок и извлечённых страниц в личном боте. Raw extracts по умолчанию сохраняются до защитного лимита Worker, а `/compact` потом может удалить raw text, оставив summary/chunks.
- R2 хорошо подходит для изображений и документов, но он платный сверх бесплатного месячного лимита. Если картинок станет много, за расходом R2 стоит следить.
- Cloudflare Images Free может помочь с трансформацией изображений, но MVP без платного Cloudflare Images работает.

## Команды бота

- `/start` или `/help` - короткая подсказка.
- `/recent` - последние сохранённые записи.
- `/stats` - счётчики хранилища.
- `/search query` - поиск по сохранённым заметкам.
- `/ask question` - ответ по сохранённым заметкам через гибридный поиск; при наличии Vectorize добавляется RAG.
- `/movie title` - найти фильм в TMDB и сохранить; без ключа сохраняет как обычную запись.
- `/book title` - найти книгу в Open Library и сохранить.
- `/recipe text` - сохранить рецепт.
- `/note text` - сохранить мысль.
- `/task text` - сохранить задачу.
- `/remind when + text` - сохранить задачу/напоминание с датой.
- `/reminders` - список активных задач и напоминаний.
- `/done item_id_prefix` - отметить задачу/напоминание выполненным.
- `/id` - показать твой Telegram ID.
- `/allow telegram_id [note]` - выдать доступ другому Telegram-пользователю. Только владелец.
- `/deny telegram_id` - отозвать доступ. Только владелец.
- `/access` - список пользователей с доступом. Только владелец.
- `/web query` - явный интернет-поиск через Tavily Search.
- `/rag status` - состояние RAG-индекса.
- `/rag reindex [число]` - доиндексировать старые chunks в Vectorize.
- `/compact item_id_prefix` - удалить длинный raw extract у сохранённой ссылки, оставив summary/chunks.
- `/delete item_id_prefix` - архивировать запись.

Естественный язык тоже работает. Отправь обычную мысль — бот её сохранит. Отправь URL — бот извлечёт и сохранит страницу. Спроси «что посмотреть сегодня вечером» — бот поищет только по сохранённым фильмам и рекомендациям. В интернет он полезет, только если прямо попросить или использовать `/web`.

## Настройка через Wrangler

Установи Node.js 20+ и запусти:

```bash
npm install
```

Создай ресурсы:

```bash
npx wrangler d1 create second_brain
npx wrangler r2 bucket create "$R2_BUCKET_NAME"
npx wrangler vectorize create "$VECTOR_INDEX_NAME" --dimensions=768 --metric=cosine
```

Если R2 ещё не включён в аккаунте Cloudflare, сначала деплой через `wrangler.jsonc`. После включения R2 и создания bucket можно деплоить через `wrangler.r2.jsonc`.

Создай локальный конфиг из env-переменных:

```bash
cp .env.example .env
# Заполни .env. Скрипты загрузят его автоматически.
npm run config:render
```

Сгенерированные `wrangler.jsonc` и `wrangler.r2.jsonc` игнорируются git.

Примени миграции:

```bash
npx wrangler d1 migrations apply second_brain --remote
```

Задай secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put OWNER_TELEGRAM_ID
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put OPENROUTER_MODEL
npx wrangler secret put TMDB_API_KEY
```

Если используешь TMDB read access token вместо v3 API key, сохрани его как `TMDB_API_TOKEN`.

Деплой только с D1:

```bash
npx wrangler deploy
```

Деплой с R2:

```bash
npx wrangler r2 bucket create "$R2_BUCKET_NAME"
npx wrangler deploy --config wrangler.r2.jsonc
```

Если `wrangler deploy` зависает в твоём окружении, используй скрипт прямого деплоя через API:

```bash
npm run deploy:direct
```

Настрой Telegram webhook:

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "content-type: application/json" \
  -d "{\"url\":\"$TELEGRAM_WEBHOOK_URL\",\"secret_token\":\"$TELEGRAM_WEBHOOK_SECRET\"}"
```

## Безопасность

Не коммить реальные API-ключи. Telegram bot token, Tavily, OpenRouter и TMDB держи в Cloudflare Secrets. Если токен где-то засветился в чате или логе — перевыпусти его.
