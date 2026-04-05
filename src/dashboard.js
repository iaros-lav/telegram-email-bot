import { createServer } from "node:http";
import path from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
      respondText(response, 401, "Unauthorized dashboard request.");
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

    if (request.method === "POST" && normalizedPath === "/api/mini-app/submit") {
      await handleMiniAppSubmit(request, response, db, botToken, initDataTtlSeconds, onEmailCaptured);
      return;
    }

    if (request.method === "GET" && normalizedPath === "/") {
      respondHtml(response, await renderDashboard(db, token));
      return;
    }

    respondText(response, 404, "Not found.");
  } catch (error) {
    console.error("Dashboard request failed:", error);
    respondText(response, 500, "Internal server error.");
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
      <td>${escapeHtml(displayName(user))}</td>
      <td>${escapeHtml(user.username ? `@${user.username}` : "")}</td>
      <td>${escapeHtml(user.source || "")}</td>
      <td>${escapeHtml(user.updated_at || "")}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Telegram Email Bot Dashboard</title>
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
        max-width: 1080px;
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
        min-width: 760px;
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
        <h1>Email Signups</h1>
        <p>Your Telegram bot is collecting emails in private chat. This dashboard reads directly from the SQLite database and stays local unless you deploy it somewhere else.</p>
      </section>
      <section class="stats">
        <article class="card">
          <span class="label">Users Seen</span>
          <strong class="value">${stats.total_users}</strong>
        </article>
        <article class="card">
          <span class="label">Emails Collected</span>
          <strong class="value">${stats.email_count}</strong>
        </article>
        <article class="card">
          <span class="label">Channel Starts</span>
          <strong class="value">${stats.channel_count}</strong>
        </article>
      </section>
      <section class="actions">
        <a class="button" href="/export.csv?token=${encodeURIComponent(token)}">Download CSV</a>
        <a class="button ghost" href="/api/users?token=${encodeURIComponent(token)}">View JSON</a>
      </section>
      <section class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Telegram ID</th>
              <th>Email</th>
              <th>Name</th>
              <th>Username</th>
              <th>Source</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td class="empty" colspan="6">No emails collected yet.</td></tr>`}
          </tbody>
        </table>
      </section>
    </main>
  </body>
</html>`;
}

function renderMiniApp() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Email Signup</title>
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
      .message.show { display: block; }
      .message.success { background: rgba(35, 100, 59, 0.1); color: var(--success); }
      .message.error { background: rgba(178, 58, 43, 0.1); color: var(--danger); }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h1>Stay In Touch</h1>
        <p>Enter your email to receive updates from this Telegram channel. You can change it later by reopening this form or sending <strong>/start</strong> to the bot.</p>
        <form id="signup-form">
          <label for="email">Email address</label>
          <input id="email" name="email" type="email" autocomplete="email" placeholder="name@example.com" required>
          <button type="submit">Save Email</button>
        </form>
        <p class="note">By submitting, you agree that the channel owner may store your email for contact or newsletter purposes.</p>
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

      form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const email = document.getElementById("email").value.trim();
        const initData = webApp?.initData || "";

        if (!initData) {
          showMessage("This Mini App needs to be opened from Telegram so it can verify your identity.", "error");
          return;
        }

        try {
          const response = await fetch("/api/mini-app/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email,
              init_data: initData,
              user: webApp?.initDataUnsafe?.user || null
            })
          });

          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || "Could not save your email.");
          }

          showMessage("Your email is saved. You can close this window now.", "success");
          if (webApp) {
            webApp.MainButton.setText("Saved");
            webApp.MainButton.show();
          }
        } catch (error) {
          showMessage(error.message, "error");
        }
      });

      function showMessage(text, kind) {
        message.textContent = text;
        message.className = "message show " + kind;
      }
    </script>
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
      user.source,
      user.created_at,
      user.updated_at
    ].map(toCsvCell).join(",")
  );

  return [
    "telegram_id,username,first_name,last_name,email,source,created_at,updated_at",
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
    const user = payload.user || null;

    if (!user?.id) {
      respondJson(response, 400, { error: "Missing Telegram user data." });
      return;
    }

    if (!EMAIL_REGEX.test(email)) {
      respondJson(response, 400, { error: "Please enter a valid email address." });
      return;
    }

    const telegramId = String(user.id);
    const existing = await db.getUser(telegramId);
    const now = new Date().toISOString();

    await db.upsertUser(telegramId, {
      telegram_id: telegramId,
      username: String(user.username || existing?.username || ""),
      first_name: String(user.first_name || existing?.first_name || ""),
      last_name: String(user.last_name || existing?.last_name || ""),
      email,
      source: String(existing?.source || "mini_app"),
      state: "complete",
      created_at: existing?.created_at || now,
      updated_at: now
    });

    const syncResult = await onEmailCaptured({
      email,
      firstName: String(user.first_name || existing?.first_name || ""),
      lastName: String(user.last_name || existing?.last_name || "")
    });

    if (!syncResult.ok) {
      respondJson(response, 502, { error: "Email saved locally, but mailing-list sync failed." });
      return;
    }

    respondJson(response, 200, { ok: true });
  } catch (error) {
    respondJson(response, 400, { error: "Invalid request body." });
  }
}

function isPublicRoute(method, pathname) {
  const normalizedPath = normalizePath(pathname);
  return (
    (method === "GET" && normalizedPath === "/health") ||
    (method === "GET" && normalizedPath === "/mini-app") ||
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
