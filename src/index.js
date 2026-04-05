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

  if (text.startsWith("/start")) {
    await handleStart(message, db);
    return;
  }

  if (text === "/help") {
    await sendHelp(message.chat.id);
    return;
  }

  if (text === "/export") {
    await handleExport(message.chat.id, db);
    return;
  }

  await handleText(message, db, emailOctopus);
}

async function handleStart(message, db) {
  const userId = String(message.from.id);
  const record = await db.getUser(userId);
  const source = getStartPayload(message.text || "");

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

  const channelHint = BOT_USERNAME
    ? `Channel signup link: https://t.me/${BOT_USERNAME}?start=channel`
    : "Set BOT_USERNAME in your .env so the channel signup link can be shown here.";

  const lines = [
    "Welcome. I can register your email for updates.",
    "",
    "Please reply with your email address."
  ];

  if (PUBLIC_BASE_URL) {
    lines.push("", "If you prefer, tap the button below for a cleaner signup form.");
  }

  await sendMessage(
    message.chat.id,
    [
      ...lines,
      "",
      "By sending it, you agree that the channel owner may store it for contact or newsletter purposes.",
      "",
      "Example: name@example.com",
      "",
      channelHint
    ].join("\n"),
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
    lastName: record.last_name
  });

  await sendMessage(
    message.chat.id,
    syncResult.ok
      ? "Thanks. Your email has been saved. Send /start anytime if you want to update it."
      : "Thanks. Your email was saved locally, but the mailing-list sync failed. Please try again in a moment."
  );
}

async function handleExport(chatId, db) {
  if (!ADMIN_CHAT_ID || String(chatId) !== String(ADMIN_CHAT_ID)) {
    await sendMessage(chatId, "You are not allowed to export the email list.");
    return;
  }

  const users = (await db.listUsers()).filter((user) => user.email);
  if (users.length === 0) {
    await sendMessage(chatId, "No emails have been collected yet.");
    return;
  }

  const dashboardUrl = `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/?token=${encodeURIComponent(DASHBOARD_TOKEN)}`;
  await sendMessage(
    chatId,
    DASHBOARD_ENABLED
      ? `Found ${users.length} collected emails. Open the local dashboard for CSV download: ${dashboardUrl}`
      : `Found ${users.length} collected emails. Enable the dashboard with DASHBOARD_ENABLED=true to download CSV locally.`
  );
}

async function sendHelp(chatId) {
  await sendMessage(
    chatId,
    [
      "/start - start or restart email collection",
      "/help - show help",
      "/export - admin-only dashboard link",
      PUBLIC_BASE_URL ? "Mini App is enabled for one-tap signup." : "Set PUBLIC_BASE_URL to enable the Mini App button."
    ].join("\n")
  );
}

function getStartPayload(text) {
  const payload = text.split(/\s+/, 2)[1];
  return payload || "direct";
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
