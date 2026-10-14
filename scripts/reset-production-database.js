import "dotenv/config";
import bcrypt from "bcryptjs";
import { existsSync, unlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import { closeDatabase, db, initializeSchema } from "../server/db.js";

const confirmation = "DELETE_ALL_PLATFORM_DATA";
if (process.env.NODE_ENV !== "production") {
  throw new Error("This reset tool only runs when NODE_ENV=production.");
}
if (process.env.CONFIRM_PLATFORM_DATA_RESET !== confirmation) {
  throw new Error(`Set CONFIRM_PLATFORM_DATA_RESET=${confirmation} to confirm this irreversible operation.`);
}

const username = (process.env.SEED_CONSULTANT_USERNAME || "JIT_Admin").trim();
const password = process.env.SEED_CONSULTANT_PASSWORD || "";
const name = process.env.SEED_CONSULTANT_NAME?.trim() || "Jishnu Infotech Super Admin";
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username)) {
  throw new Error("SEED_CONSULTANT_USERNAME must be 3 to 32 letters, numbers, dots, underscores, or hyphens.");
}
if (password.length < 8 || password.length > 128) {
  throw new Error("SEED_CONSULTANT_PASSWORD must be between 8 and 128 characters.");
}

await initializeSchema();
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
  await db.prepare(`
    INSERT INTO users (name, username, email, contact_number, password_hash, role, is_admin, routing_priority)
    VALUES (?, ?, NULL, NULL, ?, 'agent', 1, 1)
  `).run(name, username, bcrypt.hashSync(password, 12));
  await db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('sla_first_response_hours', '4'), ('sla_resolution_hours', '48')").run();
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
console.log(`Production data reset complete. Deleted ${deletedRows} existing rows and ${removedAttachments} attachment files.`);
console.log(`Created the Super Admin account with username: ${username}`);
await closeDatabase();
