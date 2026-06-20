const MAX_RAW_CONTENT_CHARS = 700000;
const MAX_AI_INPUT_CHARS = 14000;
const MAX_SEARCH_TEXT_CHARS = 60000;
const MAX_CHUNK_CHARS = 1200;
const MAX_CHUNKS_PER_ITEM = 24;
const MAX_VECTOR_CHUNKS_PER_BATCH = 24;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const IMAGE_TARGET_PX = 1280;
const TELEGRAM_TEXT_LIMIT = 3900;
const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const TYPE_LABELS = {
  thought: "мысль",
  link: "ссылка",
  movie: "что посмотреть",
  recipe: "рецепт",
  image: "картинка",
  book: "книга",
  place: "место",
  task: "задача",
  quote: "цитата",
  other: "запись"
};

const ALLOWED_TYPES = new Set(Object.keys(TYPE_LABELS));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return jsonResponse({
        ok: true,
        name: env.BOT_DISPLAY_NAME || "Second Brain",
        time: new Date().toISOString()
      });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processDueReminders(env));
  }
};

async function handleTelegramWebhook(request, env, ctx) {
  const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const actualSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (actualSecret !== expectedSecret) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  ctx.waitUntil(
    processTelegramUpdate(update, env).catch(async (error) => {
      console.error("telegram update failed", error);
      const chatId = getUpdateChatId(update);
      if (chatId) {
        await sendMessage(env, chatId, "Что-то пошло не так при обработке. Я уже записал ошибку в лог Worker.").catch(() => {});
      }
    })
  );

  return jsonResponse({ ok: true });
}

async function processTelegramUpdate(update, env) {
  const message = update.message || update.edited_message;
  if (!message) return;

  const chatId = String(message.chat?.id || "");
  const senderId = String(message.from?.id || "");
  const ownerId = String(env.OWNER_TELEGRAM_ID || "");

  if (!chatId || !senderId) return;

  const authorized = await isAuthorizedTelegramUser(env, ownerId, senderId);
  if (ownerId && !authorized) {
    await sendMessage(env, chatId, `Бот закрыт для личного использования.\nТвой Telegram ID: ${senderId}`);
    return;
  }

  const storageOwnerId = ownerId || senderId;
  const access = {
    actorId: senderId,
    isOwner: Boolean(ownerId && senderId === ownerId)
  };

  await logInteraction(env, storageOwnerId, message, "inbound", "telegram_message", {
    text: message.text || message.caption || "",
    has_photo: Boolean(message.photo),
    has_document: Boolean(message.document)
  });

  if (message.text) {
    await handleTextMessage(env, storageOwnerId, chatId, message, access);
    return;
  }

  if (message.photo?.length) {
    await handlePhotoMessage(env, storageOwnerId, chatId, message);
    return;
  }

  if (message.document && String(message.document.mime_type || "").startsWith("image/")) {
    await handleImageDocumentMessage(env, storageOwnerId, chatId, message);
    return;
  }

  await sendMessage(env, chatId, "Пока я умею сохранять текст, ссылки и картинки. Этот формат ещё не поддержан.");
}

async function handleTextMessage(env, ownerId, chatId, message, access = {}) {
  const text = message.text.trim();
  if (!text) return;

  const command = parseCommand(text);
  if (command) {
    await handleCommand(env, ownerId, chatId, message, command, access);
    return;
  }

  const urls = extractUrls(text);
  if (urls.length) {
    await saveLinksFromMessage(env, ownerId, chatId, message, text, urls);
    return;
  }

  const classification = await classifyText(env, text);
  if (classification.needsClarification && classification.clarifyingQuestion) {
    await sendMessage(env, chatId, classification.clarifyingQuestion);
    return;
  }

  if (classification.intent === "search") {
    await answerQuestion(env, ownerId, chatId, classification.question || text);
    return;
  }

  if (classification.type === "task") {
    await saveTaskItem(env, ownerId, chatId, message, text, {
      classification,
      forceReminder: wantsReminder(text)
    });
    return;
  }

  await saveTextItem(env, ownerId, chatId, message, text, classification);
}

async function handleCommand(env, ownerId, chatId, message, command, access = {}) {
  const name = command.name;
  const arg = command.arg.trim();

  if (name === "start" || name === "help") {
    await sendHelp(env, chatId);
    return;
  }

  if (name === "id" || name === "whoami") {
    await sendMessage(env, chatId, `Твой Telegram ID: ${access.actorId || message.from?.id || "неизвестен"}`);
    return;
  }

  if (name === "allow" || name === "adduser") {
    await addAccessUser(env, ownerId, chatId, message, arg, access);
    return;
  }

  if (name === "deny" || name === "removeuser" || name === "revoke") {
    await removeAccessUser(env, ownerId, chatId, message, arg, access);
    return;
  }

  if (name === "access" || name === "users") {
    await sendAccessUsers(env, ownerId, chatId, access);
    return;
  }

  if (name === "recent") {
    await sendRecent(env, ownerId, chatId);
    return;
  }

  if (name === "stats") {
    await sendStats(env, ownerId, chatId);
    return;
  }

  if (name === "search" || name === "find") {
    await answerQuestion(env, ownerId, chatId, arg || "покажи последние важные записи");
    return;
  }

  if (name === "ask") {
    await answerQuestion(env, ownerId, chatId, arg || "что есть в моей базе?");
    return;
  }

  if (name === "web") {
    await answerFromWeb(env, chatId, arg || "поищи в интернете полезное по моей теме");
    return;
  }

  if (name === "note") {
    await saveTextItem(env, ownerId, chatId, message, arg, {
      intent: "save",
      type: "thought",
      title: titleFromText(arg),
      body: arg,
      tags: ["мысли"]
    });
    return;
  }

  if (name === "movie") {
    await saveMovieItem(env, ownerId, chatId, message, arg);
    return;
  }

  if (name === "book") {
    await saveBookItem(env, ownerId, chatId, message, arg);
    return;
  }

  if (name === "recipe") {
    await saveTextItem(env, ownerId, chatId, message, arg, {
      intent: "save",
      type: "recipe",
      title: titleFromText(arg),
      body: arg,
      tags: ["рецепты"]
    });
    return;
  }

  if (name === "task") {
    await saveTaskItem(env, ownerId, chatId, message, arg, { forceReminder: false });
    return;
  }

  if (name === "remind") {
    await saveTaskItem(env, ownerId, chatId, message, arg, { forceReminder: true });
    return;
  }

  if (name === "reminders" || name === "tasks") {
    await sendPendingReminders(env, ownerId, chatId);
    return;
  }

  if (name === "done") {
    await completeReminderByPrefix(env, ownerId, chatId, arg);
    return;
  }

  if (name === "compact") {
    await compactItemRawContent(env, ownerId, chatId, arg);
    return;
  }

  if (name === "delete") {
    await archiveItemByPrefix(env, ownerId, chatId, arg);
    return;
  }

  if (name === "rag") {
    await handleRagCommand(env, ownerId, chatId, arg);
    return;
  }

  await sendMessage(env, chatId, "Не знаю такую команду. Напиши /help.");
}

async function sendHelp(env, chatId) {
  const text = [
    "Я готов быть твоим second brain.",
    "",
    "Кидай просто текст - сохраню как мысль.",
    "Кидай ссылку - достану содержимое через Tavily и сохраню.",
    "Кидай фото - сохраню в R2 и подпишу по caption.",
    "Спрашивай: что посмотреть сегодня вечером, где был тот рецепт, найди заметку про...",
    "",
    "Команды:",
    "/note текст - сохранить мысль",
    "/movie название - сохранить фильм или сериал",
    "/book название - найти книгу в Open Library и сохранить",
    "/recipe текст - сохранить рецепт",
    "/task текст - сохранить задачу",
    "/remind когда + что - сохранить напоминание",
    "/reminders - активные задачи и напоминания",
    "/done id - отметить задачу выполненной",
    "/id - показать твой Telegram ID",
    "/allow telegram_id [заметка] - добавить доступ",
    "/deny telegram_id - удалить доступ",
    "/access - список доступа",
    "/search запрос - поиск",
    "/ask вопрос - ответ по базе",
    "/web запрос - поискать в интернете через Tavily",
    "/recent - последние записи",
    "/stats - статистика",
    "/rag status - состояние RAG-индекса",
    "/rag reindex [число] - доиндексировать чанки",
    "/compact id - удалить raw extract у ссылки, оставить summary/chunks",
    "/delete id - архивировать запись"
  ].join("\n");

  await sendMessage(env, chatId, text);
}

async function saveLinksFromMessage(env, ownerId, chatId, message, text, urls) {
  await sendChatAction(env, chatId, "typing").catch(() => {});

  const saved = [];
  const caption = removeUrls(text).trim();
  const uniqueUrls = [...new Set(urls)].slice(0, 4);

  for (const url of uniqueUrls) {
    const extracted = await extractWithTavily(env, url);
    const rawContent = extracted.raw_content || "";
    const enrichment = await enrichLink(env, url, caption, rawContent, extracted);
    const now = new Date().toISOString();
    const raw = clampText(rawContent, MAX_RAW_CONTENT_CHARS);
    const rawWasTruncated = rawContent.length > raw.length ? 1 : 0;
    const type = ensureType(enrichment.type || inferTypeFromText(`${caption}\n${rawContent}`, "link"));
    const tags = withTypeTags(type, normalizeTags(enrichment.tags));
    const metadata = {
      favicon: extracted.favicon || null,
      tavily: extracted.meta || null,
      images: extracted.images?.slice(0, 8) || [],
      source_caption: caption || null
    };

    const item = await createItem(env, {
      ownerId,
      source: "telegram",
      telegramMessageId: message.message_id,
      telegramChatId: String(message.chat.id),
      type,
      title: enrichment.title || titleFromUrl(url),
      body: caption || "",
      summary: enrichment.summary || fallbackSummary(rawContent),
      url,
      domain: domainFromUrl(url),
      canonicalUrl: extracted.url || url,
      rawContent: raw,
      rawContentTruncated: rawWasTruncated,
      language: enrichment.language || null,
      importance: clampImportance(enrichment.importance),
      metadata,
      tags,
      capturedAt: now,
      createdAt: now
    });

    saved.push(item);
  }

  if (!saved.length) {
    await sendMessage(env, chatId, "Не получилось сохранить ссылки.");
    return;
  }

  const lines = saved.map((item) => `- ${item.title}\n  ${item.url}\n  id: ${shortId(item.id)}; теги: ${item.tags.join(", ") || "без тегов"}`);
  await sendLongMessage(env, chatId, `Сохранил ${saved.length} ссылк${saved.length === 1 ? "у" : "и"}:\n\n${lines.join("\n\n")}`);
}

async function saveTextItem(env, ownerId, chatId, message, originalText, classification) {
  const text = (classification.body || originalText || "").trim();
  if (!text) {
    await sendMessage(env, chatId, "Пришли текст после команды, и я сохраню.");
    return;
  }

  const type = ensureType(classification.type || inferTypeFromText(text, "thought"));
  const tags = withTypeTags(type, normalizeTags(classification.tags?.length ? classification.tags : heuristicTags(text, type)));
  const now = new Date().toISOString();
  const title = classification.title || titleFromText(text);
  const summary = classification.summary || (text.length > 220 ? `${text.slice(0, 217)}...` : text);

  const item = await createItem(env, {
    ownerId,
    source: "telegram",
    telegramMessageId: message.message_id,
    telegramChatId: String(message.chat.id),
    type,
    title,
    body: text,
    summary,
    language: classification.language || "ru",
    importance: clampImportance(classification.importance),
    metadata: {
      original_text: originalText,
      entities: classification.entities || [],
      classifier: classification.source || "heuristic"
    },
    tags,
    capturedAt: now,
    createdAt: now
  });

  await sendMessage(env, chatId, `Сохранил: ${item.title}\nТип: ${TYPE_LABELS[item.type] || item.type}\nid: ${shortId(item.id)}\nТеги: ${item.tags.join(", ") || "без тегов"}`);
}

async function saveBookItem(env, ownerId, chatId, message, query) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    await sendMessage(env, chatId, "Какую книгу сохранить? Например: /book Дюна");
    return;
  }

  await sendChatAction(env, chatId, "typing").catch(() => {});
  const book = await findOpenLibraryBook(env, cleanQuery);
  const now = new Date().toISOString();

  if (!book) {
    await saveTextItem(env, ownerId, chatId, message, cleanQuery, {
      intent: "save",
      type: "book",
      title: titleFromText(cleanQuery),
      body: cleanQuery,
      summary: cleanQuery,
      tags: ["книги", "прочитать"],
      language: "ru",
      importance: 0,
      source: "heuristic"
    });
    return;
  }

  const authors = book.authors.join(", ");
  const year = book.firstPublishYear ? ` (${book.firstPublishYear})` : "";
  const subjectLine = book.subjects.length ? `Темы: ${book.subjects.join(", ")}` : "";
  const body = [
    authors ? `Автор: ${authors}` : "",
    book.firstPublishYear ? `Первый год публикации: ${book.firstPublishYear}` : "",
    book.isbn ? `ISBN: ${book.isbn}` : "",
    book.openLibraryUrl ? `Open Library: ${book.openLibraryUrl}` : "",
    subjectLine
  ].filter(Boolean).join("\n");

  const item = await createItem(env, {
    ownerId,
    source: "open_library",
    telegramMessageId: message.message_id,
    telegramChatId: String(message.chat.id),
    type: "book",
    title: `${book.title}${year}`,
    body,
    summary: [book.title, authors ? `автор: ${authors}` : "", book.firstPublishYear ? `год: ${book.firstPublishYear}` : ""].filter(Boolean).join("; "),
    url: book.openLibraryUrl,
    domain: "openlibrary.org",
    canonicalUrl: book.openLibraryUrl,
    language: book.languages[0] || "ru",
    importance: 0,
    metadata: {
      provider: "open_library",
      query: cleanQuery,
      key: book.key,
      cover_url: book.coverUrl,
      authors: book.authors,
      languages: book.languages,
      subjects: book.subjects,
      isbn: book.isbn
    },
    tags: ["книги", "прочитать", ...book.subjects.slice(0, 5)],
    capturedAt: now,
    createdAt: now
  });

  const coverLine = book.coverUrl ? `\nОбложка: ${book.coverUrl}` : "";
  await sendMessage(env, chatId, `Сохранил книгу: ${item.title}\nid: ${shortId(item.id)}${authors ? `\nАвтор: ${authors}` : ""}${book.openLibraryUrl ? `\n${book.openLibraryUrl}` : ""}${coverLine}`);
}

async function saveMovieItem(env, ownerId, chatId, message, query) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    await sendMessage(env, chatId, "Какой фильм или сериал сохранить? Например: /movie Blade Runner");
    return;
  }

  await sendChatAction(env, chatId, "typing").catch(() => {});
  const movie = await findTmdbMovie(env, cleanQuery);

  if (!movie) {
    await saveTextItem(env, ownerId, chatId, message, cleanQuery, {
      intent: "save",
      type: "movie",
      title: titleFromText(cleanQuery),
      body: cleanQuery,
      summary: cleanQuery,
      tags: ["кино", "посмотреть"],
      language: "ru",
      importance: 0,
      source: env.TMDB_API_KEY || env.TMDB_API_TOKEN ? "tmdb_not_found" : "heuristic"
    });
    return;
  }

  const now = new Date().toISOString();
  const year = movie.releaseDate ? movie.releaseDate.slice(0, 4) : "";
  const genreLine = movie.genres.length ? `Жанры: ${movie.genres.join(", ")}` : "";
  const ratingLine = movie.voteAverage ? `Рейтинг TMDB: ${movie.voteAverage.toFixed(1)}` : "";
  const body = [
    movie.originalTitle && movie.originalTitle !== movie.title ? `Оригинальное название: ${movie.originalTitle}` : "",
    year ? `Год: ${year}` : "",
    genreLine,
    ratingLine,
    movie.overview ? `Описание: ${movie.overview}` : "",
    movie.tmdbUrl ? `TMDB: ${movie.tmdbUrl}` : ""
  ].filter(Boolean).join("\n");

  const item = await createItem(env, {
    ownerId,
    source: "tmdb",
    telegramMessageId: message.message_id,
    telegramChatId: String(message.chat.id),
    type: "movie",
    title: `${movie.title}${year ? ` (${year})` : ""}`,
    body,
    summary: movie.overview || body || cleanQuery,
    url: movie.tmdbUrl,
    domain: "themoviedb.org",
    canonicalUrl: movie.tmdbUrl,
    language: movie.language || "ru",
    importance: 0,
    metadata: {
      provider: "tmdb",
      query: cleanQuery,
      tmdb_id: movie.id,
      original_title: movie.originalTitle,
      release_date: movie.releaseDate,
      genres: movie.genres,
      poster_url: movie.posterUrl,
      vote_average: movie.voteAverage,
      vote_count: movie.voteCount
    },
    tags: ["кино", "посмотреть", ...movie.genres],
    capturedAt: now,
    createdAt: now
  });

  const posterLine = movie.posterUrl ? `\nПостер: ${movie.posterUrl}` : "";
  await sendMessage(env, chatId, `Сохранил фильм: ${item.title}\nid: ${shortId(item.id)}${genreLine ? `\n${genreLine}` : ""}${movie.tmdbUrl ? `\n${movie.tmdbUrl}` : ""}${posterLine}`);
}

async function saveTaskItem(env, ownerId, chatId, message, originalText, options = {}) {
  const sourceText = String(originalText || "").trim();
  if (!sourceText) {
    await sendMessage(env, chatId, options.forceReminder ? "Напиши, о чём и когда напомнить: /remind завтра 10:00 купить молоко" : "Пришли текст задачи после /task.");
    return;
  }

  const details = await parseTaskDetails(env, sourceText, options);
  if (options.forceReminder && !details.dueAt) {
    await sendMessage(env, chatId, "Когда напомнить? Например: /remind завтра в 10:00 купить молоко");
    return;
  }

  const text = details.text || sourceText;
  const now = new Date().toISOString();
  const tags = withTypeTags("task", normalizeTags(details.tags?.length ? details.tags : heuristicTags(text, "task")));
  const title = details.title || options.classification?.title || titleFromText(text);

  const item = await createItem(env, {
    ownerId,
    source: "telegram",
    telegramMessageId: message.message_id,
    telegramChatId: String(message.chat.id),
    type: "task",
    title,
    body: text,
    summary: details.summary || options.classification?.summary || text,
    language: options.classification?.language || details.language || "ru",
    importance: clampImportance(details.importance ?? options.classification?.importance),
    metadata: {
      original_text: sourceText,
      due_at: details.dueAt,
      reminder_requested: Boolean(options.forceReminder || details.reminderRequested),
      entities: options.classification?.entities || [],
      classifier: details.source || options.classification?.source || "heuristic"
    },
    tags,
    capturedAt: now,
    createdAt: now
  });

  const reminder = await createReminder(env, {
    itemId: item.id,
    ownerId,
    telegramChatId: String(message.chat.id),
    text,
    dueAt: details.dueAt,
    metadata: {
      title,
      source_text: sourceText,
      reminder_requested: Boolean(options.forceReminder || details.reminderRequested)
    }
  });

  const dueLine = reminder.dueAt ? `\nКогда: ${formatDueAt(reminder.dueAt)}` : "\nКогда: без даты";
  await sendMessage(env, chatId, `Сохранил задачу: ${item.title}\nid: ${shortId(item.id)} / ${shortId(reminder.id)}${dueLine}\nТеги: ${item.tags.join(", ") || "без тегов"}`);
}

async function handlePhotoMessage(env, ownerId, chatId, message) {
  if (!env.MEDIA) {
    await sendMessage(env, chatId, "R2 bucket не подключён, поэтому картинку пока некуда сохранить.");
    return;
  }

  await sendChatAction(env, chatId, "upload_photo").catch(() => {});

  const photo = chooseTelegramPhoto(message.photo);
  const caption = message.caption || "";
  const itemId = newId("itm");
  const attachmentId = newId("att");
  const file = await getTelegramFile(env, photo.file_id);
  const downloaded = await downloadTelegramImage(env, file.file_path);

  if (downloaded.bytes > MAX_MEDIA_BYTES) {
    await sendMessage(env, chatId, `Картинка слишком большая после обработки: ${formatBytes(downloaded.bytes)}. Лимит сейчас ${formatBytes(MAX_MEDIA_BYTES)}.`);
    return;
  }

  const key = `telegram/${ownerId}/${itemId}/${attachmentId}.jpg`;
  await env.MEDIA.put(key, downloaded.buffer, {
    httpMetadata: { contentType: downloaded.mimeType || "image/jpeg" },
    customMetadata: {
      source: "telegram",
      telegram_file_unique_id: photo.file_unique_id || "",
      transformed: String(downloaded.transformed)
    }
  });

  const classification = await classifyText(env, caption || "Фото без подписи");
  const tags = withTypeTags("image", normalizeTags(classification.tags?.length ? classification.tags : ["картинки"]));
  const now = new Date().toISOString();

  const item = await createItem(env, {
    id: itemId,
    ownerId,
    source: "telegram",
    telegramMessageId: message.message_id,
    telegramChatId: String(message.chat.id),
    type: "image",
    title: classification.title && caption ? classification.title : titleFromText(caption || "Фото"),
    body: caption,
    summary: classification.summary || caption || "Фото из Telegram",
    language: classification.language || "ru",
    importance: clampImportance(classification.importance),
    metadata: {
      telegram_photo: {
        width: photo.width,
        height: photo.height,
        file_size: photo.file_size || null
      }
    },
    tags,
    capturedAt: now,
    createdAt: now
  });

  await insertAttachment(env, {
    id: attachmentId,
    itemId: item.id,
    ownerId,
    kind: "image",
    telegramFileId: photo.file_id,
    telegramFileUniqueId: photo.file_unique_id || null,
    r2Key: key,
    mimeType: downloaded.mimeType || "image/jpeg",
    fileName: null,
    width: photo.width,
    height: photo.height,
    bytesOriginal: file.file_size || photo.file_size || null,
    bytesStored: downloaded.bytes,
    compression: {
      strategy: "telegram_variant_then_cf_image",
      target_px: IMAGE_TARGET_PX,
      transformed: downloaded.transformed
    },
    caption,
    createdAt: now
  });

  await sendMessage(env, chatId, `Сохранил картинку: ${item.title}\nid: ${shortId(item.id)}\nРазмер в R2: ${formatBytes(downloaded.bytes)}\nТеги: ${item.tags.join(", ") || "без тегов"}`);
}

async function handleImageDocumentMessage(env, ownerId, chatId, message) {
  const doc = message.document;
  if (!env.MEDIA) {
    await sendMessage(env, chatId, "R2 bucket не подключён, поэтому файл пока некуда сохранить.");
    return;
  }

  if (doc.file_size && doc.file_size > MAX_MEDIA_BYTES) {
    await sendMessage(env, chatId, `Файл слишком большой: ${formatBytes(doc.file_size)}. Лимит сейчас ${formatBytes(MAX_MEDIA_BYTES)}.`);
    return;
  }

  await sendChatAction(env, chatId, "upload_document").catch(() => {});

  const caption = message.caption || doc.file_name || "";
  const itemId = newId("itm");
  const attachmentId = newId("att");
  const file = await getTelegramFile(env, doc.file_id);
  const downloaded = await downloadTelegramImage(env, file.file_path);

  if (downloaded.bytes > MAX_MEDIA_BYTES) {
    await sendMessage(env, chatId, `Файл слишком большой после обработки: ${formatBytes(downloaded.bytes)}.`);
    return;
  }

  const ext = extensionFromMime(downloaded.mimeType || doc.mime_type) || "jpg";
  const key = `telegram/${ownerId}/${itemId}/${attachmentId}.${ext}`;
  await env.MEDIA.put(key, downloaded.buffer, {
    httpMetadata: { contentType: downloaded.mimeType || doc.mime_type || "application/octet-stream" },
    customMetadata: {
      source: "telegram_document",
      telegram_file_unique_id: doc.file_unique_id || "",
      transformed: String(downloaded.transformed)
    }
  });

  const classification = await classifyText(env, caption || "Картинка без подписи");
  const tags = withTypeTags("image", normalizeTags(classification.tags?.length ? classification.tags : ["картинки"]));
  const now = new Date().toISOString();

  const item = await createItem(env, {
    id: itemId,
    ownerId,
    source: "telegram",
    telegramMessageId: message.message_id,
    telegramChatId: String(message.chat.id),
    type: "image",
    title: classification.title && caption ? classification.title : titleFromText(caption || doc.file_name || "Картинка"),
    body: caption,
    summary: classification.summary || caption || "Картинка из Telegram",
    language: classification.language || "ru",
    importance: clampImportance(classification.importance),
    metadata: {
      telegram_document: {
        file_name: doc.file_name || null,
        mime_type: doc.mime_type || null,
        file_size: doc.file_size || null
      }
    },
    tags,
    capturedAt: now,
    createdAt: now
  });

  await insertAttachment(env, {
    id: attachmentId,
    itemId: item.id,
    ownerId,
    kind: "image",
    telegramFileId: doc.file_id,
    telegramFileUniqueId: doc.file_unique_id || null,
    r2Key: key,
    mimeType: downloaded.mimeType || doc.mime_type || null,
    fileName: doc.file_name || null,
    width: null,
    height: null,
    bytesOriginal: file.file_size || doc.file_size || null,
    bytesStored: downloaded.bytes,
    compression: {
      strategy: "cf_image_if_available",
      target_px: IMAGE_TARGET_PX,
      transformed: downloaded.transformed
    },
    caption,
    createdAt: now
  });

  await sendMessage(env, chatId, `Сохранил картинку: ${item.title}\nid: ${shortId(item.id)}\nРазмер в R2: ${formatBytes(downloaded.bytes)}`);
}

async function answerQuestion(env, ownerId, chatId, question) {
  const parsed = await parseSearchQuestion(env, question);

  if (parsed.useWeb) {
    await answerFromWeb(env, chatId, parsed.query || question);
    return;
  }

  const candidates = await searchItems(env, ownerId, parsed);

  if (!candidates.length) {
    await sendMessage(env, chatId, "В базе ничего похожего не нашёл. Если хочешь, напиши «поищи в интернете ...» или используй /web, и я поищу через Tavily.");
    return;
  }

  if (!hasOpenRouter(env)) {
    await sendLongMessage(env, chatId, `Нашёл вот что:\n\n${formatSearchResults(candidates)}`);
    return;
  }

  const context = candidates.map((item, index) => {
    const chunks = (item.chunks || []).slice(0, 3).map((chunk) => `- ${chunk}`).join("\n");
    return [
      `#${index + 1} id:${shortId(item.id)}`,
      `type:${item.type}`,
      `title:${item.title}`,
      `tags:${(item.tags || []).join(", ")}`,
      `summary:${item.summary || ""}`,
      item.url ? `url:${item.url}` : "",
      `body:${clampText(item.body || "", 1000)}`,
      chunks ? `chunks:\n${chunks}` : ""
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const answer = await callOpenRouter(env, [
    {
      role: "system",
      content: [
        "Ты отвечаешь владельцу личного second brain на русском языке.",
        "Используй только записи из контекста.",
        "Если данных не хватает, скажи это прямо.",
        "Для рекомендаций выбирай из найденных записей и коротко объясняй почему.",
        "Упоминай id записей в квадратных скобках, например [abc123]."
      ].join(" ")
    },
    {
      role: "user",
      content: `Вопрос: ${question}\n\nКонтекст:\n${context}`
    }
  ], { temperature: 0.2, maxTokens: 900 });

  const references = candidates.slice(0, 5).map((item) => `${shortId(item.id)} - ${item.title}`).join("\n");
  await sendLongMessage(env, chatId, `${answer || formatSearchResults(candidates)}\n\nНайденные записи:\n${references}`);
}

async function answerFromWeb(env, chatId, query) {
  const cleanQuery = cleanWebSearchPhrase(query);
  if (!cleanQuery) {
    await sendMessage(env, chatId, "Что поискать в интернете?");
    return;
  }

  if (!env.TAVILY_API_KEY) {
    await sendMessage(env, chatId, "Tavily API key не настроен, поэтому интернет-поиск пока недоступен.");
    return;
  }

  await sendChatAction(env, chatId, "typing").catch(() => {});
  const results = await searchWithTavily(env, cleanQuery);
  if (!results.results.length && !results.answer) {
    await sendMessage(env, chatId, "В интернете по этому запросу ничего полезного не нашёл.");
    return;
  }

  const sources = results.results.slice(0, 5).map((item, index) => {
    const title = item.title || item.url || `Источник ${index + 1}`;
    const url = item.url ? `\n  ${item.url}` : "";
    const snippet = item.content ? `\n  ${clampText(item.content, 240)}` : "";
    return `${index + 1}. ${title}${snippet}${url}`;
  }).join("\n\n");

  if (!hasOpenRouter(env)) {
    const answer = results.answer ? `${results.answer}\n\n` : "";
    await sendLongMessage(env, chatId, `${answer}Источники:\n${sources}`);
    return;
  }

  const context = results.results.slice(0, 6).map((item, index) => [
    `#${index + 1}`,
    `title:${item.title || ""}`,
    `url:${item.url || ""}`,
    `content:${clampText(item.content || "", 1200)}`
  ].join("\n")).join("\n\n");

  const answer = await callOpenRouter(env, [
    {
      role: "system",
      content: [
        "Ты отвечаешь на русском языке по результатам веб-поиска.",
        "Не выдумывай факты вне контекста.",
        "Если контекста мало, скажи это.",
        "В конце коротко укажи номера источников, на которые опирался."
      ].join(" ")
    },
    {
      role: "user",
      content: `Запрос: ${cleanQuery}\n\nПредварительный ответ Tavily: ${results.answer || ""}\n\nРезультаты:\n${context}`
    }
  ], { temperature: 0.2, maxTokens: 900 });

  await sendLongMessage(env, chatId, `${answer || results.answer || "Нашёл несколько источников."}\n\nИсточники:\n${sources}`);
}

async function searchWithTavily(env, query) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TAVILY_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: 6,
      include_answer: "basic",
      include_raw_content: false,
      include_images: false,
      include_favicon: true,
      include_usage: true
    })
  });

  if (!response.ok) {
    return {
      answer: "",
      results: [],
      meta: { tavily_status: response.status, tavily_error: await response.text().catch(() => "") }
    };
  }

  const data = await response.json();
  return {
    answer: data.answer || "",
    results: Array.isArray(data.results) ? data.results : [],
    meta: {
      response_time: data.response_time || null,
      usage: data.usage || null,
      request_id: data.request_id || null
    }
  };
}

async function createItem(env, input) {
  if (!env.DB) throw new Error("D1 binding DB is not configured");

  const id = input.id || newId("itm");
  const now = input.createdAt || new Date().toISOString();
  const tags = withTypeTags(input.type, normalizeTags(input.tags || []));
  const rawContent = input.rawContent || null;
  const searchText = buildSearchText({
    title: input.title,
    body: input.body,
    summary: input.summary,
    url: input.url,
    rawContent,
    tags,
    metadata: input.metadata
  });

  await env.DB.prepare(`
    INSERT INTO items (
      id, owner_id, source, telegram_message_id, telegram_chat_id,
      type, status, title, body, summary, url, domain, canonical_url,
      raw_content, raw_content_truncated, language, importance,
      metadata_json, search_text, captured_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.ownerId,
    input.source || "telegram",
    input.telegramMessageId || null,
    input.telegramChatId || null,
    ensureType(input.type),
    clampText(input.title || "Без названия", 240),
    input.body || "",
    input.summary || null,
    input.url || null,
    input.domain || null,
    input.canonicalUrl || null,
    rawContent,
    input.rawContentTruncated ? 1 : 0,
    input.language || null,
    clampImportance(input.importance),
    safeStringify(input.metadata || {}),
    searchText,
    input.capturedAt || now,
    now,
    now
  ).run();

  await attachTags(env, input.ownerId, id, tags);
  const chunks = await insertChunks(env, input.ownerId, id, buildChunkSource(input));
  await indexChunkRows(env, chunks.map((chunk) => ({
    ...chunk,
    type: ensureType(input.type),
    title: input.title || "Без названия",
    url: input.url || null
  }))).catch((error) => {
    console.error("failed to index item chunks", error);
  });

  await logInteraction(env, input.ownerId, {
    message_id: input.telegramMessageId,
    chat: { id: input.telegramChatId }
  }, "internal", "item_created", { id, type: input.type, title: input.title });

  return {
    id,
    type: ensureType(input.type),
    title: input.title || "Без названия",
    url: input.url || null,
    tags
  };
}

async function attachTags(env, ownerId, itemId, tags) {
  const now = new Date().toISOString();
  for (const tag of tags) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO tags (owner_id, name, kind, created_at)
      VALUES (?, ?, 'topic', ?)
    `).bind(ownerId, tag, now).run();

    const row = await env.DB.prepare(`
      SELECT id FROM tags WHERE owner_id = ? AND name = ?
    `).bind(ownerId, tag).first();

    if (row?.id) {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO item_tags (item_id, tag_id, confidence, source)
        VALUES (?, ?, 1.0, 'auto')
      `).bind(itemId, row.id).run();
    }
  }
}

async function insertChunks(env, ownerId, itemId, sourceText) {
  const chunks = chunkText(sourceText).slice(0, MAX_CHUNKS_PER_ITEM);
  const now = new Date().toISOString();
  const rows = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const id = newId("chk");
    await env.DB.prepare(`
      INSERT INTO chunks (id, item_id, owner_id, chunk_index, content, token_hint, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '{}', ?)
    `).bind(id, itemId, ownerId, i, chunks[i], estimateTokens(chunks[i]), now).run();
    rows.push({
      id,
      vector_id: id,
      item_id: itemId,
      owner_id: ownerId,
      chunk_index: i,
      content: chunks[i],
      created_at: now
    });
  }

  return rows;
}

async function insertAttachment(env, input) {
  await env.DB.prepare(`
    INSERT INTO attachments (
      id, item_id, owner_id, kind, telegram_file_id, telegram_file_unique_id,
      r2_key, mime_type, file_name, width, height, bytes_original, bytes_stored,
      compression_json, caption, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.id,
    input.itemId || null,
    input.ownerId,
    input.kind,
    input.telegramFileId || null,
    input.telegramFileUniqueId || null,
    input.r2Key,
    input.mimeType || null,
    input.fileName || null,
    input.width || null,
    input.height || null,
    input.bytesOriginal || null,
    input.bytesStored || null,
    safeStringify(input.compression || {}),
    input.caption || null,
    input.createdAt || new Date().toISOString()
  ).run();
}

async function isAuthorizedTelegramUser(env, ownerId, senderId) {
  if (!ownerId) return true;
  if (senderId === ownerId) return true;
  if (!env.DB) return false;

  try {
    const row = await env.DB.prepare(`
      SELECT telegram_id
      FROM access_users
      WHERE owner_id = ? AND telegram_id = ? AND status = 'active'
      LIMIT 1
    `).bind(ownerId, senderId).first();
    return Boolean(row?.telegram_id);
  } catch (error) {
    console.error("failed to check telegram access", error);
    return false;
  }
}

async function addAccessUser(env, ownerId, chatId, message, arg, access) {
  if (!(await ensureAccessAdmin(env, ownerId, chatId, access))) return;

  const parsed = parseTelegramUserTarget(arg, message);
  if (!parsed.telegramId) {
    await sendMessage(env, chatId, "Укажи Telegram ID: /allow 123456789 Иван");
    return;
  }

  if (parsed.telegramId === ownerId) {
    await sendMessage(env, chatId, "OWNER_TELEGRAM_ID уже всегда имеет доступ.");
    return;
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO access_users (
      owner_id, telegram_id, status, note, added_by, created_at, updated_at
    ) VALUES (?, ?, 'active', ?, ?, ?, ?)
    ON CONFLICT(owner_id, telegram_id) DO UPDATE SET
      status = 'active',
      note = excluded.note,
      added_by = excluded.added_by,
      updated_at = excluded.updated_at
  `).bind(
    ownerId,
    parsed.telegramId,
    parsed.note || null,
    access.actorId || null,
    now,
    now
  ).run();

  await sendMessage(env, chatId, `Добавил доступ для Telegram ID: ${parsed.telegramId}${parsed.note ? `\nЗаметка: ${parsed.note}` : ""}`);
}

async function removeAccessUser(env, ownerId, chatId, message, arg, access) {
  if (!(await ensureAccessAdmin(env, ownerId, chatId, access))) return;

  const parsed = parseTelegramUserTarget(arg, message);
  if (!parsed.telegramId) {
    await sendMessage(env, chatId, "Укажи Telegram ID: /deny 123456789");
    return;
  }

  if (parsed.telegramId === ownerId) {
    await sendMessage(env, chatId, "Нельзя удалить OWNER_TELEGRAM_ID. Он задан в Cloudflare Secret.");
    return;
  }

  const row = await env.DB.prepare(`
    SELECT telegram_id, status
    FROM access_users
    WHERE owner_id = ? AND telegram_id = ?
    LIMIT 1
  `).bind(ownerId, parsed.telegramId).first();

  if (!row?.telegram_id || row.status !== "active") {
    await sendMessage(env, chatId, "Такого активного Telegram ID в списке доступа нет.");
    return;
  }

  await env.DB.prepare(`
    UPDATE access_users
    SET status = 'revoked', updated_at = ?
    WHERE owner_id = ? AND telegram_id = ?
  `).bind(new Date().toISOString(), ownerId, parsed.telegramId).run();

  await sendMessage(env, chatId, `Удалил доступ для Telegram ID: ${parsed.telegramId}`);
}

async function sendAccessUsers(env, ownerId, chatId, access) {
  if (!(await ensureAccessAdmin(env, ownerId, chatId, access))) return;

  const result = await env.DB.prepare(`
    SELECT telegram_id, note, added_by, created_at, updated_at
    FROM access_users
    WHERE owner_id = ? AND status = 'active'
    ORDER BY created_at ASC
    LIMIT 50
  `).bind(ownerId).all();

  const rows = result.results || [];
  const lines = [
    `- ${ownerId} - владелец из OWNER_TELEGRAM_ID`
  ];

  for (const row of rows) {
    const note = row.note ? ` - ${row.note}` : "";
    const addedBy = row.added_by ? `; добавил: ${row.added_by}` : "";
    lines.push(`- ${row.telegram_id}${note}${addedBy}`);
  }

  await sendLongMessage(env, chatId, `Доступ к боту:\n\n${lines.join("\n")}`);
}

async function ensureAccessAdmin(env, ownerId, chatId, access) {
  if (!ownerId) {
    await sendMessage(env, chatId, "Сначала настрой OWNER_TELEGRAM_ID в Cloudflare Secrets.");
    return false;
  }

  if (!access.isOwner) {
    await sendMessage(env, chatId, "Управлять доступом может только владелец из OWNER_TELEGRAM_ID.");
    return false;
  }

  if (!env.DB) {
    await sendMessage(env, chatId, "D1 база не подключена, список доступа недоступен.");
    return false;
  }

  return true;
}

async function createReminder(env, input) {
  const id = input.id || newId("rem");
  const now = new Date().toISOString();
  const dueAt = normalizeDueAt(input.dueAt);

  await env.DB.prepare(`
    INSERT INTO reminders (
      id, item_id, owner_id, telegram_chat_id, status,
      text, due_at, sent_at, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?, ?)
  `).bind(
    id,
    input.itemId || null,
    input.ownerId,
    input.telegramChatId || null,
    input.text,
    dueAt,
    safeStringify(input.metadata || {}),
    now,
    now
  ).run();

  return { id, dueAt };
}

async function sendPendingReminders(env, ownerId, chatId) {
  const result = await env.DB.prepare(`
    SELECT r.id, r.item_id, r.text, r.due_at, r.sent_at, r.created_at, i.title
    FROM reminders r
    LEFT JOIN items i ON i.id = r.item_id
    WHERE r.owner_id = ? AND r.status = 'pending'
    ORDER BY CASE WHEN r.due_at IS NULL THEN 1 ELSE 0 END, r.due_at ASC, r.created_at DESC
    LIMIT 20
  `).bind(ownerId).all();

  const rows = result.results || [];
  if (!rows.length) {
    await sendMessage(env, chatId, "Активных задач и напоминаний нет.");
    return;
  }

  const lines = rows.map((row) => {
    const due = row.due_at ? formatDueAt(row.due_at) : "без даты";
    const sent = row.sent_at ? "; уже отправлял" : "";
    return `- ${row.title || titleFromText(row.text)}\n  id: ${shortId(row.id)} / ${shortId(row.item_id)}; ${due}${sent}\n  ${clampText(row.text, 220)}`;
  });

  await sendLongMessage(env, chatId, `Активные задачи и напоминания:\n\n${lines.join("\n\n")}`);
}

async function completeReminderByPrefix(env, ownerId, chatId, prefix) {
  const cleanPrefix = String(prefix || "").trim();
  if (!cleanPrefix || cleanPrefix.length < 4) {
    await sendMessage(env, chatId, "Дай хотя бы 4 символа id: /done abc123");
    return;
  }

  const result = await env.DB.prepare(`
    SELECT r.id, r.item_id, r.text, i.title
    FROM reminders r
    LEFT JOIN items i ON i.id = r.item_id
    WHERE r.owner_id = ?
      AND r.status = 'pending'
      AND (r.id LIKE ? OR r.item_id LIKE ?)
    ORDER BY r.created_at DESC
    LIMIT 2
  `).bind(ownerId, `%${cleanPrefix}%`, `%${cleanPrefix}%`).all();

  const rows = result.results || [];
  if (!rows.length) {
    await sendMessage(env, chatId, "Не нашёл активную задачу или напоминание с таким id.");
    return;
  }

  if (rows.length > 1) {
    await sendMessage(env, chatId, `Нашёл несколько задач. Уточни id:\n${rows.map((row) => `${shortId(row.id)} / ${shortId(row.item_id)} - ${row.title || titleFromText(row.text)}`).join("\n")}`);
    return;
  }

  await env.DB.prepare(`
    UPDATE reminders SET status = 'done', updated_at = ? WHERE id = ? AND owner_id = ?
  `).bind(new Date().toISOString(), rows[0].id, ownerId).run();

  await sendMessage(env, chatId, `Готово: ${rows[0].title || titleFromText(rows[0].text)}`);
}

async function compactItemRawContent(env, ownerId, chatId, prefix) {
  const cleanPrefix = String(prefix || "").trim();
  if (!cleanPrefix || cleanPrefix.length < 4) {
    await sendMessage(env, chatId, "Дай хотя бы 4 символа id: /compact abc123");
    return;
  }

  const result = await env.DB.prepare(`
    SELECT id, title, raw_content
    FROM items
    WHERE owner_id = ? AND id LIKE ? AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 2
  `).bind(ownerId, `%${cleanPrefix}%`).all();

  const rows = result.results || [];
  if (!rows.length) {
    await sendMessage(env, chatId, "Не нашёл активную запись с таким id.");
    return;
  }

  if (rows.length > 1) {
    await sendMessage(env, chatId, `Нашёл несколько записей. Уточни id:\n${rows.map((row) => `${shortId(row.id)} - ${row.title}`).join("\n")}`);
    return;
  }

  const savedBytes = new TextEncoder().encode(rows[0].raw_content || "").length;
  await env.DB.prepare(`
    UPDATE items
    SET raw_content = NULL, raw_content_truncated = 0, updated_at = ?
    WHERE id = ? AND owner_id = ?
  `).bind(new Date().toISOString(), rows[0].id, ownerId).run();

  await sendMessage(env, chatId, `Сжал запись: ${rows[0].title}\nRaw extract удалён, summary и chunks оставлены.\nОсвободится примерно: ${formatBytes(savedBytes)}`);
}

async function processDueReminders(env) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return;

  const now = new Date().toISOString();
  const result = await env.DB.prepare(`
    SELECT id, owner_id, telegram_chat_id, text, due_at
    FROM reminders
    WHERE status = 'pending'
      AND sent_at IS NULL
      AND due_at IS NOT NULL
      AND due_at <= ?
    ORDER BY due_at ASC
    LIMIT 20
  `).bind(now).all();

  for (const row of result.results || []) {
    if (!row.telegram_chat_id) continue;
    const targetChatId = String(row.telegram_chat_id);
    if (!targetChatId.startsWith("-") && !(await isAuthorizedTelegramUser(env, String(row.owner_id || ""), targetChatId))) {
      continue;
    }

    try {
      await sendMessage(env, targetChatId, `Напоминание:\n${row.text}\n\nid: ${shortId(row.id)}`);
      await env.DB.prepare(`
        UPDATE reminders SET sent_at = ?, updated_at = ? WHERE id = ?
      `).bind(now, now, row.id).run();
    } catch (error) {
      console.error("failed to send reminder", error);
    }
  }
}

async function handleRagCommand(env, ownerId, chatId, arg) {
  const [subcommand, maybeLimit] = String(arg || "").trim().split(/\s+/, 2);

  if (!subcommand || subcommand === "status") {
    await sendRagStatus(env, ownerId, chatId);
    return;
  }

  if (subcommand === "reindex") {
    const limit = Math.min(Math.max(Number(maybeLimit) || 32, 1), 100);
    if (!hasVectorSearch(env)) {
      await sendMessage(env, chatId, "RAG-индекс не подключён. Нужны bindings AI и VECTOR_INDEX в wrangler config.");
      return;
    }

    const result = await reindexOwnerChunks(env, ownerId, limit);
    await sendMessage(env, chatId, `RAG reindex: обработано ${result.indexed}/${result.total} чанков${result.failed ? `, ошибок: ${result.failed}` : ""}.`);
    return;
  }

  await sendMessage(env, chatId, "Команды RAG: /rag status или /rag reindex [число].");
}

async function sendRagStatus(env, ownerId, chatId) {
  const ready = hasVectorSearch(env);
  let lines = [
    `AI binding: ${env.AI ? "ok" : "нет"}`,
    `Vectorize binding: ${env.VECTOR_INDEX ? "ok" : "нет"}`,
    `Embedding model: ${embeddingModel(env)}`
  ];

  try {
    const result = await env.DB.prepare(`
      SELECT COALESCE(embedding_status, 'pending') AS status, COUNT(*) AS count
      FROM chunks
      WHERE owner_id = ?
      GROUP BY COALESCE(embedding_status, 'pending')
      ORDER BY status
    `).bind(ownerId).all();
    const rows = result.results || [];
    if (rows.length) {
      lines = lines.concat(rows.map((row) => `${row.status}: ${row.count}`));
    } else {
      lines.push("chunks: 0");
    }
  } catch {
    lines.push("Статусы embeddings недоступны: примени миграцию RAG.");
  }

  lines.push(ready ? "Семантический поиск включён." : "Семантический поиск пока выключен; /ask работает через keyword search.");
  await sendMessage(env, chatId, lines.join("\n"));
}

async function reindexOwnerChunks(env, ownerId, limit) {
  const result = await env.DB.prepare(`
    SELECT c.id, c.vector_id, c.item_id, c.owner_id, c.chunk_index, c.content,
           i.type, i.title, i.url
    FROM chunks c
    JOIN items i ON i.id = c.item_id
    WHERE c.owner_id = ? AND i.status = 'active'
      AND COALESCE(c.embedding_status, 'pending') != 'indexed'
    ORDER BY c.created_at ASC, c.chunk_index ASC
    LIMIT ?
  `).bind(ownerId, limit).all();

  const rows = result.results || [];
  if (!rows.length) return { total: 0, indexed: 0, failed: 0 };
  return indexChunkRows(env, rows);
}

async function indexChunkRows(env, rows) {
  const chunks = (rows || [])
    .filter((row) => row?.id && String(row.content || "").trim())
    .slice(0, MAX_VECTOR_CHUNKS_PER_BATCH);

  if (!chunks.length) return { total: 0, indexed: 0, failed: 0 };
  if (!hasVectorSearch(env)) return { total: chunks.length, indexed: 0, failed: 0 };

  const model = embeddingModel(env);
  const now = new Date().toISOString();

  try {
    const texts = chunks.map((row) => clampText(row.content, MAX_CHUNK_CHARS));
    const embeddings = await embedTexts(env, texts);
    const vectors = [];
    const indexedRows = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const values = embeddings[i];
      if (!Array.isArray(values) || !values.length) continue;
      const row = chunks[i];
      const vector = {
        id: row.vector_id || row.id,
        values,
        metadata: {
          item_id: row.item_id,
          owner_id: row.owner_id,
          type: ensureType(row.type),
          title: clampText(row.title || "", 160),
          url: row.url || "",
          chunk_index: Number(row.chunk_index || 0)
        }
      };
      vectors.push(vector);
      indexedRows.push({ row, vector });
    }

    if (!vectors.length) throw new Error("Embedding model returned no vectors");
    await env.VECTOR_INDEX.upsert(vectors);

    for (const indexed of indexedRows) {
      await env.DB.prepare(`
        UPDATE chunks
        SET vector_id = ?, embedding_status = 'indexed', embedding_model = ?,
            embedding_index_name = ?, embedded_at = ?, embedding_error = NULL
        WHERE id = ?
      `).bind(
        indexed.vector.id,
        model,
        env.VECTOR_INDEX_NAME || "VECTOR_INDEX",
        now,
        indexed.row.id
      ).run();
    }

    return { total: chunks.length, indexed: vectors.length, failed: chunks.length - vectors.length };
  } catch (error) {
    const message = clampText(error?.message || String(error), 500);
    for (const row of chunks) {
      await env.DB.prepare(`
        UPDATE chunks
        SET embedding_status = 'failed', embedding_model = ?, embedding_error = ?
        WHERE id = ?
      `).bind(model, message, row.id).run().catch(() => {});
    }
    console.error("chunk indexing failed", error);
    return { total: chunks.length, indexed: 0, failed: chunks.length };
  }
}

async function embedTexts(env, texts) {
  const clean = texts.map((text) => clampText(normalizeWhitespace(text), MAX_CHUNK_CHARS));
  if (!env.AI || !clean.length) return [];

  const payload = {
    text: clean
  };
  if (env.EMBEDDING_POOLING) payload.pooling = env.EMBEDDING_POOLING;

  const response = await env.AI.run(embeddingModel(env), payload);
  return Array.isArray(response?.data) ? response.data : [];
}

async function deleteVectorsForItem(env, itemId) {
  if (!env.DB || !env.VECTOR_INDEX) return;

  const result = await env.DB.prepare(`
    SELECT COALESCE(vector_id, id) AS vector_id
    FROM chunks
    WHERE item_id = ?
  `).bind(itemId).all().catch(() => ({ results: [] }));
  const ids = (result.results || []).map((row) => row.vector_id).filter(Boolean);
  if (!ids.length) return;

  await env.VECTOR_INDEX.deleteByIds(ids).catch((error) => {
    console.error("failed to delete vectors", error);
  });
}

function hasVectorSearch(env) {
  return Boolean(env.AI && env.VECTOR_INDEX);
}

function embeddingModel(env) {
  return env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
}

async function searchItems(env, ownerId, parsed) {
  const keywordRows = await keywordSearchItems(env, ownerId, parsed);
  const semanticRows = await semanticSearchItems(env, ownerId, parsed).catch((error) => {
    console.error("semantic search failed", error);
    return [];
  });

  const limit = Math.min(Math.max(Number(parsed.limit) || 8, 1), 12);
  const merged = mergeSearchRows(keywordRows, semanticRows).slice(0, limit);
  const tokens = tokenizeSearch(parsed.query || "").slice(0, 8);
  const chunksByItem = await loadChunksForItems(env, merged.map((row) => row.id), tokens);

  return merged.map((row) => ({
    ...row,
    chunks: [
      ...(row.semanticChunks || []),
      ...(chunksByItem[row.id] || [])
    ].filter(Boolean).slice(0, 4)
  }));
}

async function keywordSearchItems(env, ownerId, parsed) {
  const tokens = tokenizeSearch(parsed.query || "").slice(0, 8);
  const types = (parsed.types || []).map(ensureType).filter((type) => type && type !== "other").slice(0, 5);

  const params = [ownerId];
  let sql = `
    SELECT id, owner_id, type, title, body, summary, url, domain, metadata_json,
           search_text, importance, created_at
    FROM items
    WHERE owner_id = ? AND status = 'active'
  `;

  if (types.length) {
    sql += ` AND type IN (${types.map(() => "?").join(", ")})`;
    params.push(...types);
  }

  if (tokens.length) {
    sql += ` AND (${tokens.map(() => "lower(search_text) LIKE ?").join(" OR ")})`;
    params.push(...tokens.map((token) => `%${token}%`));
  }

  sql += " ORDER BY created_at DESC LIMIT 80";

  const result = await env.DB.prepare(sql).bind(...params).all();
  const rows = result.results || [];
  const tagsByItem = await loadTagsForItems(env, rows.map((row) => row.id));

  const scored = rows.map((row) => {
    const tags = tagsByItem[row.id] || [];
    return {
      ...row,
      tags,
      score: scoreSearchRow(row, tags, tokens, types),
      searchSource: "keyword"
    };
  }).sort((a, b) => b.score - a.score || String(b.created_at).localeCompare(String(a.created_at)));

  return scored.slice(0, 24);
}

async function semanticSearchItems(env, ownerId, parsed) {
  if (!hasVectorSearch(env)) return [];

  const query = String(parsed.query || "").trim();
  if (!query) return [];

  const types = sanitizeTypes(parsed.types || []);
  const queryEmbedding = await embedTexts(env, [query]);
  const vector = queryEmbedding[0];
  if (!vector) return [];

  const matches = await env.VECTOR_INDEX.query(vector, {
    topK: 30,
    returnMetadata: "all"
  });

  const vectorIds = (matches.matches || []).map((match) => match.id).filter(Boolean);
  if (!vectorIds.length) return [];

  const scoreByVector = new Map((matches.matches || []).map((match) => [match.id, Number(match.score || 0)]));
  const params = [ownerId, ...vectorIds];
  let sql = `
    SELECT i.id, i.owner_id, i.type, i.title, i.body, i.summary, i.url, i.domain,
           i.metadata_json, i.search_text, i.importance, i.created_at,
           c.id AS chunk_id, c.vector_id, c.content AS chunk_content
    FROM chunks c
    JOIN items i ON i.id = c.item_id
    WHERE i.owner_id = ? AND i.status = 'active'
      AND COALESCE(c.vector_id, c.id) IN (${vectorIds.map(() => "?").join(", ")})
  `;

  if (types.length) {
    sql += ` AND i.type IN (${types.map(() => "?").join(", ")})`;
    params.push(...types);
  }

  const result = await env.DB.prepare(sql).bind(...params).all();
  const rows = result.results || [];
  const tagsByItem = await loadTagsForItems(env, rows.map((row) => row.id));
  const byItem = new Map();

  for (const row of rows) {
    const vectorId = row.vector_id || row.chunk_id;
    const semanticScore = scoreByVector.get(vectorId) || 0;
    const existing = byItem.get(row.id);
    const tags = tagsByItem[row.id] || [];
    if (!existing) {
      byItem.set(row.id, {
        id: row.id,
        owner_id: row.owner_id,
        type: row.type,
        title: row.title,
        body: row.body,
        summary: row.summary,
        url: row.url,
        domain: row.domain,
        metadata_json: row.metadata_json,
        search_text: row.search_text,
        importance: row.importance,
        created_at: row.created_at,
        tags,
        score: 12 + semanticScore * 20 + Number(row.importance || 0),
        searchSource: "semantic",
        semanticChunks: row.chunk_content ? [row.chunk_content] : []
      });
      continue;
    }

    existing.score = Math.max(existing.score, 12 + semanticScore * 20 + Number(row.importance || 0));
    if (row.chunk_content && existing.semanticChunks.length < 3) {
      existing.semanticChunks.push(row.chunk_content);
    }
  }

  return [...byItem.values()].sort((a, b) => b.score - a.score);
}

function mergeSearchRows(keywordRows, semanticRows) {
  const byId = new Map();
  for (const row of [...semanticRows, ...keywordRows]) {
    const existing = byId.get(row.id);
    if (!existing) {
      byId.set(row.id, row);
      continue;
    }

    existing.score = Math.max(existing.score || 0, row.score || 0) + 2;
    existing.tags = existing.tags?.length ? existing.tags : row.tags || [];
    existing.semanticChunks = [
      ...(existing.semanticChunks || []),
      ...(row.semanticChunks || [])
    ].filter(Boolean).slice(0, 3);
    existing.searchSource = existing.searchSource === row.searchSource ? existing.searchSource : "hybrid";
  }

  return [...byId.values()].sort((a, b) => b.score - a.score || String(b.created_at).localeCompare(String(a.created_at)));
}

async function loadTagsForItems(env, itemIds) {
  if (!itemIds.length) return {};
  const sql = `
    SELECT it.item_id, t.name
    FROM item_tags it
    JOIN tags t ON t.id = it.tag_id
    WHERE it.item_id IN (${itemIds.map(() => "?").join(", ")})
    ORDER BY t.name
  `;
  const result = await env.DB.prepare(sql).bind(...itemIds).all();
  const out = {};
  for (const row of result.results || []) {
    if (!out[row.item_id]) out[row.item_id] = [];
    out[row.item_id].push(row.name);
  }
  return out;
}

async function loadChunksForItems(env, itemIds, tokens) {
  if (!itemIds.length) return {};
  const sql = `
    SELECT item_id, content, chunk_index
    FROM chunks
    WHERE item_id IN (${itemIds.map(() => "?").join(", ")})
    ORDER BY item_id, chunk_index
  `;
  const result = await env.DB.prepare(sql).bind(...itemIds).all();
  const out = {};
  for (const row of result.results || []) {
    if (!out[row.item_id]) out[row.item_id] = [];
    if (out[row.item_id].length >= 4) continue;
    if (!tokens.length || tokens.some((token) => row.content.toLowerCase().includes(token))) {
      out[row.item_id].push(row.content);
    }
  }
  return out;
}

function scoreSearchRow(row, tags, tokens, types) {
  const title = String(row.title || "").toLowerCase();
  const summary = String(row.summary || "").toLowerCase();
  const body = String(row.body || "").toLowerCase();
  const search = String(row.search_text || "").toLowerCase();
  const tagText = tags.join(" ").toLowerCase();
  let score = Number(row.importance || 0);

  if (types.includes(row.type)) score += 8;
  for (const token of tokens) {
    if (title.includes(token)) score += 10;
    if (tagText.includes(token)) score += 8;
    if (summary.includes(token)) score += 5;
    if (body.includes(token)) score += 2;
    if (search.includes(token)) score += 1;
  }

  return score;
}

async function parseSearchQuestion(env, question) {
  const useWeb = isExplicitWebSearch(question);
  const cleanedQuestion = cleanWebSearchPhrase(question);
  const fallback = {
    query: cleanedQuestion || question,
    types: inferTypesFromQuestion(cleanedQuestion || question),
    tags: heuristicTags(cleanedQuestion || question, "other"),
    limit: 8,
    useWeb
  };

  if (!hasOpenRouter(env)) return fallback;

  try {
    const content = await callOpenRouter(env, [
      {
        role: "system",
        content: [
          "Ты парсер поиска для личной базы знаний.",
          "Верни только JSON без markdown.",
          "Поля: query string, types array, tags array, limit number.",
          `types только из списка: ${[...ALLOWED_TYPES].join(", ")}.`,
          "Если человек спрашивает что посмотреть, добавь type movie.",
          "Фразы вроде 'поищи в интернете' не включай в query."
        ].join(" ")
      },
      { role: "user", content: cleanedQuestion || question }
    ], { temperature: 0, maxTokens: 220 });
    const parsed = parseJsonObject(content);
    return {
      query: parsed.query || fallback.query,
      types: sanitizeTypes(parsed.types || fallback.types),
      tags: normalizeTags(parsed.tags || fallback.tags),
      limit: Math.min(Math.max(Number(parsed.limit) || 8, 1), 12),
      useWeb
    };
  } catch {
    return fallback;
  }
}

async function classifyText(env, text) {
  const fallback = fallbackClassifyText(text);
  if (!hasOpenRouter(env)) return fallback;

  try {
    const content = await callOpenRouter(env, [
      {
        role: "system",
        content: [
          "Ты классифицируешь сообщения для личного second brain.",
          "Верни только JSON без markdown.",
          "Поля: intent save|search, type, title, body, summary, tags, question, language, importance, entities, needs_clarification boolean, clarifying_question string.",
          `type только из списка: ${[...ALLOWED_TYPES].join(", ")}.`,
          "Если это обычная мысль или заметка, intent=save.",
          "Если человек просит найти, вспомнить, подобрать или совет, intent=search.",
          "needs_clarification=true только если без ответа пользователя запись будет бессмысленной: например просят сохранить фильм, но не дали название, или просят напомнить, но не дали когда.",
          "Не задавай уточнения только из-за неидеальных тегов или заголовка.",
          "Убери служебные фразы вроде 'запиши мысль' из body."
        ].join(" ")
      },
      { role: "user", content: text }
    ], { temperature: 0, maxTokens: 450 });

    const parsed = parseJsonObject(content);
    return sanitizeClassification({ ...fallback, ...parsed, source: "openrouter" }, text);
  } catch {
    return fallback;
  }
}

async function enrichLink(env, url, caption, rawContent, extracted) {
  const fallback = {
    type: inferTypeFromText(`${caption}\n${rawContent}`, "link"),
    title: titleFromText(caption) || titleFromUrl(url),
    summary: fallbackSummary(rawContent),
    tags: heuristicTags(`${caption}\n${rawContent}`, "link"),
    language: null,
    importance: 0
  };

  if (!hasOpenRouter(env) || (!caption && !rawContent)) return fallback;

  try {
    const content = await callOpenRouter(env, [
      {
        role: "system",
        content: [
          "Ты превращаешь сохранённую ссылку в структурированную запись second brain.",
          "Верни только JSON без markdown.",
          "Поля: type, title, summary, tags, language, importance.",
          `type только из списка: ${[...ALLOWED_TYPES].join(", ")}.`,
          "summary должен быть коротким, 1-3 предложения по-русски.",
          "tags: 3-8 коротких тегов на русском или языке источника."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          `URL: ${url}`,
          caption ? `Подпись пользователя: ${caption}` : "",
          extracted?.favicon ? `Favicon: ${extracted.favicon}` : "",
          `Контент:\n${clampText(rawContent || "", MAX_AI_INPUT_CHARS)}`
        ].filter(Boolean).join("\n\n")
      }
    ], { temperature: 0.1, maxTokens: 550 });
    const parsed = parseJsonObject(content);
    return {
      ...fallback,
      ...parsed,
      type: ensureType(parsed.type || fallback.type),
      tags: normalizeTags(parsed.tags || fallback.tags),
      importance: clampImportance(parsed.importance)
    };
  } catch {
    return fallback;
  }
}

async function parseTaskDetails(env, text, options = {}) {
  const fallbackText = stripTaskPrefix(text);
  const fallbackDueAt = parseSimpleDueAt(text);
  const fallback = {
    text: fallbackText,
    title: options.classification?.title || titleFromText(fallbackText),
    summary: options.classification?.summary || fallbackText,
    tags: options.classification?.tags || heuristicTags(fallbackText, "task"),
    dueAt: fallbackDueAt,
    reminderRequested: Boolean(options.forceReminder || wantsReminder(text)),
    language: options.classification?.language || "ru",
    importance: clampImportance(options.classification?.importance),
    source: options.classification?.source || "heuristic"
  };

  if (!hasOpenRouter(env)) return fallback;

  try {
    const now = new Date();
    const content = await callOpenRouter(env, [
      {
        role: "system",
        content: [
          "Ты извлекаешь задачу или напоминание для личного second brain.",
          "Верни только JSON без markdown.",
          "Поля: text, title, summary, tags, due_at, reminder_requested, language, importance.",
          "due_at верни как ISO 8601 с часовым поясом или null.",
          "Если дата или время не указаны явно или относительно, due_at=null.",
          "Для относительных дат используй timezone Europe/Moscow.",
          `Текущее время: ${now.toISOString()}.`
        ].join(" ")
      },
      { role: "user", content: text }
    ], { temperature: 0, maxTokens: 420 });

    const parsed = parseJsonObject(content);
    const parsedDueAt = normalizeDueAt(parsed.due_at || parsed.dueAt);
    return {
      text: String(parsed.text || fallback.text).trim() || fallback.text,
      title: clampText(String(parsed.title || fallback.title).trim(), 240),
      summary: clampText(String(parsed.summary || fallback.summary).trim(), 700),
      tags: normalizeTags(parsed.tags || fallback.tags),
      dueAt: parsedDueAt || fallback.dueAt,
      reminderRequested: Boolean(parsed.reminder_requested || parsed.reminderRequested || fallback.reminderRequested),
      language: parsed.language || fallback.language,
      importance: clampImportance(parsed.importance ?? fallback.importance),
      source: "openrouter"
    };
  } catch {
    return fallback;
  }
}

async function extractWithTavily(env, url) {
  if (!env.TAVILY_API_KEY) {
    return { url, raw_content: "", images: [], favicon: null, meta: { skipped: "missing_tavily_key" } };
  }

  const response = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TAVILY_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      urls: url,
      extract_depth: "basic",
      include_images: false,
      include_favicon: true,
      format: "markdown",
      timeout: 12,
      include_usage: true
    })
  });

  if (!response.ok) {
    return {
      url,
      raw_content: "",
      images: [],
      favicon: null,
      meta: { tavily_status: response.status, tavily_error: await response.text().catch(() => "") }
    };
  }

  const data = await response.json();
  const result = data.results?.[0] || {};
  return {
    url: result.url || url,
    raw_content: result.raw_content || "",
    images: result.images || [],
    favicon: result.favicon || null,
    meta: {
      response_time: data.response_time || null,
      usage: data.usage || null,
      request_id: data.request_id || null,
      failed_results: data.failed_results || []
    }
  };
}

async function findOpenLibraryBook(env, query) {
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "5");
  url.searchParams.set("fields", [
    "key",
    "title",
    "author_name",
    "first_publish_year",
    "isbn",
    "cover_i",
    "language",
    "subject"
  ].join(","));

  const response = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json",
      "User-Agent": buildExternalUserAgent(env)
    }
  }).catch(() => null);

  if (!response?.ok) return null;
  const data = await response.json().catch(() => ({}));
  const docs = Array.isArray(data.docs) ? data.docs : [];
  const best = docs.find((doc) => doc.title) || null;
  if (!best) return null;

  const coverUrl = best.cover_i ? `https://covers.openlibrary.org/b/id/${best.cover_i}-L.jpg` : null;
  return {
    key: best.key || null,
    title: String(best.title || query).trim(),
    authors: normalizePeople(best.author_name).slice(0, 5),
    firstPublishYear: best.first_publish_year || null,
    isbn: Array.isArray(best.isbn) ? best.isbn[0] || null : null,
    coverUrl,
    languages: Array.isArray(best.language) ? best.language.slice(0, 5) : [],
    subjects: normalizeTags((best.subject || []).slice(0, 8)),
    openLibraryUrl: best.key ? `https://openlibrary.org${best.key}` : null
  };
}

async function findTmdbMovie(env, query) {
  if (!env.TMDB_API_KEY && !env.TMDB_API_TOKEN) return null;

  const searchUrl = new URL("https://api.themoviedb.org/3/search/movie");
  searchUrl.searchParams.set("query", query);
  searchUrl.searchParams.set("include_adult", "false");
  searchUrl.searchParams.set("language", env.TMDB_LANGUAGE || "ru-RU");
  searchUrl.searchParams.set("page", "1");
  applyTmdbApiKey(env, searchUrl);

  const searchResponse = await fetch(searchUrl.toString(), {
    headers: buildTmdbHeaders(env)
  }).catch(() => null);
  if (!searchResponse?.ok) return null;

  const searchData = await searchResponse.json().catch(() => ({}));
  const result = Array.isArray(searchData.results) ? searchData.results.find((item) => item?.id) : null;
  if (!result) return null;

  const detailsUrl = new URL(`https://api.themoviedb.org/3/movie/${result.id}`);
  detailsUrl.searchParams.set("language", env.TMDB_LANGUAGE || "ru-RU");
  applyTmdbApiKey(env, detailsUrl);

  const detailsResponse = await fetch(detailsUrl.toString(), {
    headers: buildTmdbHeaders(env)
  }).catch(() => null);
  const details = detailsResponse?.ok ? await detailsResponse.json().catch(() => ({})) : {};
  const merged = { ...result, ...details };
  const posterPath = merged.poster_path || result.poster_path || "";

  return {
    id: merged.id,
    title: merged.title || result.title || query,
    originalTitle: merged.original_title || result.original_title || "",
    overview: merged.overview || result.overview || "",
    releaseDate: merged.release_date || result.release_date || "",
    language: merged.original_language || result.original_language || null,
    genres: Array.isArray(merged.genres) ? merged.genres.map((genre) => genre.name).filter(Boolean).slice(0, 8) : [],
    voteAverage: Number(merged.vote_average || result.vote_average || 0),
    voteCount: Number(merged.vote_count || result.vote_count || 0),
    posterUrl: posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : null,
    tmdbUrl: merged.id ? `https://www.themoviedb.org/movie/${merged.id}` : null
  };
}

function applyTmdbApiKey(env, url) {
  if (env.TMDB_API_TOKEN) return;
  const key = env.TMDB_API_KEY || "";
  if (key && !looksLikeBearerToken(key)) {
    url.searchParams.set("api_key", key);
  }
}

function buildTmdbHeaders(env) {
  const headers = { "Accept": "application/json" };
  const token = env.TMDB_API_TOKEN || env.TMDB_API_KEY || "";
  if (looksLikeBearerToken(token) || env.TMDB_API_TOKEN) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function looksLikeBearerToken(value) {
  const token = String(value || "");
  return token.startsWith("ey") || token.split(".").length >= 3;
}

function buildExternalUserAgent(env) {
  const contact = env.OPENLIBRARY_CONTACT_EMAIL || env.BOT_CONTACT_EMAIL || "no-contact-configured@example.invalid";
  return `second-brain-bot/0.1 (${contact})`;
}

async function sendRecent(env, ownerId, chatId) {
  const result = await env.DB.prepare(`
    SELECT id, type, title, summary, url, created_at
    FROM items
    WHERE owner_id = ? AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 10
  `).bind(ownerId).all();

  const rows = result.results || [];
  if (!rows.length) {
    await sendMessage(env, chatId, "Пока нет сохранённых записей.");
    return;
  }

  await sendLongMessage(env, chatId, `Последние записи:\n\n${formatSearchResults(rows)}`);
}

async function sendStats(env, ownerId, chatId) {
  const itemStats = await env.DB.prepare(`
    SELECT type, COUNT(*) AS count
    FROM items
    WHERE owner_id = ? AND status = 'active'
    GROUP BY type
    ORDER BY count DESC
  `).bind(ownerId).all();

  const attachmentStats = await env.DB.prepare(`
    SELECT COUNT(*) AS files, COALESCE(SUM(bytes_stored), 0) AS bytes
    FROM attachments
    WHERE owner_id = ?
  `).bind(ownerId).first();

  const lines = (itemStats.results || []).map((row) => `${TYPE_LABELS[row.type] || row.type}: ${row.count}`);
  lines.push(`файлы: ${attachmentStats?.files || 0}`);
  lines.push(`R2 размер: ${formatBytes(Number(attachmentStats?.bytes || 0))}`);

  await sendMessage(env, chatId, `Статистика:\n${lines.join("\n")}`);
}

async function archiveItemByPrefix(env, ownerId, chatId, prefix) {
  const cleanPrefix = String(prefix || "").trim();
  if (!cleanPrefix || cleanPrefix.length < 4) {
    await sendMessage(env, chatId, "Дай хотя бы 4 символа id: /delete abc123");
    return;
  }

  const result = await env.DB.prepare(`
    SELECT id, title FROM items
    WHERE owner_id = ? AND id LIKE ? AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 2
  `).bind(ownerId, `%${cleanPrefix}%`).all();

  const rows = result.results || [];
  if (!rows.length) {
    await sendMessage(env, chatId, "Не нашёл активную запись с таким id.");
    return;
  }

  if (rows.length > 1) {
    await sendMessage(env, chatId, `Нашёл несколько записей. Уточни id:\n${rows.map((row) => `${shortId(row.id)} - ${row.title}`).join("\n")}`);
    return;
  }

  await env.DB.prepare(`
    UPDATE items SET status = 'archived', updated_at = ? WHERE id = ? AND owner_id = ?
  `).bind(new Date().toISOString(), rows[0].id, ownerId).run();
  await deleteVectorsForItem(env, rows[0].id);

  await sendMessage(env, chatId, `Архивировал: ${rows[0].title}`);
}

async function getTelegramFile(env, fileId) {
  const data = await telegramApi(env, "getFile", { file_id: fileId });
  if (!data?.file_path) throw new Error("Telegram did not return file_path");
  return data;
}

async function downloadTelegramImage(env, filePath) {
  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const transformed = await fetch(fileUrl, {
    cf: {
      image: {
        fit: "scale-down",
        width: IMAGE_TARGET_PX,
        height: IMAGE_TARGET_PX,
        quality: 82,
        format: "jpeg"
      }
    }
  }).catch(() => null);

  if (transformed?.ok && String(transformed.headers.get("content-type") || "").startsWith("image/")) {
    const buffer = await transformed.arrayBuffer();
    return {
      buffer,
      bytes: buffer.byteLength,
      mimeType: transformed.headers.get("content-type") || "image/jpeg",
      transformed: true
    };
  }

  const original = await fetch(fileUrl);
  if (!original.ok) throw new Error(`Telegram file download failed: ${original.status}`);
  const buffer = await original.arrayBuffer();
  return {
    buffer,
    bytes: buffer.byteLength,
    mimeType: original.headers.get("content-type") || "application/octet-stream",
    transformed: false
  };
}

async function telegramApi(env, method, payload) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(`Telegram API ${method} failed: ${response.status} ${safeStringify(data)}`);
  }
  return data.result;
}

async function sendMessage(env, chatId, text) {
  if (!String(text || "").trim()) return;
  return telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: clampText(text, TELEGRAM_TEXT_LIMIT),
    disable_web_page_preview: true
  });
}

async function sendLongMessage(env, chatId, text) {
  const parts = splitTelegramText(text);
  for (const part of parts) {
    await sendMessage(env, chatId, part);
  }
}

async function sendChatAction(env, chatId, action) {
  return telegramApi(env, "sendChatAction", { chat_id: chatId, action });
}

async function callOpenRouter(env, messages, options = {}) {
  if (!hasOpenRouter(env)) return "";

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://workers.dev",
      "X-Title": "Second Brain Telegram Bot"
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL,
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 500
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter failed: ${response.status} ${await response.text().catch(() => "")}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function logInteraction(env, ownerId, message, direction, kind, payload) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(`
      INSERT INTO interactions (id, owner_id, telegram_message_id, telegram_chat_id, direction, kind, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId("log"),
      ownerId || "unknown",
      message?.message_id || null,
      message?.chat?.id ? String(message.chat.id) : null,
      direction,
      kind,
      clampText(safeStringify(payload || {}), 8000),
      new Date().toISOString()
    ).run();
  } catch (error) {
    console.error("failed to log interaction", error);
  }
}

function parseCommand(text) {
  const match = text.match(/^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    arg: match[2] || ""
  };
}

function parseTelegramUserTarget(arg, message) {
  const clean = String(arg || "").trim();
  const idMatch = clean.match(/\b(\d{3,20})\b/);
  if (idMatch) {
    return {
      telegramId: idMatch[1],
      note: clean.replace(idMatch[0], "").trim()
    };
  }

  const replyUserId = message.reply_to_message?.from?.id;
  if (replyUserId) {
    return {
      telegramId: String(replyUserId),
      note: clean
    };
  }

  const forwardedUserId = message.forward_from?.id || message.forward_origin?.sender_user?.id;
  if (forwardedUserId) {
    return {
      telegramId: String(forwardedUserId),
      note: clean
    };
  }

  return { telegramId: "", note: clean };
}

function fallbackClassifyText(text) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const incomplete = inferClarification(trimmed);

  if (isLikelyQuestion(lower)) {
    return {
      intent: "search",
      type: "other",
      title: titleFromText(trimmed),
      body: trimmed,
      summary: "",
      tags: heuristicTags(trimmed, "other"),
      question: trimmed,
      language: "ru",
      importance: 0,
      entities: [],
      needsClarification: false,
      clarifyingQuestion: "",
      source: "heuristic"
    };
  }

  const type = inferTypeFromText(trimmed, "thought");
  const body = stripSavePrefix(trimmed, type);
  return {
    intent: "save",
    type,
    title: titleFromText(body),
    body,
    summary: body.length > 220 ? `${body.slice(0, 217)}...` : body,
    tags: heuristicTags(body, type),
    question: "",
    language: "ru",
    importance: 0,
    entities: [],
    needsClarification: incomplete.needsClarification,
    clarifyingQuestion: incomplete.clarifyingQuestion,
    source: "heuristic"
  };
}

function sanitizeClassification(input, originalText) {
  const intent = input.intent === "search" ? "search" : "save";
  const type = ensureType(input.type || inferTypeFromText(originalText, "thought"));
  const body = String(input.body || stripSavePrefix(originalText, type)).trim();

  return {
    intent,
    type,
    title: clampText(String(input.title || titleFromText(body || originalText)).trim(), 240),
    body: body || originalText,
    summary: clampText(String(input.summary || "").trim(), 700),
    tags: normalizeTags(input.tags || heuristicTags(body || originalText, type)),
    question: String(input.question || originalText).trim(),
    language: input.language || "ru",
    importance: clampImportance(input.importance),
    entities: Array.isArray(input.entities) ? input.entities.slice(0, 20) : [],
    needsClarification: Boolean(input.needs_clarification || input.needsClarification),
    clarifyingQuestion: String(input.clarifying_question || input.clarifyingQuestion || "").trim(),
    source: input.source || "openrouter"
  };
}

function isLikelyQuestion(lowerText) {
  if (lowerText.includes("?")) return true;
  return /^(найди|покажи|вспомни|подбери|посоветуй|поищи|погугли|что|какой|какая|какие|куда|где|когда|зачем|почему|есть ли|можешь найти)\b/.test(lowerText);
}

function inferClarification(text) {
  const lower = text.toLowerCase().trim();
  const withoutPrefix = stripSavePrefix(text, inferTypeFromText(text, "thought")).trim();

  if (/^(интересный\s+фильм|фильм|кино|сериал|запиши\s+что\s+посмотреть)\s*[:\s-]*$/i.test(lower)) {
    return {
      needsClarification: true,
      clarifyingQuestion: "Какой фильм или сериал сохранить?"
    };
  }

  if (/^(рецепт|сохрани\s+рецепт)\s*[:\s-]*$/i.test(lower)) {
    return {
      needsClarification: true,
      clarifyingQuestion: "Какой рецепт сохранить?"
    };
  }

  if (wantsReminder(text) && !hasTimeHint(text)) {
    return {
      needsClarification: true,
      clarifyingQuestion: "Когда напомнить?"
    };
  }

  if (!withoutPrefix || withoutPrefix.length < 2) {
    return {
      needsClarification: true,
      clarifyingQuestion: "Что именно сохранить?"
    };
  }

  return { needsClarification: false, clarifyingQuestion: "" };
}

function inferTypeFromText(text, fallback) {
  const lower = text.toLowerCase();
  if (/(фильм|кино|сериал|документалк|аниме|посмотреть|режисс[её]р)/.test(lower)) return "movie";
  if (/(рецепт|ингредиент|готовить|приготов|духовк|сковород|соус|тесто)/.test(lower)) return "recipe";
  if (/(книга|прочитать|автор|роман|статья|эссе)/.test(lower)) return "book";
  if (/(место|кафе|ресторан|музей|поехать|сходить|город)/.test(lower)) return "place";
  if (/(задача|сделать|напомни|надо|нужно|todo)/.test(lower)) return "task";
  if (/(цитата|quote|сказал|фраза)/.test(lower)) return "quote";
  if (/https?:\/\//.test(lower)) return "link";
  return fallback;
}

function inferTypesFromQuestion(question) {
  const lower = question.toLowerCase();
  if (/(посмотреть|фильм|кино|сериал|вечером)/.test(lower)) return ["movie"];
  if (/(готовить|рецепт|ужин|обед|завтрак|ингредиент)/.test(lower)) return ["recipe"];
  if (/(прочитать|книга|статья)/.test(lower)) return ["book", "link"];
  if (/(сходить|поехать|место|кафе|ресторан)/.test(lower)) return ["place"];
  return [];
}

function heuristicTags(text, type) {
  const lower = text.toLowerCase();
  const tags = [];

  if (type && type !== "other") tags.push(TYPE_LABELS[type] || type);
  if (/(работ|проект|код|программ|api|cloudflare|telegram|бот)/.test(lower)) tags.push("работа");
  if (/(личн|мысл|идея|наблюден)/.test(lower)) tags.push("мысли");
  if (/(ужин|обед|завтрак|еда|рецепт)/.test(lower)) tags.push("еда");
  if (/(вечер|выходн|отдых)/.test(lower)) tags.push("отдых");
  if (/(важно|срочно|обязательно)/.test(lower)) tags.push("важное");
  if (/(ai|llm|openrouter|модель|нейросет)/.test(lower)) tags.push("ai");

  return normalizeTags(tags);
}

function withTypeTags(type, tags) {
  const base = normalizeTags(tags);
  const additions = [];
  if (type === "movie") additions.push("кино", "посмотреть");
  if (type === "book") additions.push("книги", "прочитать");
  if (type === "recipe") additions.push("рецепты", "еда");
  if (type === "link") additions.push("ссылки");
  if (type === "thought") additions.push("мысли");
  if (type === "image") additions.push("картинки");
  if (type === "task") additions.push("задачи");
  return normalizeTags([...additions, ...base]).slice(0, 14);
}

function stripSavePrefix(text, type) {
  let out = text.trim();
  out = out.replace(/^(запиши|сохрани|добавь|зафиксируй)\s+(мысль|заметку|идею|ссылку|рецепт)?[:\s-]*/i, "");
  if (type === "movie") {
    out = out.replace(/^(интересный\s+фильм|фильм|кино|сериал|посмотреть|запиши\s+что\s+посмотреть)[:\s-]*/i, "");
  }
  if (type === "recipe") {
    out = out.replace(/^(рецепт|сохрани\s+рецепт)[:\s-]*/i, "");
  }
  return out.trim() || text.trim();
}

function stripTaskPrefix(text) {
  let out = String(text || "").trim();
  out = out.replace(/^(задача|todo|сделать|надо|нужно|напомни|напомнить|remind\s+me)[:\s-]*/i, "");
  out = out.replace(/^(запиши|сохрани|добавь)\s+(задачу|напоминание)[:\s-]*/i, "");
  return out.trim() || String(text || "").trim();
}

function wantsReminder(text) {
  return /(напомни|напомнить|remind\b|напоминан)/i.test(String(text || ""));
}

function hasTimeHint(text) {
  const lower = String(text || "").toLowerCase();
  return /(\bсегодня\b|\bзавтра\b|\bпослезавтра\b|\bчерез\b|\bутром\b|\bвечером\b|\bдн[её]м\b|\bночью\b|\bв\s+\d{1,2}([:.]\d{2})?\b|\d{1,2}[./-]\d{1,2}|\d{4}-\d{2}-\d{2})/.test(lower);
}

function isExplicitWebSearch(text) {
  const lower = String(text || "").toLowerCase();
  return /(поищи|найди|посмотри|поиск)\s+(в\s+)?(интернете|web|сети)|погугли|web\s*search|search\s+the\s+web/.test(lower);
}

function cleanWebSearchPhrase(text) {
  return String(text || "")
    .replace(/^\s*(поищи|найди|посмотри|поиск)\s+(в\s+)?(интернете|web|сети)[:,\s-]*/i, "")
    .replace(/^\s*погугли[:,\s-]*/i, "")
    .replace(/^\s*web\s*search[:,\s-]*/i, "")
    .replace(/^\s*search\s+the\s+web[:,\s-]*/i, "")
    .trim();
}

function normalizeDueAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseSimpleDueAt(text) {
  const lower = String(text || "").toLowerCase();
  const now = new Date();

  const relative = lower.match(/через\s+(\d{1,3})\s*(минут|мин|час|часа|часов|день|дня|дней)/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const ms = unit.startsWith("мин") ? amount * 60 * 1000 : unit.startsWith("час") ? amount * 60 * 60 * 1000 : amount * 24 * 60 * 60 * 1000;
    return new Date(now.getTime() + ms).toISOString();
  }

  if (!hasTimeHint(lower)) return null;

  const parts = getMoscowDateParts(now);
  let year = parts.year;
  let month = parts.month;
  let day = parts.day;

  const dateMatch = lower.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/);
  if (dateMatch) {
    day = Number(dateMatch[1]);
    month = Number(dateMatch[2]);
    year = dateMatch[3] ? normalizeYear(dateMatch[3]) : year;
  } else {
    let dayOffset = 0;
    if (/\bзавтра\b/.test(lower)) dayOffset = 1;
    if (/\bпослезавтра\b/.test(lower)) dayOffset = 2;
    if (dayOffset) {
      const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset, 12, 0, 0));
      year = shifted.getUTCFullYear();
      month = shifted.getUTCMonth() + 1;
      day = shifted.getUTCDate();
    }
  }

  let hour = 9;
  let minute = 0;
  const clockMatch = lower.match(/\bв\s*(\d{1,2})(?:[:.](\d{2}))?\b/) || lower.match(/\b(\d{1,2}):(\d{2})\b/);
  if (clockMatch) {
    hour = Math.min(Number(clockMatch[1]), 23);
    minute = Math.min(Number(clockMatch[2] || 0), 59);
  } else if (/\bутром\b/.test(lower)) {
    hour = 9;
  } else if (/\bдн[её]м\b/.test(lower)) {
    hour = 13;
  } else if (/\bвечером\b/.test(lower)) {
    hour = 19;
  } else if (/\bночью\b/.test(lower)) {
    hour = 22;
  }

  return new Date(Date.UTC(year, month - 1, day, hour - 3, minute, 0)).toISOString();
}

function getMoscowDateParts(date) {
  const values = {};
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }

  return {
    year: values.year,
    month: values.month,
    day: values.day
  };
}

function normalizeYear(value) {
  const year = Number(value);
  if (year < 100) return 2000 + year;
  return year;
}

function formatDueAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "без даты";
  return date.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function chooseTelegramPhoto(photos) {
  const sorted = [...photos].sort((a, b) => {
    const as = a.file_size || a.width * a.height;
    const bs = b.file_size || b.width * b.height;
    return as - bs;
  });
  const belowTarget = sorted.filter((photo) => Math.max(photo.width || 0, photo.height || 0) <= IMAGE_TARGET_PX && (!photo.file_size || photo.file_size <= MAX_MEDIA_BYTES));
  if (belowTarget.length) return belowTarget[belowTarget.length - 1];
  const belowSize = sorted.filter((photo) => !photo.file_size || photo.file_size <= MAX_MEDIA_BYTES);
  if (belowSize.length) return belowSize[belowSize.length - 1];
  return sorted[0];
}

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s<>"')]+/gi) || [];
  return matches.map((url) => url.replace(/[.,!?;:]+$/g, ""));
}

function removeUrls(text) {
  return text.replace(/https?:\/\/[^\s<>"')]+/gi, " ").replace(/\s+/g, " ");
}

function titleFromText(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "Без названия";
  const firstLine = clean.split(/[.!?\n]/)[0].trim() || clean;
  return clampText(firstLine, 90);
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname || "").split("/").filter(Boolean).pop() || parsed.hostname;
    return clampText(path.replace(/[-_]+/g, " "), 100);
  } catch {
    return "Ссылка";
  }
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function fallbackSummary(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clampText(clean, 500);
}

function buildSearchText(input) {
  return clampText(normalizeWhitespace([
    input.title,
    input.summary,
    input.body,
    input.url,
    input.rawContent ? clampText(input.rawContent, 30000) : "",
    (input.tags || []).join(" "),
    safeStringify(input.metadata || {})
  ].filter(Boolean).join("\n")), MAX_SEARCH_TEXT_CHARS).toLowerCase();
}

function buildChunkSource(input) {
  return normalizeWhitespace([
    input.title,
    input.summary,
    input.body,
    input.rawContent ? clampText(input.rawContent, 26000) : ""
  ].filter(Boolean).join("\n\n"));
}

function chunkText(text) {
  const clean = normalizeWhitespace(text);
  if (!clean) return [];

  const chunks = [];
  let index = 0;
  while (index < clean.length && chunks.length < MAX_CHUNKS_PER_ITEM) {
    let end = Math.min(index + MAX_CHUNK_CHARS, clean.length);
    const boundary = clean.lastIndexOf(" ", end);
    if (boundary > index + 400) end = boundary;
    chunks.push(clean.slice(index, end).trim());
    index = end;
  }
  return chunks.filter(Boolean);
}

function tokenizeSearch(text) {
  const stopwords = new Set([
    "что", "мне", "мой", "моя", "мои", "меня", "есть", "это", "как", "где", "когда", "какой", "какая",
    "какие", "сегодня", "вечером", "найди", "покажи", "вспомни", "подбери", "посоветуй", "пожалуйста",
    "для", "про", "или", "там", "the", "and", "for", "with", "from", "what", "show", "find"
  ]);

  const parts = String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !stopwords.has(token))
    .filter((token) => new TextEncoder().encode(token).length <= 40);

  return [...new Set(parts)].slice(0, 12);
}

function normalizeTags(tags) {
  const array = Array.isArray(tags) ? tags : String(tags || "").split(/[,\n#]+/);
  const clean = array
    .map((tag) => String(tag || "").toLowerCase().trim())
    .map((tag) => tag.replace(/^#/, "").replace(/\s+/g, "-"))
    .map((tag) => tag.replace(/[^\p{L}\p{N}_-]+/gu, ""))
    .filter((tag) => tag.length >= 2 && tag.length <= 40);

  return [...new Set(clean)].slice(0, 14);
}

function normalizePeople(values) {
  const array = Array.isArray(values) ? values : String(values || "").split(/[,;]+/);
  return [...new Set(array.map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function sanitizeTypes(types) {
  const array = Array.isArray(types) ? types : [types];
  return [...new Set(array.map(ensureType).filter((type) => type && type !== "other"))].slice(0, 5);
}

function ensureType(type) {
  const clean = String(type || "").toLowerCase().trim();
  return ALLOWED_TYPES.has(clean) ? clean : "other";
}

function clampImportance(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(5, Math.round(number)));
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object in model output");
    return JSON.parse(match[0]);
  }
}

function hasOpenRouter(env) {
  return Boolean(env.OPENROUTER_API_KEY && env.OPENROUTER_MODEL);
}

function formatSearchResults(rows) {
  return rows.map((row) => {
    const date = row.created_at ? row.created_at.slice(0, 10) : "";
    const type = TYPE_LABELS[row.type] || row.type;
    const url = row.url ? `\n  ${row.url}` : "";
    const summary = row.summary ? `\n  ${clampText(row.summary, 220)}` : "";
    return `- ${row.title}\n  id: ${shortId(row.id)}; ${type}; ${date}${summary}${url}`;
  }).join("\n\n");
}

function splitTelegramText(text) {
  const clean = String(text || "");
  if (clean.length <= TELEGRAM_TEXT_LIMIT) return [clean];

  const parts = [];
  let rest = clean;
  while (rest.length > TELEGRAM_TEXT_LIMIT) {
    let end = rest.lastIndexOf("\n", TELEGRAM_TEXT_LIMIT);
    if (end < 1000) end = TELEGRAM_TEXT_LIMIT;
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function getUpdateChatId(update) {
  return update?.message?.chat?.id || update?.edited_message?.chat?.id || null;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function extensionFromMime(mime) {
  const clean = String(mime || "").toLowerCase();
  if (clean.includes("png")) return "png";
  if (clean.includes("webp")) return "webp";
  if (clean.includes("gif")) return "gif";
  if (clean.includes("jpeg") || clean.includes("jpg")) return "jpg";
  return "";
}

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function clampText(text, maxLength) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function shortId(id) {
  return String(id || "").replace(/^[a-z]+_/, "").slice(0, 8);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
