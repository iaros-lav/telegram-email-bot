# Telegram Email Bot

This starter bot collects a user's email in a private Telegram chat after they tap through from your channel.

## Important Telegram limitation

Bots cannot automatically message every subscriber in a channel or see a full subscriber list. The usual pattern is:

1. You post a message in your channel.
2. The post includes a link to your bot.
3. The user opens the bot in private chat.
4. The bot asks for the email and stores it.

## What this starter includes

- Private chat `/start` flow
- Email validation
- SQLite storage in `data/bot.sqlite`
- Source tracking using the `/start` payload
- Local admin dashboard with CSV download
- Telegram Mini App email form
- Admin-only `/export` command that points you to the dashboard
- No external npm dependencies

## Setup

1. Create a bot with BotFather and copy the token.
2. Copy `.env.example` to `.env`.
3. Fill in:

```env
BOT_TOKEN=your_bot_token
BOT_USERNAME=your_bot_username
ADMIN_CHAT_ID=your_numeric_telegram_chat_id
DATABASE_URL=
DATABASE_FILE=./data/bot.sqlite
EXPORT_DIR=./exports
DASHBOARD_ENABLED=true
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=3000
DASHBOARD_TOKEN=replace-with-a-secret-token
PUBLIC_BASE_URL=https://your-public-domain.example
INIT_DATA_TTL_SECONDS=3600
TELEGRAM_WEBHOOK_SECRET=replace-with-a-long-random-secret
```

If `DATABASE_URL` is set, the app uses Postgres. If it is empty, it falls back to SQLite in `DATABASE_FILE`.

4. Start the bot:

```bash
npm start
```

5. Open the dashboard locally:

```text
http://127.0.0.1:3000/?token=replace-with-a-secret-token
```

6. If you want the Mini App button to work inside Telegram, expose the app on a public HTTPS URL and set:

```env
PUBLIC_BASE_URL=https://your-public-domain.example
```

The bot will then show an `Open Email Form` button in private chat that loads `/mini-app`.
When `PUBLIC_BASE_URL` is set, the bot also switches to Telegram webhook mode automatically, which is the correct setup for Render.

## Channel post example

Use a link like this in your channel post:

```text
https://t.me/your_bot_username?start=channel
```

That `channel` payload is stored as `source` in the database, so you can tell where signups came from.

## Commands

- `/start` starts or restarts the signup flow
- `/help` shows help
- `/export` replies with your local dashboard link if `ADMIN_CHAT_ID` matches

## Dashboard

- The dashboard runs in the same process as the bot.
- Set `DASHBOARD_ENABLED=false` if you only want the Telegram bot.
- It shows totals, collected emails, and a CSV download link.
- Access is protected by the `token` query parameter from `DASHBOARD_TOKEN`.
- Routes:

```text
/                  dashboard HTML
/api/users         stats and rows as JSON
/export.csv        CSV download
/health            simple health check
```

## Mini App

- The Mini App is served from `/mini-app`.
- It posts email submissions to `/api/mini-app/submit`.
- The bot only shows the Web App button when `PUBLIC_BASE_URL` is set.
- For real Telegram use, the URL must be publicly reachable over HTTPS.
- The plain text email flow still works as a fallback.
- Server-side validation now uses `Telegram.WebApp.initData`, not `initDataUnsafe`.
- `INIT_DATA_TTL_SECONDS` controls how long Telegram auth data stays valid.

## Telegram Delivery Mode

- Local development without `PUBLIC_BASE_URL` uses long polling.
- Deployment with `PUBLIC_BASE_URL` uses webhook mode automatically.
- Render should use webhook mode to avoid `Telegram HTTP 409` conflicts during overlapping deploys.
- `TELEGRAM_WEBHOOK_SECRET` protects the webhook path with an unguessable URL segment.

## Deploying

This project includes a [`Dockerfile`](/Users/yarik/Code/telegram-email-bot/Dockerfile) so you can deploy it on any platform that supports Docker.
It also includes a Render Blueprint at [`render.yaml`](/Users/yarik/Code/telegram-email-bot/render.yaml) and Railway config-as-code at [`railway.json`](/Users/yarik/Code/telegram-email-bot/railway.json).

### Required deployment settings

- Set `PUBLIC_BASE_URL` to your live HTTPS URL.
- Set `TELEGRAM_WEBHOOK_SECRET` to a long random string.
- Set `DASHBOARD_HOST=0.0.0.0` in cloud environments.
- Most platforms provide `PORT`; the app uses it automatically when present.
- Prefer `DATABASE_URL` on cloud platforms so your data survives restarts automatically.
- If you stay on SQLite, use a persistent volume.

### Render

- This repo includes [`render.yaml`](/Users/yarik/Code/telegram-email-bot/render.yaml), which defines:
- a Docker web service
- a Render Postgres database
- a `DATABASE_URL` link from the app to the database
- Create a new Blueprint in Render and point it at this repo.
- On first deploy, Render will prompt you for secret values marked with `sync: false`, including `BOT_TOKEN`, `BOT_USERNAME`, `ADMIN_CHAT_ID`, `DASHBOARD_TOKEN`, and `PUBLIC_BASE_URL`.
- The Blueprint defaults to the `starter` web plan and `free` Postgres plan in `oregon`. Adjust those if you want different pricing or region.

### Railway

- This repo includes [`railway.json`](/Users/yarik/Code/telegram-email-bot/railway.json), which tells Railway to use the root `Dockerfile` and health-check `/health`.
- Create a Railway project from this repo.
- Add a PostgreSQL service in Railway, then copy its connection string into the app service as `DATABASE_URL`.
- Set these variables on the app service: `BOT_TOKEN`, `BOT_USERNAME`, `ADMIN_CHAT_ID`, `DASHBOARD_HOST=0.0.0.0`, `DASHBOARD_ENABLED=true`, `DASHBOARD_TOKEN`, `PUBLIC_BASE_URL`, and optionally `INIT_DATA_TTL_SECONDS=3600`.
- Railway will honor the Dockerfile automatically, and `PORT` will be injected by the platform.

### Railway CLI

- You can deploy the app service with `railway up`.
- If you want Railway to provision Postgres from the CLI, use `railway deploy -t postgres` in the project, then set the resulting connection string as `DATABASE_URL` on the app service.

### Fly.io

- Fly detects the `Dockerfile`.
- Run `fly launch` in this project directory, then set your secrets and deploy.
- Best option: connect a managed Postgres instance and set `DATABASE_URL`.
- Use a Fly volume only if you intentionally want SQLite.

## Notes

- This starter now uses Node's built-in SQLite module, which is still marked experimental in Node 22.
- Postgres support uses the `pg` package, so run `npm install` before starting the app after pulling these changes.
- Data stays local on your machine unless you deploy it elsewhere.
- Add a proper privacy notice if you plan to collect emails from the public.
- Mini App submissions now validate Telegram `initData` server-side before trusting the user identity.
- Railway config-as-code currently covers deployment settings for one service; the Postgres service itself is still created in Railway, not from `railway.json`.
