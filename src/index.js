import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { createStore } from "./db.js";
import { startDashboard } from "./dashboard.js";
import { createEmailOctopusClient } from "./emailoctopus.js";
import { createRateLimiter } from "./rate-limit.js";

loadEnvFile();

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const DATABASE_URL = process.env.DATABASE_URL || "";
const DATABASE_FILE = process.env.DATABASE_FILE || "./data/bot.sqlite";
const EXPORT_DIR = process.env.EXPORT_DIR || "./exports";
const DASHBOARD_ENABLED = process.env.DASHBOARD_ENABLED !== "false";
const DASHBOARD_HOST = process.env.DASHBOARD_HOST || "127.0.0.1";
const DASHBOARD_PORT = Number(process.env.PORT || process.env.DASHBOARD_PORT || 3000);
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "change-me";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const INIT_DATA_TTL_SECONDS = Number(process.env.INIT_DATA_TTL_SECONDS || 3600);
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || crypto.randomUUID();
const TELEGRAM_WEBHOOK_PATH = `/telegram/webhook/${TELEGRAM_WEBHOOK_SECRET}`;
const SITE_URL = PUBLIC_BASE_URL ? PUBLIC_BASE_URL.replace(/\/$/, "") : "";
const PRIVACY_URL = SITE_URL ? `${SITE_URL}/privacy` : "";
const ADMIN_SIGNUP_ALERTS = process.env.ADMIN_SIGNUP_ALERTS !== "false";
const CHAT_RATE_LIMIT_WINDOW_SECONDS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60);
const CHAT_RATE_LIMIT_MAX_HITS = Number(process.env.RATE_LIMIT_MAX_MESSAGES || 12);
const NEWSLETTER_SCHEDULE_TEXT = process.env.NEWSLETTER_SCHEDULE_TEXT || "Следующее письмо обычно приходит по пятницам.";

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in environment.");
  process.exit(1);
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_REGEX = /^[A-Za-z][A-Za-z .,'-]{1,79}$/;
const chatRateLimiter = createRateLimiter({
  windowMs: CHAT_RATE_LIMIT_WINDOW_SECONDS * 1000,
  maxHits: CHAT_RATE_LIMIT_MAX_HITS
});
let lastUpdateId = 0;

main().catch((error) => {
  console.error("Bot crashed:", error);
  process.exit(1);
});

async function main() {
  const db = await createStore({
    databaseFile: DATABASE_FILE,
    databaseUrl: DATABASE_URL
  });
  const emailOctopus = createEmailOctopusClient();

  if (DASHBOARD_ENABLED) {
    startDashboard({
      db,
      botToken: BOT_TOKEN,
      host: DASHBOARD_HOST,
      port: DASHBOARD_PORT,
      token: DASHBOARD_TOKEN,
      exportDir: EXPORT_DIR,
      initDataTtlSeconds: INIT_DATA_TTL_SECONDS,
      telegramWebhookPath: TELEGRAM_WEBHOOK_PATH,
      onTelegramUpdate: async (update) => {
        await handleUpdate(update, db, emailOctopus);
      },
      onEmailCaptured: async (contact) => {
        const result = await syncToEmailOctopus(emailOctopus, contact);
        await notifyAdminAboutSignup({
          telegram_id: contact.telegramId,
          username: contact.username,
          first_name: contact.firstName,
          last_name: contact.lastName,
          email: contact.email,
          country: contact.country,
          source: contact.source
        }, contact.method, result);
        return result;
      }
    });
  }

  await startBot(db, emailOctopus);
}

async function startBot(db, emailOctopus) {
  console.log("Bot is starting...");

  if (PUBLIC_BASE_URL) {
    await ensureWebhookMode();
    console.log(`Telegram webhook mode enabled at ${PUBLIC_BASE_URL.replace(/\/$/, "")}${TELEGRAM_WEBHOOK_PATH}`);
    return;
  }

  await ensureLongPollingMode();

  while (true) {
    try {
      const updates = await api("getUpdates", {
        offset: lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ["message"]
      });

      for (const update of updates) {
        lastUpdateId = update.update_id;
        await handleUpdate(update, db, emailOctopus);
      }
    } catch (error) {
      console.error("Polling error:", error.message);
      if (error.message.includes("Telegram HTTP 409")) {
        console.error("Telegram is refusing long polling because another bot session or webhook is active for this token.");
      }
      await sleep(3000);
    }
  }
}

async function handleUpdate(update, db, emailOctopus) {
  const message = update.message;
  if (!message || !message.chat) {
    return;
  }

  if (message.chat.type !== "private") {
    await sendMessage(
      message.chat.id,
      "Напишите мне в личные сообщения, чтобы я мог безопасно сохранить ваш email."
    );
    return;
  }

  const text = message.text?.trim();
  if (!text) {
    await sendMessage(message.chat.id, "Пожалуйста, отправляйте текстовые сообщения. Для начала используйте /start.");
    return;
  }

  if (!isAdminChat(message.chat.id)) {
    const rateLimit = chatRateLimiter.check(String(message.from.id));
    if (!rateLimit.ok) {
      await sendMessage(
        message.chat.id,
        `Слишком много сообщений за короткое время. Подождите ${rateLimit.retryAfterSeconds} сек. и попробуйте снова.`
      );
      return;
    }
  }

  const command = parseCommand(text);
  if (command?.name === "/start") {
    await handleStart(message, db, command.args);
    return;
  }

  if (command?.name === "/help") {
    await sendHelp(message.chat.id);
    return;
  }

  if (command?.name === "/export") {
    await handleExport(message.chat.id, db);
    return;
  }

  if (command?.name === "/stats") {
    await handleStats(message.chat.id, db);
    return;
  }

  if (command?.name === "/count") {
    await handleCount(message.chat.id, db);
    return;
  }

  if (command?.name === "/delete") {
    await handleDelete(message, db, emailOctopus);
    return;
  }

  if (command?.name === "/privacy") {
    await handlePrivacy(message.chat.id);
    return;
  }

  if (command?.name === "/mydata") {
    await handleMyData(message, db);
    return;
  }

  if (command?.name === "/promo") {
    await handlePromo(message.chat.id, command.args);
    return;
  }

  if (command?.name === "/skip") {
    await handleSkip(message, db, emailOctopus);
    return;
  }

  if (command && command.name.startsWith("/")) {
    await sendMessage(message.chat.id, "Я не знаю такую команду. Отправьте /help, чтобы увидеть список доступных команд.");
    return;
  }

  await handleText(message, db, emailOctopus);
}

async function handleStart(message, db, startPayload = "") {
  const userId = String(message.from.id);
  const record = await db.getUser(userId);
  const source = resolveSource(record, startPayload || getStartPayload(message.text || ""));
  const now = nowIso();

  await db.upsertUser(userId, {
    telegram_id: message.from.id,
    username: message.from.username || "",
    first_name: message.from.first_name || "",
    last_name: message.from.last_name || "",
    email: record?.email || "",
    country: record?.country || "",
    source,
    state: "awaiting_email",
    updated_at: now,
    created_at: record?.created_at || now
  });

  const lines = [
    "Спасибо, что вы здесь.",
    "",
    "Я могу сохранить один email и страну для новостей канала.",
    "",
    "Сначала просто отправьте ваш email."
  ];

  if (PUBLIC_BASE_URL) {
    lines.push("", "Если удобнее, нажмите кнопку ниже и заполните красивую форму.");
  }

  lines.push(
    "",
    "После email я попрошу указать страну.",
    "Если страну не хотите указывать, этот шаг можно будет пропустить командой /skip.",
    "",
    "Что вы получите: важные посты, объявления и редкие письма рассылки.",
    "",
    "Удалить свои данные можно командой /delete."
  );

  if (PRIVACY_URL) {
    lines.push(`Политика конфиденциальности: ${PRIVACY_URL}`);
  }

  await sendMessage(
    message.chat.id,
    [...lines, "", "Пример: name@example.com"].join("\n"),
    PUBLIC_BASE_URL ? {
      reply_markup: {
        inline_keyboard: [[{
          text: "Открыть форму",
          web_app: {
            url: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/mini-app`
          }
        }]]
      }
    } : undefined
  );
}

async function handleText(message, db, emailOctopus) {
  const userId = String(message.from.id);
  const record = await db.getUser(userId);

  if (!record) {
    await sendMessage(message.chat.id, "Чтобы начать, отправьте /start.");
    return;
  }

  if (record.state === "awaiting_email") {
    const email = normalizeEmail(message.text || "");
    if (!isValidEmail(email)) {
      await sendMessage(message.chat.id, "Похоже, это некорректный email. Попробуйте ещё раз.");
      return;
    }

    const updated = await db.upsertUser(userId, {
      ...record,
      email,
      state: "awaiting_country",
      updated_at: nowIso()
    });

    await promptCountry(message.chat.id, updated.country || "");
    return;
  }

  if (record.state === "awaiting_country") {
    const country = normalizeCountry(message.text || "");
    if (!isValidCountry(country)) {
      await sendMessage(
        message.chat.id,
        "Пожалуйста, укажите страну только на английском. Например: Russia, Germany или United Kingdom. Если хотите пропустить этот шаг, отправьте /skip."
      );
      return;
    }

    await completeSignup(message, db, emailOctopus, record, country, "chat");
    return;
  }

  await sendMessage(message.chat.id, "Если хотите обновить email или страну, отправьте /start.");
}

async function handleSkip(message, db, emailOctopus) {
  const userId = String(message.from.id);
  const record = await db.getUser(userId);

  if (!record || record.state !== "awaiting_country") {
    await sendMessage(message.chat.id, "Команда /skip сейчас не нужна. Для начала или обновления данных используйте /start.");
    return;
  }

  await completeSignup(message, db, emailOctopus, record, record.country || "", "chat");
}

async function completeSignup(message, db, emailOctopus, record, country, method) {
  const chatId = message.chat.id;
  if (!record?.email) {
    await sendMessage(chatId, "Не удалось завершить сохранение. Пожалуйста, отправьте /start и попробуйте ещё раз.");
    return;
  }

  const userId = String(record.telegram_id);
  const updated = await db.upsertUser(userId, {
    ...record,
    country,
    state: "complete",
    updated_at: nowIso()
  });

  const syncPayload = {
    telegramId: updated.telegram_id,
    username: updated.username,
    email: updated.email,
    firstName: updated.first_name,
    lastName: updated.last_name,
    country: updated.country,
    source: updated.source,
    method
  };
  const syncResult = await syncToEmailOctopus(emailOctopus, syncPayload);
  await notifyAdminAboutSignup(updated, method, syncResult);

  if (syncResult.ok) {
    await sendMessage(
      chatId,
      updated.country
        ? `Готово. Я сохранил ваш email и страну: ${updated.country}. ${NEWSLETTER_SCHEDULE_TEXT} Если захотите обновить данные позже, отправьте /start.`
        : `Готово. Я сохранил ваш email. ${NEWSLETTER_SCHEDULE_TEXT} Если захотите позже добавить или изменить страну, отправьте /start.`
    );
    return;
  }

  await sendMessage(
    chatId,
    `Данные сохранены локально, но синхронизация со списком рассылки не удалась. ${syncResult.message || "Попробуйте ещё раз чуть позже."}`
  );
}

async function promptCountry(chatId, currentCountry = "") {
  const lines = [
    "Теперь укажите вашу страну.",
    "Пожалуйста, пишите только на английском.",
    "Например: Russia, Ukraine, Kazakhstan, Germany."
  ];

  if (currentCountry) {
    lines.push(`Сейчас у вас сохранена страна: ${currentCountry}.`);
  }

  lines.push("Если не хотите указывать страну или хотите оставить текущую, отправьте /skip.");
  await sendMessage(chatId, lines.join("\n"));
}

async function handleExport(chatId, db) {
  if (!isAdminChat(chatId)) {
    await sendMessage(chatId, "У вас нет доступа к выгрузке email-списка.");
    return;
  }

  const users = (await db.listUsers()).filter((user) => user.email);
  if (users.length === 0) {
    await sendMessage(chatId, "Пока не собрано ни одного email.");
    return;
  }

  const dashboardUrl = SITE_URL
    ? `${SITE_URL}/?token=${encodeURIComponent(DASHBOARD_TOKEN)}`
    : `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/?token=${encodeURIComponent(DASHBOARD_TOKEN)}`;

  await sendMessage(
    chatId,
    DASHBOARD_ENABLED
      ? `Собрано ${users.length} email. Откройте панель и скачайте CSV: ${dashboardUrl}`
      : `Собрано ${users.length} email. Включите панель через DASHBOARD_ENABLED=true, чтобы скачать CSV.`
  );
}

async function handleStats(chatId, db) {
  if (!isAdminChat(chatId)) {
    await sendMessage(chatId, "У вас нет доступа к статистике подписок.");
    return;
  }

  const users = await db.listUsers();
  const withEmail = users.filter((user) => user.email);
  const sourceCounts = countByField(withEmail, (user) => user.source || "direct");
  const countryCounts = countByField(withEmail, (user) => user.country || "не указана");
  const sourceLines = formatBreakdown(sourceCounts);
  const countryLines = formatBreakdown(countryCounts);
  const latestUser = withEmail[0];

  await sendMessage(
    chatId,
    [
      `Всего пользователей: ${users.length}`,
      `Сохранённых email: ${withEmail.length}`,
      latestUser
        ? `Последняя заявка: ${latestUser.email} (${latestUser.source || "direct"}, ${latestUser.country || "страна не указана"})`
        : "Последняя заявка: пока нет",
      "",
      "Источники:",
      ...(sourceLines.length > 0 ? sourceLines : ["Пока нет данных."]),
      "",
      "Страны:",
      ...(countryLines.length > 0 ? countryLines : ["Пока нет данных."])
    ].join("\n")
  );
}

async function handleCount(chatId, db) {
  if (!isAdminChat(chatId)) {
    await sendMessage(chatId, "У вас нет доступа к количеству подписок.");
    return;
  }

  const users = await db.listUsers();
  const withEmail = users.filter((user) => user.email);
  await sendMessage(chatId, `Сохранённых email: ${withEmail.length}`);
}

async function handleMyData(message, db) {
  const userId = String(message.from.id);
  const record = await db.getUser(userId);

  if (!record) {
    await sendMessage(message.chat.id, "У меня пока нет сохранённых данных для этого чата. Чтобы начать, отправьте /start.");
    return;
  }

  const lines = [
    "Вот что сейчас сохранено:",
    `Telegram ID: ${record.telegram_id || userId}`,
    `Имя: ${displayName(record) || "не указано"}`,
    `Username: ${record.username ? `@${record.username}` : "не указан"}`,
    `Email: ${record.email || "не указан"}`,
    `Страна: ${record.country || "не указана"}`,
    `Источник: ${record.source || "direct"}`,
    `Статус: ${translateState(record.state)}`,
    `Обновлено: ${record.updated_at || "неизвестно"}`
  ];

  await sendMessage(message.chat.id, lines.join("\n"));
}

async function handleDelete(message, db, emailOctopus) {
  const userId = String(message.from.id);
  const record = await db.getUser(userId);

  if (!record) {
    await sendMessage(message.chat.id, "У меня нет сохранённых данных для этого чата.");
    return;
  }

  let unsubscribeResult = { ok: true, skipped: true };
  if (record.email) {
    unsubscribeResult = await unsubscribeFromEmailOctopus(emailOctopus, {
      email: record.email,
      telegramId: record.telegram_id,
      username: record.username,
      firstName: record.first_name,
      lastName: record.last_name,
      country: record.country,
      source: record.source,
      method: "chat"
    });
  }

  await db.deleteUser(userId);

  await sendMessage(
    message.chat.id,
    unsubscribeResult.ok
      ? "Ваш email и локальные данные подписки удалены. Если захотите подписаться снова, отправьте /start."
      : `Локальные данные удалены, но отписка в сервисе рассылки не удалась. ${unsubscribeResult.message || "Проверьте EmailOctopus вручную."}`
  );
}

async function handlePrivacy(chatId) {
  const lines = [
    "Кратко о конфиденциальности:",
    "Я храню ваш Telegram ID, базовые поля профиля, источник подписки, текущий email и указанную страну.",
    "Эти данные используются для управления email-подписками канала.",
    "Если включён EmailOctopus, ваш email также отправляется туда для доставки писем.",
    "Удалить локальные данные можно в любой момент командой /delete."
  ];

  if (PRIVACY_URL) {
    lines.push(`Полная страница: ${PRIVACY_URL}`);
  }

  await sendMessage(chatId, lines.join("\n"));
}

async function handlePromo(chatId, args) {
  if (!isAdminChat(chatId)) {
    await sendMessage(chatId, "У вас нет доступа к генерации промо-текста.");
    return;
  }

  if (!BOT_USERNAME) {
    await sendMessage(chatId, "Сначала задайте BOT_USERNAME, чтобы я мог собрать ссылку для канала.");
    return;
  }

  const source = args ? sanitizeStartPayload(args) : "channel";
  const signupLink = `https://t.me/${BOT_USERNAME}?start=${source}`;
  const promo = [
    "Оставайтесь на связи с «Немного Нервно».",
    "Получайте важные посты, объявления и редкие письма рассылки на email.",
    "",
    `Подписаться: ${signupLink}`
  ];

  if (PRIVACY_URL) {
    promo.push(`Конфиденциальность: ${PRIVACY_URL}`);
  }

  await sendMessage(chatId, promo.join("\n"));
}

async function sendHelp(chatId) {
  await sendMessage(
    chatId,
    [
      "/start - начать или заново пройти подписку",
      "/help - показать помощь",
      "/mydata - показать, какие данные сейчас сохранены",
      "/privacy - как используются ваши данные",
      "/delete - удалить сохранённые данные",
      "/skip - пропустить шаг со страной",
      "/stats - админская статистика подписок",
      "/count - админское количество email",
      "/promo [source] - админский текст для поста со ссылкой и меткой источника",
      "/export - ссылка на панель и CSV для администратора",
      PUBLIC_BASE_URL ? "Mini App включена: можно подписываться через кнопку в чате." : "Укажите PUBLIC_BASE_URL, чтобы включить кнопку Mini App."
    ].join("\n")
  );
}

function getStartPayload(text) {
  const payload = text.split(/\s+/, 2)[1];
  return payload || "direct";
}

function resolveSource(record, payload) {
  const nextSource = sanitizeStartPayload(payload || "direct");
  if (nextSource && nextSource !== "direct") {
    return nextSource;
  }

  return record?.source || "direct";
}

function parseCommand(text) {
  if (!text.startsWith("/")) {
    return null;
  }

  const [rawCommand, ...rest] = text.split(/\s+/);
  const normalizedName = rawCommand.split("@")[0].toLowerCase();
  return {
    name: normalizedName,
    args: rest.join(" ").trim()
  };
}

function sanitizeStartPayload(value) {
  const source = String(value || "direct").trim().toLowerCase();
  if (!source) {
    return "direct";
  }

  return source.replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "direct";
}

function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

function normalizeCountry(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function isValidEmail(value) {
  return EMAIL_REGEX.test(value);
}

function isValidCountry(value) {
  return COUNTRY_REGEX.test(value);
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMessage(chatId, text, extra = {}) {
  await api("sendMessage", {
    chat_id: chatId,
    text,
    ...extra
  });
}

async function api(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram API error in ${method}`);
  }

  return data.result;
}

async function ensureLongPollingMode() {
  try {
    await api("deleteWebhook", {
      drop_pending_updates: false
    });
  } catch (error) {
    console.error("Could not clear webhook before long polling:", error.message);
  }
}

async function ensureWebhookMode() {
  const webhookUrl = `${PUBLIC_BASE_URL.replace(/\/$/, "")}${TELEGRAM_WEBHOOK_PATH}`;

  try {
    await api("setWebhook", {
      url: webhookUrl,
      allowed_updates: ["message"],
      drop_pending_updates: false
    });
  } catch (error) {
    console.error("Could not set Telegram webhook:", error.message);
    throw error;
  }
}

async function syncToEmailOctopus(client, contact) {
  if (!client) {
    return { ok: true, skipped: true };
  }

  const result = await client.upsertContact(contact);
  if (!result.ok) {
    console.error("EmailOctopus sync failed:", result.error?.code || result.status || "UNKNOWN");
  }

  return result;
}

async function unsubscribeFromEmailOctopus(client, contact) {
  if (!client) {
    return { ok: true, skipped: true };
  }

  const result = await client.unsubscribeContact(contact);
  if (!result.ok) {
    console.error("EmailOctopus unsubscribe failed:", result.error?.code || result.status || "UNKNOWN");
  }

  return result;
}

async function notifyAdminAboutSignup(record, method, syncResult) {
  if (!ADMIN_SIGNUP_ALERTS || !ADMIN_CHAT_ID || !record?.email) {
    return;
  }

  const lines = [
    "Новая или обновлённая подписка:",
    `Email: ${record.email}`,
    `Страна: ${record.country || "не указана"}`,
    `Источник: ${record.source || "direct"}`,
    `Метод: ${method}`,
    `Пользователь: ${displayName(record) || "без имени"}${record.username ? ` (@${record.username})` : ""}`
  ];

  if (!syncResult.ok) {
    lines.push(`Синхронизация с рассылкой: ошибка (${syncResult.message || "без деталей"})`);
  }

  try {
    await sendMessage(ADMIN_CHAT_ID, lines.join("\n"));
  } catch (error) {
    console.error("Admin signup alert failed:", error.message);
  }
}

function countByField(users, selector) {
  const counts = {};
  for (const user of users) {
    const value = selector(user);
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function formatBreakdown(counts) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .map(([label, count]) => `${label}: ${count}`);
}

function displayName(record) {
  return [record?.first_name, record?.last_name].filter(Boolean).join(" ");
}

function translateState(state) {
  if (state === "awaiting_email") {
    return "ожидается email";
  }
  if (state === "awaiting_country") {
    return "ожидается страна";
  }
  if (state === "complete") {
    return "подписка завершена";
  }
  return state || "неизвестно";
}

function isAdminChat(chatId) {
  return Boolean(ADMIN_CHAT_ID) && String(chatId) === String(ADMIN_CHAT_ID);
}

function loadEnvFile() {
  const envPath = path.resolve(".env");
  if (!existsSync(envPath)) {
    return;
  }

  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (key && !process.env[key]) {
      process.env[key] = stripQuotes(value);
    }
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
