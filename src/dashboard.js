import { createServer } from "node:http";
import path from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_REGEX = /^[A-Za-z][A-Za-z .,'-]{1,79}$/;

export function startDashboard({
  db,
  botToken,
  host,
  port,
  token,
  exportDir,
  initDataTtlSeconds,
  telegramWebhookPath,
  onTelegramUpdate,
  onEmailCaptured
}) {
  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      db,
      botToken,
      token,
      exportDir,
      initDataTtlSeconds,
      telegramWebhookPath,
      onTelegramUpdate,
      onEmailCaptured
    });
  });

  server.on("error", (error) => {
    console.error(`Dashboard failed to start on ${host}:${port}: ${error.message}`);
  });

  server.listen(port, host, () => {
    console.log(`Dashboard running on http://${host}:${port}/?token=${token}`);
  });

  return server;
}

async function handleRequest(
  request,
  response,
  {
    db,
    botToken,
    token,
    exportDir,
    initDataTtlSeconds,
    telegramWebhookPath,
    onTelegramUpdate,
    onEmailCaptured
  }
) {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const normalizedPath = normalizePath(requestUrl.pathname);
    const routeIsPublic = isPublicRoute(request.method, requestUrl.pathname);

    if (request.method === "POST" && normalizedPath === normalizePath(telegramWebhookPath)) {
      const update = await readJsonBody(request);
      await onTelegramUpdate(update);
      respondJson(response, 200, { ok: true });
      return;
    }

    if (!routeIsPublic && !isAuthorized(requestUrl, token)) {
      respondText(response, 401, "Неавторизованный запрос к панели.");
      return;
    }

    if (request.method === "GET" && normalizedPath === "/health") {
      respondJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && normalizedPath === "/api/users") {
      respondJson(response, 200, {
        stats: await db.getStats(),
        users: await db.listUsers()
      });
      return;
    }

    if (request.method === "GET" && normalizedPath === "/export.csv") {
      const users = (await db.listUsers()).filter((user) => user.email);
      const exportPath = writeCsvExport(users, exportDir);
      const csv = buildCsv(users);

      response.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${path.basename(exportPath)}"`
      });
      response.end(csv);
      return;
    }

    if (request.method === "GET" && normalizedPath === "/mini-app") {
      respondHtml(response, renderMiniApp());
      return;
    }

    if (request.method === "GET" && normalizedPath === "/privacy") {
      respondHtml(response, renderPrivacyPage());
      return;
    }

    if (request.method === "POST" && normalizedPath === "/api/mini-app/submit") {
      await handleMiniAppSubmit(request, response, db, botToken, initDataTtlSeconds, onEmailCaptured);
      return;
    }

    if (request.method === "GET" && normalizedPath === "/") {
      respondHtml(response, await renderDashboard(db, token));
      return;
    }

    respondText(response, 404, "Не найдено.");
  } catch (error) {
    console.error("Dashboard request failed:", error);
    respondText(response, 500, "Внутренняя ошибка сервера.");
  }
}

export async function readJsonBody(request) {
  let rawBody = "";

  return new Promise((resolve, reject) => {
    request.on("data", (chunk) => {
      rawBody += chunk;
      if (rawBody.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(rawBody || "{}"));
      } catch {
        reject(new Error("Invalid request body."));
      }
    });

    request.on("error", reject);
  });
}

async function renderDashboard(db, token) {
  const stats = await db.getStats();
  const users = (await db.listUsers()).filter((user) => user.email);

  const rows = users.map((user) => `
    <tr>
      <td>${escapeHtml(user.telegram_id)}</td>
      <td>${escapeHtml(user.email)}</td>
      <td>${escapeHtml(user.country || "")}</td>
      <td>${escapeHtml(displayName(user))}</td>
      <td>${escapeHtml(user.username ? `@${user.username}` : "")}</td>
      <td>${escapeHtml(user.source || "")}</td>
      <td>${escapeHtml(user.updated_at || "")}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Панель подписок Telegram</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f0e8;
        --panel: rgba(255, 251, 245, 0.9);
        --ink: #1f1a17;
        --muted: #6d625b;
        --accent: #b6542f;
        --line: rgba(31, 26, 23, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Iowan Old Style", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(182, 84, 47, 0.18), transparent 32%),
          linear-gradient(180deg, #fbf5ef 0%, var(--bg) 100%);
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }
      .hero {
        display: grid;
        gap: 16px;
        margin-bottom: 24px;
      }
      h1 {
        margin: 0;
        font-size: clamp(2rem, 4vw, 3.5rem);
        line-height: 0.95;
      }
      p {
        margin: 0;
        max-width: 720px;
        color: var(--muted);
        font-size: 1.05rem;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 14px;
        margin: 28px 0;
      }
      .card, .table-wrap {
        background: var(--panel);
        backdrop-filter: blur(10px);
        border: 1px solid var(--line);
        border-radius: 20px;
        box-shadow: 0 12px 32px rgba(59, 33, 18, 0.08);
      }
      .card {
        padding: 18px;
      }
      .label {
        display: block;
        font-size: 0.85rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
        margin-bottom: 10px;
      }
      .value {
        font-size: 2rem;
      }
      .actions {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 24px;
      }
      a.button {
        display: inline-block;
        text-decoration: none;
        color: #fffaf5;
        background: var(--accent);
        border-radius: 999px;
        padding: 12px 18px;
      }
      .ghost {
        color: var(--ink);
        background: transparent;
        border: 1px solid var(--line);
      }
      .table-wrap {
        overflow: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 900px;
      }
      th, td {
        padding: 14px 16px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      th {
        font-size: 0.85rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .empty {
        padding: 24px 16px;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <h1>Подписки по email</h1>
        <p>Здесь собраны email-адреса, страны и источники подписки из Telegram-бота. Панель читает данные прямо из вашей базы и позволяет быстро выгрузить CSV.</p>
      </section>
      <section class="stats">
        <article class="card">
          <span class="label">Всего пользователей</span>
          <strong class="value">${stats.total_users}</strong>
        </article>
        <article class="card">
          <span class="label">Сохранённых email</span>
          <strong class="value">${stats.email_count}</strong>
        </article>
        <article class="card">
          <span class="label">Запусков из канала</span>
          <strong class="value">${stats.channel_count}</strong>
        </article>
      </section>
      <section class="actions">
        <a class="button" href="/export.csv?token=${encodeURIComponent(token)}">Скачать CSV</a>
        <a class="button ghost" href="/api/users?token=${encodeURIComponent(token)}">Открыть JSON</a>
      </section>
      <section class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Telegram ID</th>
              <th>Email</th>
              <th>Страна</th>
              <th>Имя</th>
              <th>Username</th>
              <th>Источник</th>
              <th>Обновлено</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td class="empty" colspan="7">Пока нет сохранённых email.</td></tr>`}
          </tbody>
        </table>
      </section>
    </main>
  </body>
</html>`;
}

function renderMiniApp() {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Подписка по email</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      :root {
        --bg: #fbf4ea;
        --panel: rgba(255, 251, 245, 0.96);
        --ink: #1f1a17;
        --muted: #6d625b;
        --accent: #b6542f;
        --accent-dark: #964221;
        --line: rgba(31, 26, 23, 0.12);
        --success: #23643b;
        --danger: #b23a2b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Iowan Old Style", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(182, 84, 47, 0.2), transparent 32%),
          linear-gradient(180deg, #fffaf4 0%, var(--bg) 100%);
      }
      main {
        max-width: 640px;
        margin: 0 auto;
        padding: 28px 18px 40px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 24px;
        box-shadow: 0 16px 40px rgba(59, 33, 18, 0.08);
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(2rem, 8vw, 3.4rem);
        line-height: 0.95;
      }
      p {
        color: var(--muted);
        margin: 0 0 18px;
        line-height: 1.5;
      }
      label {
        display: block;
        margin-bottom: 8px;
        font-size: 0.95rem;
      }
      input {
        width: 100%;
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid var(--line);
        font: inherit;
        background: #fffdf9;
        margin-bottom: 14px;
      }
      button {
        width: 100%;
        border: 0;
        border-radius: 999px;
        padding: 14px 18px;
        font: inherit;
        color: #fffaf5;
        background: linear-gradient(180deg, var(--accent), var(--accent-dark));
      }
      .note {
        font-size: 0.92rem;
      }
      .message {
        margin-top: 14px;
        padding: 12px 14px;
        border-radius: 16px;
        display: none;
      }
      .success-panel {
        display: none;
        margin-top: 18px;
        padding: 16px;
        border-radius: 20px;
        background: rgba(35, 100, 59, 0.08);
        color: var(--success);
      }
      .success-panel.show { display: block; }
      .message.show { display: block; }
      .message.success { background: rgba(35, 100, 59, 0.1); color: var(--success); }
      .message.error { background: rgba(178, 58, 43, 0.1); color: var(--danger); }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h1>Оставайтесь на связи</h1>
        <p>Оставьте email и страну, чтобы получать обновления этого Telegram-канала. Позже вы сможете изменить данные, снова открыв эту форму или отправив боту <strong>/start</strong>.</p>
        <form id="signup-form">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" placeholder="name@example.com" required>
          <label for="country">Страна</label>
          <input id="country" name="country" type="text" autocomplete="country-name" placeholder="Например, Russia">
          <button type="submit">Сохранить данные</button>
        </form>
        <p id="note" class="note">Отправляя форму, вы соглашаетесь, что владелец канала может хранить ваш email и страну для связи и рассылки новостей.</p>
        <section id="success-panel" class="success-panel">
          <strong>Готово, вы в списке.</strong>
          <p>Окно можно закрыть. Если захотите удалить данные позже, отправьте боту <strong>/delete</strong>.</p>
        </section>
        <div id="message" class="message"></div>
      </section>
    </main>
    <script>
      const webApp = window.Telegram?.WebApp;
      if (webApp) {
        webApp.ready();
        webApp.expand();
      }

      const form = document.getElementById("signup-form");
      const message = document.getElementById("message");
      const note = document.getElementById("note");
      const successPanel = document.getElementById("success-panel");
      const emailInput = document.getElementById("email");
      const countryInput = document.getElementById("country");

      form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const email = emailInput.value.trim();
        const country = countryInput.value.trim();
        const initData = webApp?.initData || "";

        if (!initData) {
          showMessage("Эту Mini App нужно открывать прямо из Telegram, чтобы бот понял, кто отправляет форму.", "error");
          return;
        }

        try {
          const response = await fetch("/api/mini-app/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email,
              country,
              init_data: initData,
              user: webApp?.initDataUnsafe?.user || null,
              source: webApp?.initDataUnsafe?.start_param || null
            })
          });

          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || "Не удалось сохранить данные.");
          }

          showSuccess();
          if (webApp) {
            webApp.MainButton.setText("Закрыть");
            webApp.MainButton.show();
            webApp.onEvent("mainButtonClicked", () => webApp.close());
          }
        } catch (error) {
          showMessage(error.message, "error");
        }
      });

      function showSuccess() {
        message.className = "message";
        form.style.display = "none";
        note.style.display = "none";
        successPanel.classList.add("show");
      }

      function showMessage(text, kind) {
        message.textContent = text;
        message.className = "message show " + kind;
      }
    </script>
  </body>
</html>`;
}

function renderPrivacyPage() {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Политика конфиденциальности</title>
    <style>
      :root {
        --bg: #fbf6ef;
        --panel: #fffdf9;
        --ink: #231b16;
        --muted: #675c54;
        --line: rgba(35, 27, 22, 0.1);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Iowan Old Style", serif;
        color: var(--ink);
        background: linear-gradient(180deg, #fffaf4, var(--bg));
      }
      main {
        max-width: 760px;
        margin: 0 auto;
        padding: 32px 20px 60px;
      }
      article {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 28px;
      }
      h1 {
        margin-top: 0;
        font-size: clamp(2rem, 6vw, 3.2rem);
        line-height: 0.95;
      }
      p, li {
        color: var(--muted);
        line-height: 1.6;
      }
      ul {
        padding-left: 20px;
      }
    </style>
  </head>
  <body>
    <main>
      <article>
        <h1>Конфиденциальность</h1>
        <p>Этот бот сохраняет Telegram ID, базовые публичные поля профиля, источник подписки, один текущий email и указанную страну, чтобы владелец канала мог управлять подписками на рассылку.</p>
        <p>Если включён EmailOctopus, отправленный email также передаётся туда для доставки писем.</p>
        <ul>
          <li>Email используется для новостей канала, объявлений и редких писем рассылки.</li>
          <li>Страна нужна для сегментации аудитории и более понятной аналитики.</li>
          <li>Локальные данные можно удалить в любой момент командой <strong>/delete</strong>.</li>
          <li>Изменить email или страну можно в любой момент, отправив <strong>/start</strong> заново.</li>
        </ul>
      </article>
    </main>
  </body>
</html>`;
}

function writeCsvExport(users, exportDir) {
  const resolvedDir = path.resolve(exportDir);
  if (!existsSync(resolvedDir)) {
    mkdirSync(resolvedDir, { recursive: true });
  }

  const exportPath = path.join(
    resolvedDir,
    `emails-${new Date().toISOString().replaceAll(":", "-")}.csv`
  );
  writeFileSync(exportPath, buildCsv(users), "utf8");
  return exportPath;
}

function buildCsv(users) {
  const rows = users.map((user) =>
    [
      user.telegram_id,
      user.username,
      user.first_name,
      user.last_name,
      user.email,
      user.country,
      user.source,
      user.created_at,
      user.updated_at
    ].map(toCsvCell).join(",")
  );

  return [
    "telegram_id,username,first_name,last_name,email,country,source,created_at,updated_at",
    ...rows
  ].join("\n");
}

function toCsvCell(value) {
  const stringValue = String(value || "");
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function displayName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ");
}

async function handleMiniAppSubmit(request, response, db, botToken, initDataTtlSeconds, onEmailCaptured) {
  try {
    const payload = await readJsonBody(request);
    const email = String(payload.email || "").trim().toLowerCase();
    const country = normalizeCountry(payload.country || "");
    const user = payload.user || null;

    if (!user?.id) {
      respondJson(response, 400, { error: "Не удалось определить пользователя Telegram." });
      return;
    }

    if (!EMAIL_REGEX.test(email)) {
      respondJson(response, 400, { error: "Пожалуйста, введите корректный email." });
      return;
    }

    if (country && !isValidCountry(country)) {
      respondJson(response, 400, { error: "Пожалуйста, укажите страну только на английском. Например: Russia или Germany." });
      return;
    }

    const telegramId = String(user.id);
    const existing = await db.getUser(telegramId);
    const now = new Date().toISOString();
    const source = String(payload.source || existing?.source || "mini_app");
    const finalCountry = country || existing?.country || "";

    await db.upsertUser(telegramId, {
      telegram_id: telegramId,
      username: String(user.username || existing?.username || ""),
      first_name: String(user.first_name || existing?.first_name || ""),
      last_name: String(user.last_name || existing?.last_name || ""),
      email,
      country: finalCountry,
      source,
      state: "complete",
      created_at: existing?.created_at || now,
      updated_at: now
    });

    const syncResult = await onEmailCaptured({
      email,
      firstName: String(user.first_name || existing?.first_name || ""),
      lastName: String(user.last_name || existing?.last_name || ""),
      country: finalCountry,
      source,
      method: "mini_app"
    });

    if (!syncResult.ok) {
      respondJson(response, 502, { error: "Данные сохранены локально, но синхронизация с рассылкой не удалась." });
      return;
    }

    respondJson(response, 200, { ok: true });
  } catch {
    respondJson(response, 400, { error: "Некорректное тело запроса." });
  }
}

function isPublicRoute(method, pathname) {
  const normalizedPath = normalizePath(pathname);
  return (
    (method === "GET" && normalizedPath === "/health") ||
    (method === "GET" && normalizedPath === "/mini-app") ||
    (method === "GET" && normalizedPath === "/privacy") ||
    (method === "POST" && normalizedPath === "/api/mini-app/submit")
  );
}

function normalizePath(pathname) {
  if (!pathname || pathname === "/") {
    return "/";
  }

  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function isAuthorized(requestUrl, token) {
  return requestUrl.searchParams.get("token") === token;
}

function normalizeCountry(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function isValidCountry(value) {
  return COUNTRY_REGEX.test(value);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function respondText(response, statusCode, text) {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

function respondJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function respondHtml(response, html) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}
