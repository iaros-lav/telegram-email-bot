import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { createStore } from "./db.js";
import { startDashboard } from "./dashboard.js";
import { createEmailOctopusClient } from "./emailoctopus.js";

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

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in environment.");
  process.exit(1);
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
        return syncToEmailOctopus(emailOctopus, contact);
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
      "Please message me in a private chat so I can safely collect your email."
    );
    return;
  }

  const text = message.text?.trim();
  if (!text) {
    await sendMessage(message.chat.id, "Please send text only. Use /start to begin.");
    return;
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

  if (command?.name === "/promo") {
    await handlePromo(message.chat.id, command.args);
    return;
  }

  if (command && command.name.startsWith("/")) {
    await sendMessage(message.chat.id, "I don't know that command. Use /help to see what I can do.");
    return;
  }

  await handleText(message, db, emailOctopus);
}

async function handleStart(message, db, startPayload = "") {
  const userId = String(message.from.id);
  const record = await db.getUser(userId);
  const source = resolveSource(record, startPayload || getStartPayload(message.text || ""));

  await db.upsertUser(userId, {
    telegram_id: message.from.id,
    username: message.from.username || "",
    first_name: message.from.first_name || "",
    last_name: message.from.last_name || "",
    email: record?.email || "",
    source,
    state: "awaiting_email",
    updated_at: nowIso(),
    created_at: record?.created_at || nowIso()
  });

  const lines = [
    "Thanks for being here.",
    "",
    "I can save one email address for updates from the channel.",
    "",
    "Reply with your best email address."
  ];

  if (PUBLIC_BASE_URL) {
    lines.push("", "If you prefer, tap the button below for a cleaner signup form.");
  }

  lines.push(
    "",
    "What you’ll get: important posts, announcements, and occasional newsletter updates.",
    "",
    "You can remove your data anytime with /delete."
  );

  if (PRIVACY_URL) {
    lines.push(`Privacy: ${PRIVACY_URL}`);
  }

  await sendMessage(
    message.chat.id,
    [...lines, "", "Example: name@example.com"].join("\n"),
    PUBLIC_BASE_URL ? {
      reply_markup: {
        inline_keyboard: [[{
          text: "Open Email Form",
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

  if (!record || record.state !== "awaiting_email") {
    await sendMessage(message.chat.id, "Send /start to begin the email registration flow.");
    return;
  }

  const email = normalizeEmail(message.text || "");
  if (!isValidEmail(email)) {
    await sendMessage(message.chat.id, "That doesn't look like a valid email. Please try again.");
    return;
  }

  await db.upsertUser(userId, {
    ...record,
    email,
    state: "complete",
    updated_at: nowIso()
  });

  const syncResult = await syncToEmailOctopus(emailOctopus, {
    email,
    firstName: record.first_name,
    lastName: record.last_name,
    source: record.source,
    method: "chat"
  });

  await sendMessage(
    message.chat.id,
    syncResult.ok
      ? "Thanks. Your email has been saved. Send /start anytime if you want to update it."
      : `Thanks. Your email was saved locally, but the mailing-list sync failed. ${syncResult.message || "Please try again in a moment."}`
  );
}

async function handleExport(chatId, db) {
  if (!isAdminChat(chatId)) {
    await sendMessage(chatId, "You are not allowed to export the email list.");
    return;
  }

  const users = (await db.listUsers()).filter((user) => user.email);
  if (users.length === 0) {
    await sendMessage(chatId, "No emails have been collected yet.");
    return;
  }

  const dashboardUrl = SITE_URL
    ? `${SITE_URL}/?token=${encodeURIComponent(DASHBOARD_TOKEN)}`
    : `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/?token=${encodeURIComponent(DASHBOARD_TOKEN)}`;
  await sendMessage(
    chatId,
    DASHBOARD_ENABLED
      ? `Found ${users.length} collected emails. Open the local dashboard for CSV download: ${dashboardUrl}`
      : `Found ${users.length} collected emails. Enable the dashboard with DASHBOARD_ENABLED=true to download CSV locally.`
  );
}

async function handleStats(chatId, db) {
  if (!isAdminChat(chatId)) {
    await sendMessage(chatId, "You are not allowed to view signup stats.");
    return;
  }

  const users = await db.listUsers();
  const withEmail = users.filter((user) => user.email);
  const sourceCounts = countBySource(withEmail);
  const sourceLines = Object.entries(sourceCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([source, count]) => `${source}: ${count}`);

  const latestUser = withEmail[0];
  await sendMessage(
    chatId,
    [
      `Total users seen: ${users.length}`,
      `Saved emails: ${withEmail.length}`,
      latestUser ? `Latest signup: ${latestUser.email} (${latestUser.source || "direct"})` : "Latest signup: none yet",
      "",
      "Sources:",
      ...(sourceLines.length > 0 ? sourceLines : ["No source data yet."])
    ].join("\n")
  );
}

async function handleCount(chatId, db) {
  if (!isAdminChat(chatId)) {
    await sendMessage(chatId, "You are not allowed to view signup counts.");
    return;
  }

  const users = await db.listUsers();
  const withEmail = users.filter((user) => user.email);
  await sendMessage(chatId, `Saved emails: ${withEmail.length}`);
}

async function handleDelete(message, db, emailOctopus) {
  const userId = String(message.from.id);
  const record = await db.getUser(userId);

  if (!record) {
    await sendMessage(message.chat.id, "I don't have any saved data for this chat.");
    return;
  }

  let unsubscribeResult = { ok: true, skipped: true };
  if (record.email) {
    unsubscribeResult = await unsubscribeFromEmailOctopus(emailOctopus, {
      email: record.email,
      firstName: record.first_name,
      lastName: record.last_name,
      source: record.source,
      method: "chat"
    });
  }

  await db.deleteUser(userId);

  await sendMessage(
    message.chat.id,
    unsubscribeResult.ok
      ? "Your saved email and local signup data have been deleted. You can use /start anytime to sign up again."
      : `Your local signup data was deleted, but the mailing-list unsubscribe failed. ${unsubscribeResult.message || "Please check EmailOctopus manually."}`
  );
}

async function handlePrivacy(chatId) {
  const lines = [
    "Privacy summary:",
    "I store your Telegram ID, basic profile fields, signup source, and your current email address.",
    "That data is used to manage channel email signups.",
    "If EmailOctopus is enabled, your email is also sent there for newsletter delivery.",
    "Use /delete anytime to remove your saved local data."
  ];

  if (PRIVACY_URL) {
    lines.push(`Full privacy page: ${PRIVACY_URL}`);
  }

  await sendMessage(chatId, lines.join("\n"));
}

async function handlePromo(chatId, args) {
  if (!isAdminChat(chatId)) {
    await sendMessage(chatId, "You are not allowed to generate promo copy.");
    return;
  }

  if (!BOT_USERNAME) {
    await sendMessage(chatId, "Set BOT_USERNAME first so I can generate a channel signup link.");
    return;
  }

  const source = args ? sanitizeStartPayload(args) : "channel";
  const signupLink = `https://t.me/${BOT_USERNAME}?start=${source}`;
  const promo = [
    "Stay in touch with Немного Нервно.",
    "Get important posts, announcements, and occasional newsletter updates by email.",
    "",
    `Sign up here: ${signupLink}`
  ];

  if (PRIVACY_URL) {
    promo.push(`Privacy: ${PRIVACY_URL}`);
  }

  await sendMessage(chatId, promo.join("\n"));
}

async function sendHelp(chatId) {
  await sendMessage(
    chatId,
    [
      "/start - start or restart email collection",
      "/help - show help",
      "/privacy - how your data is used",
      "/delete - delete your saved local data",
      "/stats - admin signup stats",
      "/count - admin email count",
      "/promo [source] - admin channel post copy with tracking link",
      "/export - admin-only dashboard link",
      PUBLIC_BASE_URL ? "Mini App is enabled for one-tap signup." : "Set PUBLIC_BASE_URL to enable the Mini App button."
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

function isValidEmail(value) {
  return EMAIL_REGEX.test(value);
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

function countBySource(users) {
  const counts = {};
  for (const user of users) {
    const source = user.source || "direct";
    counts[source] = (counts[source] || 0) + 1;
  }
  return counts;
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
