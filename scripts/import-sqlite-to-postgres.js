import Database from "better-sqlite3";
import { resolve } from "node:path";
import { closeDatabase, db, initializeDatabase, initializeSchema } from "../server/db.js";

const sourcePath = resolve(process.argv[2] || process.env.SQLITE_SOURCE || "data/ticketing.sqlite");
const tableOrder = [
  "companies",
  "users",
  "client_invitations",
  "company_join_codes",
  "tickets",
  "ticket_attachments",
  "messages",
  "agent_invitations",
  "password_reset_tokens",
  "workspace_settings",
  "notifications",
  "email_cursors",
  "mail_outbox",
  "ticket_ratings",
  "ticket_assignment_history",
];
const identifier = (value) => `"${value.replace(/"/g, '""')}"`;
let source;

try {
  source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  await initializeSchema();

  const targetUsers = Number((await db.prepare("SELECT COUNT(*) AS count FROM users").get()).count);
  if (targetUsers !== 0) {
    throw new Error("The PostgreSQL database already contains users. Import only into a new, empty database.");
  }

  const imported = {};
  await db.transaction(async () => {
    for (const table of tableOrder) {
      const exists = source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!exists) continue;
      const sourceColumns = source.prepare(`PRAGMA table_info(${identifier(table)})`).all().map((column) => column.name);
      const targetColumns = await db.prepare(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ?
      `).all(table);
      const targetColumnSet = new Set(targetColumns.map((column) => column.column_name));
      const columns = sourceColumns.filter((column) => targetColumnSet.has(column));
      if (!columns.length) continue;

      const rows = source.prepare(`SELECT ${columns.map(identifier).join(", ")} FROM ${identifier(table)}`).all();
      if (rows.length) {
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
        const insert = db.prepare(`
          INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")})
          VALUES (${placeholders})
          ${columns.includes("id") ? "RETURNING id" : ""}
        `);
        for (const row of rows) {
          await insert.run(...columns.map((column) => row[column]));
        }
      }
      imported[table] = rows.length;
    }

    for (const table of tableOrder) {
      const hasId = await db.prepare(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ? AND column_name = 'id'
      `).get(table);
      if (!hasId) continue;
      await db.prepare(`
        SELECT setval(
          pg_get_serial_sequence(?, 'id'),
          GREATEST(COALESCE(MAX(id), 1), 1),
          COUNT(*) > 0
        ) FROM ${identifier(table)}
      `).get(`public.${table}`);
    }
  })();

  await initializeDatabase();
  console.log(`Imported SQLite data from ${sourcePath}:`);
  for (const [table, count] of Object.entries(imported)) {
    console.log(`  ${table}: ${count} rows`);
  }
  console.log("The SQLite source database was opened read-only and left unchanged.");
} finally {
  source?.close();
  await closeDatabase();
}
