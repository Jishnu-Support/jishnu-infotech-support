import "dotenv/config";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const databasePath = resolve(process.env.DATABASE_PATH || "data/ticketing.sqlite");
const isProduction = process.env.NODE_ENV === "production";
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    slug TEXT NOT NULL UNIQUE,
    domain TEXT UNIQUE COLLATE NOCASE,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('agent', 'customer')),
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_company_admin INTEGER NOT NULL DEFAULT 0,
    approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('approved', 'pending', 'rejected')),
    company_id INTEGER REFERENCES companies(id),
    disabled_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS client_invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    is_company_admin INTEGER NOT NULL DEFAULT 0,
    token_hash TEXT NOT NULL UNIQUE,
    invited_by INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS company_join_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL UNIQUE,
    created_by INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ticket_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    storage_name TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting', 'resolved')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    customer_id INTEGER NOT NULL REFERENCES users(id),
    company_id INTEGER REFERENCES companies(id),
    assignee_id INTEGER REFERENCES users(id),
    source TEXT NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'email')),
    first_response_at TEXT,
    resolved_at TEXT,
    category TEXT NOT NULL DEFAULT 'Other',
    tags_json TEXT NOT NULL DEFAULT '[]',
    custom_fields_json TEXT NOT NULL DEFAULT '{}',
    email_thread_id TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    is_internal INTEGER NOT NULL DEFAULT 0,
    email_message_id TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS agent_invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE,
    token_hash TEXT NOT NULL UNIQUE,
    invited_by INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workspace_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, ticket_id, kind)
  );

  CREATE TABLE IF NOT EXISTS email_cursors (
    mailbox TEXT PRIMARY KEY,
    uid_validity TEXT,
    last_uid INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mail_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    references_header TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ticket_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES users(id),
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const addColumnIfMissing = (table, column, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

addColumnIfMissing("users", "is_admin", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "is_company_admin", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "approval_status", "TEXT NOT NULL DEFAULT 'approved'");
addColumnIfMissing("users", "company_id", "INTEGER REFERENCES companies(id)");
addColumnIfMissing("users", "disabled_at", "TEXT");
addColumnIfMissing("tickets", "company_id", "INTEGER REFERENCES companies(id)");
addColumnIfMissing("tickets", "first_response_at", "TEXT");
addColumnIfMissing("tickets", "resolved_at", "TEXT");
addColumnIfMissing("tickets", "category", "TEXT NOT NULL DEFAULT 'Other'");
addColumnIfMissing("tickets", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing("tickets", "custom_fields_json", "TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing("tickets", "email_thread_id", "TEXT");
addColumnIfMissing("messages", "email_message_id", "TEXT");
addColumnIfMissing("messages", "is_internal", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("mail_outbox", "references_header", "TEXT");

db.prepare(`
  UPDATE tickets SET resolved_at = updated_at
  WHERE status = 'resolved' AND resolved_at IS NULL
`).run();
db.prepare(`
  UPDATE tickets
  SET first_response_at = (
    SELECT MIN(m.created_at)
    FROM messages m JOIN users u ON u.id = m.author_id
    WHERE m.ticket_id = tickets.id AND u.role = 'agent' AND m.created_at >= tickets.created_at
  )
  WHERE first_response_at IS NULL AND EXISTS (
    SELECT 1 FROM messages m JOIN users u ON u.id = m.author_id
    WHERE m.ticket_id = tickets.id AND u.role = 'agent' AND m.created_at >= tickets.created_at
  )
`).run();

const databaseWasEmpty = db.prepare("SELECT COUNT(*) AS count FROM users").get().count === 0;
const legacyCompanyName = isProduction && databaseWasEmpty
  ? process.env.SEED_CUSTOMER_COMPANY?.trim() || "Initial Client Company"
  : "Existing Customers";
const legacyCompany = db.prepare(`
  INSERT INTO companies (name, slug)
  VALUES (?, 'existing-customers')
  ON CONFLICT(slug) DO UPDATE SET name = excluded.name
  WHERE (SELECT COUNT(*) FROM users) = 0
`).run(legacyCompanyName);
const legacyCompanyId = Number(legacyCompany.lastInsertRowid)
  || db.prepare("SELECT id FROM companies WHERE slug = 'existing-customers'").get().id;
db.prepare("UPDATE users SET company_id = ? WHERE role = 'customer' AND company_id IS NULL").run(legacyCompanyId);
db.prepare(`
  UPDATE tickets SET company_id = (
    SELECT company_id FROM users WHERE users.id = tickets.customer_id
  ) WHERE company_id IS NULL
`).run();

if (db.prepare("SELECT COUNT(*) AS count FROM users WHERE company_id = ? AND is_company_admin = 1").get(legacyCompanyId).count === 0) {
  const firstClient = db.prepare("SELECT id FROM users WHERE role = 'customer' AND company_id = ? ORDER BY id LIMIT 1").get(legacyCompanyId);
  if (firstClient) db.prepare("UPDATE users SET is_company_admin = 1 WHERE id = ?").run(firstClient.id);
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS tickets_email_thread_id_idx ON tickets(email_thread_id) WHERE email_thread_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS messages_email_message_id_idx ON messages(email_message_id) WHERE email_message_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS users_company_id_idx ON users(company_id);
  CREATE INDEX IF NOT EXISTS tickets_company_id_idx ON tickets(company_id);
  CREATE INDEX IF NOT EXISTS tickets_created_at_idx ON tickets(created_at);
  CREATE INDEX IF NOT EXISTS tickets_resolved_at_idx ON tickets(resolved_at);
  CREATE INDEX IF NOT EXISTS ticket_attachments_ticket_id_idx ON ticket_attachments(ticket_id);
`);

if (db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1").get().count === 0) {
  const firstAgent = db.prepare("SELECT id FROM users WHERE role = 'agent' ORDER BY id LIMIT 1").get();
  if (firstAgent) db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(firstAgent.id);
}

const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
if (userCount === 0) {
  const agentEmail = process.env.SEED_AGENT_EMAIL || (isProduction ? null : "alex@relaysupport.test");
  const agentPassword = process.env.SEED_AGENT_PASSWORD || (isProduction ? null : "Support123!");
  const customerEmail = process.env.SEED_CUSTOMER_EMAIL || (isProduction ? null : "sam@northstar.test");
  const customerPassword = process.env.SEED_CUSTOMER_PASSWORD || (isProduction ? null : "Customer123!");
  const agentName = process.env.SEED_AGENT_NAME?.trim() || (isProduction ? "Jishnu Infotech Admin" : "Alex Morgan");
  const customerName = process.env.SEED_CUSTOMER_NAME?.trim() || (isProduction ? "Company Administrator" : "Sam Rivera");

  if (!agentEmail || !agentPassword || !customerEmail || !customerPassword) {
    throw new Error("Set SEED_AGENT_EMAIL, SEED_AGENT_PASSWORD, SEED_CUSTOMER_EMAIL, and SEED_CUSTOMER_PASSWORD before first production startup.");
  }
  if (isProduction && (agentPassword.length < 12 || customerPassword.length < 12)) {
    throw new Error("Production seed passwords must each be at least 12 characters.");
  }

  const insertUser = db.prepare("INSERT INTO users (name, email, password_hash, role, company_id, is_company_admin) VALUES (?, ?, ?, ?, ?, ?)");
  const insertTicket = db.prepare("INSERT INTO tickets (subject, description, status, priority, customer_id, company_id, assignee_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))");
  const insertMessage = db.prepare("INSERT INTO messages (ticket_id, author_id, body, created_at) VALUES (?, ?, ?, datetime('now', ?))");

  db.transaction(() => {
    const agentId = Number(insertUser.run(agentName, agentEmail, bcrypt.hashSync(agentPassword, 12), "agent", null, 0).lastInsertRowid);
    db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(agentId);
    const customerId = Number(insertUser.run(customerName, customerEmail, bcrypt.hashSync(customerPassword, 12), "customer", legacyCompanyId, 1).lastInsertRowid);
    const examples = isProduction ? [] : [
      {
        subject: "Unable to access my account",
        description: "I reset my password but still cannot sign in. Could you help me check what is going on?",
        status: "open",
        priority: "high",
        source: "portal",
        age: "-22 minutes",
        reply: "Thanks for letting us know. We are checking this for you now.",
        replyAge: "-18 minutes",
      },
      {
        subject: "Question about my latest invoice",
        description: "Could you help me understand the additional charge on this month's invoice?",
        status: "in_progress",
        priority: "normal",
        source: "email",
        age: "-3 hours",
        reply: "I am reviewing the invoice details and will follow up shortly.",
        replyAge: "-2 hours",
      },
      {
        subject: "Feature request: export reports",
        description: "It would be useful to export the monthly report as a CSV file.",
        status: "waiting",
        priority: "low",
        source: "portal",
        age: "-1 day",
        reply: "Thanks for the suggestion. Is there a particular report you need first?",
        replyAge: "-20 hours",
      },
      {
        subject: "Order confirmation not received",
        description: "I placed an order yesterday but have not received a confirmation email.",
        status: "resolved",
        priority: "normal",
        source: "email",
        age: "-2 days",
        reply: "We found your order and resent the confirmation. Please check your inbox.",
        replyAge: "-1 day",
      },
    ];

    examples.forEach((item) => {
      const ticketId = Number(insertTicket.run(
        item.subject, item.description, item.status, item.priority, customerId, legacyCompanyId, agentId, item.source, item.age, item.age,
      ).lastInsertRowid);
      insertMessage.run(ticketId, customerId, item.description, item.age);
      insertMessage.run(ticketId, agentId, item.reply, item.replyAge);
    });
  })();
}

db.prepare(`
  UPDATE tickets SET company_id = (
    SELECT company_id FROM users WHERE users.id = tickets.customer_id
  ) WHERE company_id IS NULL
`).run();

db.prepare("INSERT OR IGNORE INTO workspace_settings (key, value) VALUES ('sla_first_response_hours', '4'), ('sla_resolution_hours', '48')").run();
