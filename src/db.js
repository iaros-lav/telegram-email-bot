import { existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export async function createStore({ databaseFile, databaseUrl }) {
  if (databaseUrl) {
    return createPostgresStore(databaseUrl);
  }

  return createSqliteStore(databaseFile);
}

function createSqliteStore(filePath) {
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const database = new DatabaseSync(resolvedPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'direct',
      state TEXT NOT NULL DEFAULT 'awaiting_email',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const getUserStatement = database.prepare(`
    SELECT
      telegram_id,
      username,
      first_name,
      last_name,
      email,
      source,
      state,
      created_at,
      updated_at
    FROM users
    WHERE telegram_id = ?
  `);

  const upsertStatement = database.prepare(`
    INSERT INTO users (
      telegram_id,
      username,
      first_name,
      last_name,
      email,
      source,
      state,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      email = excluded.email,
      source = excluded.source,
      state = excluded.state,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `);

  const listUsersStatement = database.prepare(`
    SELECT
      telegram_id,
      username,
      first_name,
      last_name,
      email,
      source,
      state,
      created_at,
      updated_at
    FROM users
    ORDER BY updated_at DESC
  `);

  const statsStatement = database.prepare(`
    SELECT
      COUNT(*) AS total_users,
      SUM(CASE WHEN email != '' THEN 1 ELSE 0 END) AS email_count,
      SUM(CASE WHEN source = 'channel' THEN 1 ELSE 0 END) AS channel_count
    FROM users
  `);

  return {
    kind: "sqlite",
    async getUser(userId) {
      return getUserStatement.get(String(userId)) || null;
    },
    async upsertUser(userId, user) {
      upsertStatement.run(
        String(userId),
        user.username || "",
        user.first_name || "",
        user.last_name || "",
        user.email || "",
        user.source || "direct",
        user.state || "awaiting_email",
        user.created_at,
        user.updated_at
      );
      return this.getUser(userId);
    },
    async listUsers() {
      return listUsersStatement.all();
    },
    async getStats() {
      const row = statsStatement.get();
      return {
        total_users: Number(row.total_users || 0),
        email_count: Number(row.email_count || 0),
        channel_count: Number(row.channel_count || 0)
      };
    }
  };
}

async function createPostgresStore(databaseUrl) {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: databaseUrl,
    ssl: shouldUseSsl(databaseUrl) ? { rejectUnauthorized: false } : undefined
  });

  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'direct',
      state TEXT NOT NULL DEFAULT 'awaiting_email',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);

  return {
    kind: "postgres",
    async getUser(userId) {
      const result = await client.query(
        `
          SELECT
            telegram_id,
            username,
            first_name,
            last_name,
            email,
            source,
            state,
            created_at,
            updated_at
          FROM users
          WHERE telegram_id = $1
        `,
        [String(userId)]
      );
      return normalizePostgresUser(result.rows[0] || null);
    },
    async upsertUser(userId, user) {
      const result = await client.query(
        `
          INSERT INTO users (
            telegram_id,
            username,
            first_name,
            last_name,
            email,
            source,
            state,
            created_at,
            updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)
          ON CONFLICT (telegram_id) DO UPDATE SET
            username = EXCLUDED.username,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            email = EXCLUDED.email,
            source = EXCLUDED.source,
            state = EXCLUDED.state,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at
          RETURNING
            telegram_id,
            username,
            first_name,
            last_name,
            email,
            source,
            state,
            created_at,
            updated_at
        `,
        [
          String(userId),
          user.username || "",
          user.first_name || "",
          user.last_name || "",
          user.email || "",
          user.source || "direct",
          user.state || "awaiting_email",
          user.created_at,
          user.updated_at
        ]
      );
      return normalizePostgresUser(result.rows[0]);
    },
    async listUsers() {
      const result = await client.query(`
        SELECT
          telegram_id,
          username,
          first_name,
          last_name,
          email,
          source,
          state,
          created_at,
          updated_at
        FROM users
        ORDER BY updated_at DESC
      `);
      return result.rows.map(normalizePostgresUser);
    },
    async getStats() {
      const result = await client.query(`
        SELECT
          COUNT(*)::int AS total_users,
          COALESCE(SUM(CASE WHEN email != '' THEN 1 ELSE 0 END), 0)::int AS email_count,
          COALESCE(SUM(CASE WHEN source = 'channel' THEN 1 ELSE 0 END), 0)::int AS channel_count
        FROM users
      `);
      const row = result.rows[0] || {};
      return {
        total_users: Number(row.total_users || 0),
        email_count: Number(row.email_count || 0),
        channel_count: Number(row.channel_count || 0)
      };
    }
  };
}

function normalizePostgresUser(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

function shouldUseSsl(databaseUrl) {
  const url = new URL(databaseUrl);
  return url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
}
