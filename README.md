# Telegram-Бот Second Brain

Telegram-бот на Cloudflare Workers с D1 и опциональным R2-хранилищем для медиа. Он сохраняет мысли, ссылки, фильмы, рецепты, задачи, напоминания и изображения, обогащает ссылки через Tavily Extract и использует OpenRouter для классификации, кратких описаний, тегов и генерации ответов.

## Текущая Архитектура

- Worker принимает Telegram webhook и обрабатывает сообщения только от `OWNER_TELEGRAM_ID` и разрешённых Telegram ID.
- D1 хранит записи, теги, чанки, задачи/напоминания, метаданные вложений и журнал взаимодействий.
- Доступ ограничен через `OWNER_TELEGRAM_ID`; владелец может добавлять и удалять дополнительные Telegram ID прямо из бота.
- R2 хранит байты медиафайлов. В D1 сохраняются только ключ R2 и метаданные.
- Tavily Extract извлекает чистое содержимое страниц по ссылкам. Tavily Search используется только по явной просьбе искать в интернете.
- OpenRouter опционален, но рекомендован. Он классифицирует заметки, извлекает даты задач, готовит краткие описания и теги, а также отвечает по найденному контексту. Без него бот использует простые эвристики.
- Изображения контролируются по размеру: бот сначала выбирает Telegram-вариант фото с уже уменьшенным размером. На Cloudflare Worker также пробует resize через `cf.image` перед записью в R2; если это не сработало, сохраняет выбранный Telegram-вариант.

## Значения Для Деплоя

Репозиторий можно держать публичным: реальные токены не коммитятся, а значения, привязанные к конкретному аккаунту, должны лежать в локальных env-переменных или игнорируемых локальных конфигах.

- URL Worker: `TELEGRAM_WEBHOOK_URL`
- Путь Telegram webhook: `/telegram/webhook`
- ID D1 database: `D1_DATABASE_ID`
- Имя R2 bucket: `R2_BUCKET_NAME`
- R2 binding для Worker: `MEDIA`
- OpenRouter включается, когда `OPENROUTER_API_KEY` и `OPENROUTER_MODEL` заданы как Cloudflare Secrets.

## Как Это Ложится На Cloudflare

- Workers Free достаточно для приватного Telegram webhook, если личное использование остаётся в обычных пределах.
- D1 Free достаточно для текстовых заметок и извлечённых страниц в личном боте. Raw extracts сохраняются по умолчанию до защитного лимита Worker, а `/compact` позже может удалить raw text, оставив summary/chunks.
- R2 хорошо подходит для изображений и документов, но это продукт с тарификацией сверх включённого бесплатного месячного лимита. Если картинок станет много, стоит следить за использованием R2.
- Cloudflare Images Free может помочь с трансформацией изображений, но MVP не зависит от платного хранилища Cloudflare Images.

## Команды Бота

- `/start` или `/help` - короткая подсказка.
- `/recent` - последние сохранённые записи.
- `/stats` - счётчики хранилища.
- `/search query` - поиск по сохранённым заметкам.
- `/ask question` - ответ по сохранённым заметкам.
- `/movie title` - сохранить фильм или сериал.
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
- `/compact item_id_prefix` - удалить длинный raw extract у сохранённой ссылки, оставив summary/chunks.
- `/delete item_id_prefix` - архивировать запись.

Естественный язык тоже работает. Можно отправить обычную мысль, и бот сохранит её. Можно отправить URL, и бот извлечёт и сохранит страницу. Можно спросить: «что посмотреть сегодня вечером» - бот будет искать только по сохранённым фильмам и рекомендациям. Интернет-поиск включается только если прямо попросить искать в интернете или использовать `/web`.

## Настройка Через Wrangler

Установи Node.js и запусти:

```bash
npm install
```

Создай ресурсы:

```bash
npx wrangler d1 create second_brain
npx wrangler r2 bucket create "$R2_BUCKET_NAME"
```

Если R2 ещё не включён на Cloudflare account, сначала деплой через `wrangler.jsonc`. После включения R2 и создания bucket можно деплоить через `wrangler.r2.jsonc`.

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
```

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

## Важное Про Безопасность

Не коммить реальные API-ключи. Используй Cloudflare Secrets для Telegram bot token, Tavily и OpenRouter. Если токен был вставлен в чат или лог, после настройки его лучше перевыпустить.
