import "dotenv/config";
import { existsSync, unlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import { db, closeDatabase } from "../server/db.js";

const connectionUrl = new URL(process.env.DATABASE_URL || "");
const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
if (!localHosts.has(connectionUrl.hostname) || process.env.NODE_ENV === "production") {
  throw new Error("Refusing to reset a non-local or production database.");
}
if (!process.argv.includes("--confirm")) {
  throw new Error("This clears all local companies, accounts, tickets, messages, and settings. Rerun with --confirm to proceed.");
}

const tables = [
  "ticket_attachments", "ticket_assignment_history", "ticket_ratings", "messages", "notifications",
  "password_reset_tokens", "mail_outbox", "email_cursors", "tickets", "client_invitations",
  "company_join_codes", "agent_invitations", "users", "companies", "workspace_settings",
];
const attachmentRows = await db.prepare("SELECT storage_name AS storageName FROM ticket_attachments").all();
const counts = {};
for (const table of tables) {
  counts[table] = Number((await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count);
}

await db.transaction(async () => {
  await db.exec(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
  await db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('sla_first_response_hours', '4'), ('sla_resolution_hours', '48') ON CONFLICT DO NOTHING").run();
})();

const attachmentRoot = resolve(process.env.ATTACHMENTS_PATH || "data/attachments");
let removedAttachments = 0;
for (const { storageName } of attachmentRows) {
  if (typeof storageName !== "string" || !/^[\w-]+$/.test(storageName)) continue;
  const filePath = resolve(attachmentRoot, storageName);
  if (!filePath.startsWith(`${attachmentRoot}${sep}`) || !existsSync(filePath)) continue;
  unlinkSync(filePath);
  removedAttachments += 1;
}

const deletedRows = Object.values(counts).reduce((sum, count) => sum + count, 0);
console.log(`Local database reset. Cleared ${deletedRows} database rows and removed ${removedAttachments} associated attachment files.`);
console.log("Schema migrations were preserved. Configure a Super Admin bootstrap account before signing in to the empty database.");
await closeDatabase();
