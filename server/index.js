import "dotenv/config";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import { basename, extname, resolve } from "node:path";
import { mkdirSync, unlinkSync } from "node:fs";
import { fileTypeFromFile } from "file-type";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db, initializeDatabase } from "./db.js";
import { applicationUrl, emailIsConfigured, sendEmail } from "./email.js";

const app = express();
const port = Number(process.env.PORT || 3001);
const isProduction = process.env.NODE_ENV === "production";
app.set("trust proxy", isProduction ? 1 : false);
const jwtSecret = process.env.JWT_SECRET;

if (isProduction && !jwtSecret) {
  throw new Error("JWT_SECRET must be set in production.");
}
const tokenSecret = jwtSecret || "development-only-secret-change-before-deploy";
const attachmentsRoot = resolve(process.env.ATTACHMENTS_PATH || "data/attachments");
mkdirSync(attachmentsRoot, { recursive: true });
const permittedAttachmentTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["application/pdf", ".pdf"],
]);
const ticketCategories = ["Account access", "Billing", "Technical support", "Feature request", "Other"];
const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: attachmentsRoot,
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  }),
  limits: { files: 5, fields: 8, parts: 13, fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(
    permittedAttachmentTypes.has(file.mimetype) ? null : new Error("Only PDF, JPEG, PNG, and WebP attachments are allowed."),
    permittedAttachmentTypes.has(file.mimetype),
  ),
});

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isAdmin: Boolean(user.is_admin),
    isCompanyAdmin: Boolean(user.is_company_admin),
    companyId: user.company_id || null,
    companyName: user.company_name || null,
    approvalStatus: user.approval_status || "approved",
  };
}

function createToken(user) {
  return jwt.sign({ sub: user.id }, tokenSecret, { expiresIn: "8h" });
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function secureToken() {
  return randomBytes(32).toString("base64url");
}

async function requireAuth(req, res, next) {
  const token = req.cookies.relay_session;
  if (!token) return res.status(401).json({ error: "Sign in to continue." });
  let payload;
  try {
    payload = jwt.verify(token, tokenSecret);
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
  const user = await db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.is_admin, u.is_company_admin, u.company_id,
           u.approval_status, c.name AS company_name
    FROM users u LEFT JOIN companies c ON c.id = u.company_id
    WHERE u.id = ? AND u.disabled_at IS NULL
  `).get(Number(payload.sub));
  if (!user) return res.status(401).json({ error: "Your session is no longer valid." });
  if (user.role === "customer" && user.approval_status !== "approved") {
    return res.status(403).json({ error: "Your company account is awaiting administrator approval." });
  }
  req.user = user;
  next();
}

function requireAgent(req, res, next) {
  if (req.user.role === "customer") return res.status(403).json({ error: "Only support agents can do that." });
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "agent" || !req.user.is_admin) return res.status(403).json({ error: "Only workspace administrators can do that." });
  next();
}

function requireCompanyAdmin(req, res, next) {
  if (req.user.role === "agent" && req.user.is_admin) return next();
  if (req.user.role !== "customer" || !req.user.is_company_admin || !req.user.company_id) {
    return res.status(403).json({ error: "Only administrators for your client company can do that." });
  }
  next();
}

function companyIdForUser(user) {
  return user.role === "customer" ? user.company_id : null;
}

async function slaConfiguration() {
  const settings = await db.prepare("SELECT key, value FROM workspace_settings WHERE key IN ('sla_first_response_hours', 'sla_resolution_hours')").all();
  const values = Object.fromEntries(settings.map((row) => [row.key, Number(row.value)]));
  return {
    firstResponseHours: values.sla_first_response_hours || 4,
    resolutionHours: values.sla_resolution_hours || 48,
  };
}

function deadlineFrom(createdAt, hours) {
  return Date.parse(`${createdAt.replace(" ", "T")}Z`) + hours * 60 * 60 * 1000;
}

async function selectRoutingAgent() {
  return await db.prepare(`
    SELECT u.id
    FROM users u
    LEFT JOIN tickets t ON t.assignee_id = u.id AND t.status != 'resolved'
    WHERE u.role = 'agent' AND u.disabled_at IS NULL
    GROUP BY u.id
    ORDER BY u.routing_priority, COUNT(t.id), u.id
    LIMIT 1
  `).get();
}

async function recordTicketAssignment(ticketId, agentId, assignedBy, source) {
  await db.prepare(`
    INSERT INTO ticket_assignment_history (ticket_id, agent_id, assigned_by, source)
    VALUES (?, ?, ?, ?)
  `).run(ticketId, agentId, assignedBy || null, source);
}

async function normalizeActiveAgentPriorities() {
  const activeAgents = await db.prepare(`
    SELECT id FROM users WHERE role = 'agent' AND disabled_at IS NULL
    ORDER BY routing_priority, id
  `).all();
  const updatePriority = db.prepare("UPDATE users SET routing_priority = ? WHERE id = ?");
  for (const [index, agent] of activeAgents.entries()) {
    await updatePriority.run(index + 1, agent.id);
  }
}

async function canAccessTicket(user, ticketId) {
  if (user.role === "agent") return true;
  if (user.is_company_admin) {
    return Boolean(await db.prepare("SELECT 1 FROM tickets WHERE id = ? AND company_id = ?").get(ticketId, user.company_id));
  }
  return Boolean(await db.prepare("SELECT 1 FROM tickets WHERE id = ? AND customer_id = ? AND company_id = ?").get(ticketId, user.id, user.company_id));
}

async function ticketSummary(row) {
  const sla = await slaConfiguration();
  const firstResponseDueAt = new Date(deadlineFrom(row.created_at, sla.firstResponseHours)).toISOString();
  const resolutionDueAt = new Date(deadlineFrom(row.created_at, sla.resolutionHours)).toISOString();
  return {
    id: row.id,
    subject: row.subject,
    description: row.description,
    status: row.status,
    priority: row.priority,
    source: row.source,
    category: row.category || "Other",
    tags: parseJsonArray(row.tags_json),
    customFields: parseJsonObject(row.custom_fields_json),
    rating: row.rating ? {
      rating: row.rating,
      comment: row.rating_comment,
      createdAt: row.rating_created_at,
      customerId: row.rating_customer_id,
    } : null,
    company: row.company_name ? { id: row.company_id, name: row.company_name } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    customer: { id: row.customer_id, name: row.customer_name, email: row.customer_email },
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name } : null,
    messageCount: row.message_count,
    lastMessage: row.last_message || row.description,
    firstResponseDueAt,
    resolutionDueAt,
    firstResponseAt: row.first_response_at,
    isFirstResponseOverdue: !row.first_response_at && row.status !== "resolved" && Date.now() > Date.parse(firstResponseDueAt),
    isResolutionOverdue: row.status !== "resolved" && Date.now() > Date.parse(resolutionDueAt),
    attachmentCount: row.attachment_count || 0,
  };
}

const ticketSelect = `
  SELECT t.*, c.name AS customer_name, c.email AS customer_email,
         co.name AS company_name,
         a.id AS assignee_id, a.name AS assignee_name,
         (SELECT COUNT(*) FROM messages m WHERE m.ticket_id = t.id AND m.is_internal = 0) AS message_count,
         (SELECT COUNT(*) FROM ticket_attachments x WHERE x.ticket_id = t.id) AS attachment_count,
         (SELECT body FROM messages m WHERE m.ticket_id = t.id AND m.is_internal = 0 ORDER BY m.id DESC LIMIT 1) AS last_message,
         r.rating, r.comment AS rating_comment, r.created_at AS rating_created_at,
         r.customer_id AS rating_customer_id
  FROM tickets t
  JOIN users c ON c.id = t.customer_id
  LEFT JOIN companies co ON co.id = t.company_id
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN ticket_ratings r ON r.ticket_id = t.id
`;

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedTicketMetadata(body, defaults = {}) {
  const category = body.category === undefined ? defaults.category || "Other" : body.category;
  if (typeof category !== "string" || !ticketCategories.includes(category)) {
    return { error: "Choose a valid ticket category." };
  }
  let tags = body.tags === undefined ? defaults.tags || [] : body.tags;
  if (typeof tags === "string") tags = tags.split(",");
  if (!Array.isArray(tags) || tags.length > 10 || tags.some((tag) => typeof tag !== "string" || tag.trim().length > 32)) {
    return { error: "Add up to 10 tags, each 32 characters or fewer." };
  }
  tags = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];

  let customFields = body.customFields === undefined ? defaults.customFields || {} : body.customFields;
  if (typeof customFields === "string") {
    try { customFields = JSON.parse(customFields || "{}"); } catch {
      return { error: "Custom fields must be valid JSON data." };
    }
  }
  if (!customFields || typeof customFields !== "object" || Array.isArray(customFields) || Object.keys(customFields).length > 10) {
    return { error: "Add up to 10 custom fields." };
  }
  const normalizedFields = {};
  for (const [key, value] of Object.entries(customFields)) {
    const label = key.trim();
    if (!label || label.length > 40 || typeof value !== "string" || value.trim().length > 500) {
      return { error: "Custom field names must be 1–40 characters and values 500 characters or fewer." };
    }
    if (value.trim()) normalizedFields[label] = value.trim();
  }
  return { category, tags, customFields: normalizedFields };
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!email || !password) return res.status(400).json({ error: "Enter your email and password." });

  const user = await db.prepare(`
    SELECT u.*, c.name AS company_name
    FROM users u LEFT JOIN companies c ON c.id = u.company_id
    WHERE u.email = ? COLLATE NOCASE AND u.disabled_at IS NULL
  `).get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  if (user.role === "customer" && user.approval_status !== "approved") {
    return res.status(403).json({ error: "Your company account is awaiting administrator approval." });
  }

  res.cookie("relay_session", createToken(user), {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.json({ user: publicUser(user) });
});

app.get("/api/companies/available", async (_req, res) => {
  const companies = await db.prepare("SELECT id, name FROM companies WHERE is_active = 1 ORDER BY name").all();
  res.json({ companies });
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const joinCode = typeof req.body.joinCode === "string" ? req.body.joinCode.trim() : "";
  const requestedCompanyId = Number(req.body.companyId);
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Name must be between 2 and 100 characters." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 12 || password.length > 128) return res.status(400).json({ error: "Password must be between 12 and 128 characters." });

  let company;
  let approvalStatus = "pending";
  if (joinCode) {
    const codeHash = hashToken(joinCode.toUpperCase());
    company = await db.prepare(`
      SELECT c.id, c.name FROM company_join_codes j
      JOIN companies c ON c.id = j.company_id
      WHERE j.code_hash = ? AND j.revoked_at IS NULL AND c.is_active = 1
        AND (j.expires_at IS NULL OR datetime(j.expires_at) > CURRENT_TIMESTAMP)
    `).get(codeHash);
    if (!company) return res.status(400).json({ error: "That company invitation code is invalid, expired, or revoked." });
    approvalStatus = "approved";
  } else if (Number.isInteger(requestedCompanyId) && requestedCompanyId > 0) {
    company = await db.prepare("SELECT id, name FROM companies WHERE id = ? AND is_active = 1").get(requestedCompanyId);
    if (!company) return res.status(400).json({ error: "Choose an available client company." });
  } else {
    return res.status(400).json({ error: "Choose a company or enter a company invitation code." });
  }

  try {
    const id = Number((await db.prepare(`
      INSERT INTO users (name, email, password_hash, role, company_id, approval_status)
      VALUES (?, ?, ?, 'customer', ?, ?)
    `).run(name, email, bcrypt.hashSync(password, 12), company.id, approvalStatus)).lastInsertRowid);
    if (approvalStatus === "pending") {
      await db.prepare(`
        INSERT INTO notifications (user_id, ticket_id, kind, message)
        SELECT id, NULL, ?, ? FROM users
        WHERE role = 'customer' AND is_company_admin = 1 AND company_id = ? AND approval_status = 'approved'
      `).run(`company_join_request:${id}`, `${name} (${email}) requested access to ${company.name}.`, company.id);
      return res.status(202).json({
        pendingApproval: true,
        message: `Your account for ${company.name} is waiting for a company administrator to approve it.`,
      });
    }
    const user = await db.prepare(`
      SELECT u.id, u.name, u.email, u.role, u.is_admin, u.is_company_admin, u.company_id,
             u.approval_status, c.name AS company_name
      FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?
    `).get(id);
    res.cookie("relay_session", createToken(user), {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    });
    return res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "An account with this email already exists." });
    throw error;
  }
});

app.post("/api/auth/password-reset", authLimiter, async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (isProduction && !emailIsConfigured()) {
    return res.status(503).json({ error: "Password recovery email is not configured. Ask your Jishnu Infotech administrator for help." });
  }

  const user = await db.prepare("SELECT id, name, email FROM users WHERE email = ? COLLATE NOCASE AND role = 'customer' AND disabled_at IS NULL").get(email);
  if (!user) return res.json({ message: "If a client account exists for that address, password-reset instructions have been sent." });

  const token = secureToken();
  await db.prepare("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL").run(user.id);
  await db.prepare("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)").run(
    user.id, hashToken(token), new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  );
  const resetUrl = applicationUrl(`/reset-password?token=${encodeURIComponent(token)}`);
  if (emailIsConfigured()) {
    try {
      await sendEmail({
        to: user.email,
        subject: "Reset your Jishnu Infotech support password",
        text: `Hello ${user.name},\n\nUse this one-time link within 30 minutes to reset your password:\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
      });
    } catch (error) {
      await db.prepare("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(hashToken(token));
      console.error("Password-reset email delivery failed:", error.message);
      return res.status(503).json({ error: "Could not send the password-reset email. Please try again later." });
    }
  } else if (!isProduction) {
    return res.json({ message: "A development-only reset link is ready.", resetUrl });
  }
  res.json({ message: "If a client account exists for that address, password-reset instructions have been sent." });
});

app.post("/api/auth/password-reset/complete", authLimiter, async (req, res) => {
  const token = typeof req.body.token === "string" ? req.body.token : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: "Password must be between 12 and 128 characters." });
  }
  const tokenHash = hashToken(token);
  const reset = await db.prepare(`
    SELECT r.id, r.user_id FROM password_reset_tokens r
    JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.used_at IS NULL AND datetime(r.expires_at) > CURRENT_TIMESTAMP
      AND u.role = 'customer' AND u.disabled_at IS NULL
  `).get(tokenHash);
  if (!reset) return res.status(400).json({ error: "This password-reset link is invalid or expired. Request a new one." });
  await db.transaction(async () => {
    await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 12), reset.user_id);
    await db.prepare("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL").run(reset.user_id);
  })();
  res.json({ message: "Your password has been reset. You can now sign in." });
});

app.get("/api/auth/agent-invitations/validate", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const invitation = await db.prepare(`
    SELECT email FROM agent_invitations
    WHERE token_hash = ? AND accepted_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP
  `).get(hashToken(token));
  if (!invitation) return res.status(400).json({ error: "This invitation link is invalid or expired. Ask an administrator for a new invitation." });
  res.json({ email: invitation.email });
});

app.post("/api/auth/agent-invitations/accept", async (req, res) => {
  const token = typeof req.body.token === "string" ? req.body.token : "";
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Name must be between 2 and 100 characters." });
  if (password.length < 12 || password.length > 128) return res.status(400).json({ error: "Password must be between 12 and 128 characters." });
  const tokenHash = hashToken(token);
  const invitation = await db.prepare(`
    SELECT id, email FROM agent_invitations
    WHERE token_hash = ? AND accepted_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP
  `).get(tokenHash);
  if (!invitation) return res.status(400).json({ error: "This invitation link is invalid or expired. Ask an administrator for a new invitation." });

  let userId;
  try {
    const accept = db.transaction(async () => {
      const nextPriority = (await db.prepare("SELECT COALESCE(MAX(routing_priority), 0) + 1 AS priority FROM users WHERE role = 'agent' AND disabled_at IS NULL").get()).priority;
      const user = await db.prepare("INSERT INTO users (name, email, password_hash, role, routing_priority) VALUES (?, ?, ?, 'agent', ?)")
        .run(name, invitation.email, bcrypt.hashSync(password, 12), nextPriority);
      const accepted = await db.prepare("UPDATE agent_invitations SET accepted_at = CURRENT_TIMESTAMP WHERE id = ? AND accepted_at IS NULL")
        .run(invitation.id);
      if (accepted.changes !== 1) throw new Error("Invitation has already been accepted.");
      return Number(user.lastInsertRowid);
    });
    userId = await accept();
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "An account with this email already exists." });
    if (error.message === "Invitation has already been accepted.") return res.status(400).json({ error: "This invitation link has already been used." });
    throw error;
  }
  const user = await db.prepare("SELECT id, name, email, role, is_admin FROM users WHERE id = ?").get(userId);
  res.cookie("relay_session", createToken(user), {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.status(201).json({ user: publicUser(user) });
});

app.get("/api/auth/client-invitations/validate", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const invitation = await db.prepare(`
    SELECT i.email, i.is_company_admin AS isCompanyAdmin, c.name AS companyName
    FROM client_invitations i JOIN companies c ON c.id = i.company_id
    WHERE i.token_hash = ? AND i.accepted_at IS NULL AND datetime(i.expires_at) > CURRENT_TIMESTAMP
      AND c.is_active = 1
  `).get(hashToken(token));
  if (!invitation) return res.status(400).json({ error: "This company invitation is invalid or expired. Ask a company administrator for a new one." });
  res.json({ invitation });
});

app.post("/api/auth/client-invitations/accept", authLimiter, async (req, res) => {
  const token = typeof req.body.token === "string" ? req.body.token : "";
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Name must be between 2 and 100 characters." });
  if (password.length < 12 || password.length > 128) return res.status(400).json({ error: "Password must be between 12 and 128 characters." });
  const tokenHash = hashToken(token);
  const invitation = await db.prepare(`
    SELECT i.id, i.email, i.company_id, i.is_company_admin
    FROM client_invitations i JOIN companies c ON c.id = i.company_id
    WHERE i.token_hash = ? AND i.accepted_at IS NULL AND datetime(i.expires_at) > CURRENT_TIMESTAMP
      AND c.is_active = 1
  `).get(tokenHash);
  if (!invitation) return res.status(400).json({ error: "This company invitation is invalid or expired. Ask a company administrator for a new one." });
  try {
    const accept = db.transaction(async () => {
      const user = await db.prepare(`
        INSERT INTO users (name, email, password_hash, role, company_id, is_company_admin)
        VALUES (?, ?, ?, 'customer', ?, ?)
      `).run(name, invitation.email, bcrypt.hashSync(password, 12), invitation.company_id, invitation.is_company_admin);
      const updated = await db.prepare("UPDATE client_invitations SET accepted_at = CURRENT_TIMESTAMP WHERE id = ? AND accepted_at IS NULL")
        .run(invitation.id);
      if (updated.changes !== 1) throw new Error("Company invitation has already been accepted.");
      return Number(user.lastInsertRowid);
    });
    const userId = await accept();
    const user = await db.prepare(`
      SELECT u.id, u.name, u.email, u.role, u.is_admin, u.is_company_admin, u.company_id,
             u.approval_status, c.name AS company_name
      FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?
    `).get(userId);
    res.cookie("relay_session", createToken(user), {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    });
    return res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "An account with this email already exists." });
    if (error.message === "Company invitation has already been accepted.") return res.status(400).json({ error: "This company invitation has already been used." });
    throw error;
  }
});

app.post("/api/agent-invitations", requireAuth, requireAdmin, async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Enter a valid agent email address." });
  }
  if (await db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }
  if (await db.prepare("SELECT 1 FROM agent_invitations WHERE email = ? COLLATE NOCASE AND accepted_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP").get(email)) {
    return res.status(409).json({ error: "A valid invitation has already been sent to this email address." });
  }
  if (isProduction && !emailIsConfigured()) {
    return res.status(503).json({ error: "Agent invitations require configured outbound SMTP email." });
  }

  const token = secureToken();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const result = await db.prepare(`
    INSERT INTO agent_invitations (email, token_hash, invited_by, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(email, hashToken(token), req.user.id, expiresAt);
  const invitationUrl = applicationUrl(`/invite?token=${encodeURIComponent(token)}`);
  if (emailIsConfigured()) {
    try {
      await sendEmail({
        to: email,
        subject: "You are invited to the Jishnu Infotech agent portal",
        text: `You have been invited to join the Jishnu Infotech support team. Accept your invitation within 48 hours:\n${invitationUrl}`,
      });
    } catch (error) {
      await db.prepare("DELETE FROM agent_invitations WHERE id = ?").run(result.lastInsertRowid);
      console.error("Agent invitation email delivery failed:", error.message);
      return res.status(503).json({ error: "Could not send the agent invitation email. Please check SMTP settings and try again." });
    }
  }
  res.status(201).json({
    invitation: {
      email,
      expiresAt,
      emailSent: emailIsConfigured(),
      ...(!isProduction && !emailIsConfigured() ? { invitationUrl } : {}),
    },
  });
});

app.get("/api/agent-invitations", requireAuth, requireAdmin, async (_req, res) => {
  const invitations = await db.prepare(`
    SELECT i.id, i.email, i.expires_at AS expiresAt, i.accepted_at AS acceptedAt, i.created_at AS createdAt,
           u.name AS invitedBy
    FROM agent_invitations i JOIN users u ON u.id = i.invited_by
    WHERE i.accepted_at IS NULL AND datetime(i.expires_at) > CURRENT_TIMESTAMP
    ORDER BY i.created_at DESC
  `).all();
  res.json({ invitations });
});

app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("relay_session", { httpOnly: true, secure: isProduction, sameSite: "lax" });
  res.status(204).end();
});

app.get("/api/tickets", requireAuth, async (req, res) => {
  const rows = req.user.role === "agent"
    ? await db.prepare(`${ticketSelect} ORDER BY
        CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        t.updated_at DESC`).all()
    : req.user.is_company_admin
      ? await db.prepare(`${ticketSelect} WHERE t.company_id = ? ORDER BY t.updated_at DESC`).all(req.user.company_id)
      : await db.prepare(`${ticketSelect} WHERE t.customer_id = ? AND t.company_id = ? ORDER BY t.updated_at DESC`).all(req.user.id, req.user.company_id);
  res.json({ tickets: await Promise.all(rows.map(ticketSummary)) });
});

app.get("/api/reports", requireAuth, async (req, res) => {
  if (req.user.role !== "agent" && !req.user.is_company_admin) {
    return res.status(403).json({ error: "Reports are available to support agents and company administrators." });
  }
  const days = Number(req.query.days ?? 30);
  if (![7, 30, 90].includes(days)) return res.status(400).json({ error: "Choose a report period of 7, 30, or 90 days." });

  const today = new Date();
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const startAt = new Date(end - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + " 00:00:00";
  const endAt = new Date(end + 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + " 00:00:00";
  const scopeClause = req.user.role === "agent" ? "1 = 1" : "company_id = ?";
  const scopeParams = req.user.role === "agent" ? [] : [req.user.company_id];
  const createdRangeClause = `${scopeClause} AND created_at >= ? AND created_at < ?`;
  const createdRangeParams = [...scopeParams, startAt, endAt];
  const activeBacklog = (await db.prepare(`SELECT COUNT(*) AS count FROM tickets WHERE ${scopeClause} AND status != 'resolved'`)
    .get(...scopeParams)).count;
  const totals = await db.prepare(`
    SELECT COUNT(*) AS created,
           SUM(CASE WHEN status != 'resolved' THEN 1 ELSE 0 END) AS active
    FROM tickets WHERE ${createdRangeClause}
  `).get(...createdRangeParams);
  const statusRows = await db.prepare(`
    SELECT status, COUNT(*) AS count FROM tickets
    WHERE ${createdRangeClause} GROUP BY status
  `).all(...createdRangeParams);
  const priorityRows = await db.prepare(`
    SELECT priority, COUNT(*) AS count FROM tickets
    WHERE ${createdRangeClause} GROUP BY priority
  `).all(...createdRangeParams);
  const sourceRows = await db.prepare(`
    SELECT source, COUNT(*) AS count FROM tickets
    WHERE ${createdRangeClause} GROUP BY source
  `).all(...createdRangeParams);
  const createdByDay = await db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
    FROM tickets WHERE ${createdRangeClause} GROUP BY day
  `).all(...createdRangeParams);
  const resolvedByDay = await db.prepare(`
    SELECT substr(resolved_at, 1, 10) AS day, COUNT(*) AS count
    FROM tickets WHERE ${scopeClause} AND resolved_at >= ? AND resolved_at < ?
    GROUP BY day
  `).all(...scopeParams, startAt, endAt);
  const sla = await slaConfiguration();
  const slaTickets = await db.prepare(`
    SELECT created_at, first_response_at, resolved_at
    FROM tickets WHERE ${createdRangeClause}
  `).all(...createdRangeParams);
  const now = Date.now();
  const firstResponseSla = { onTime: 0, evaluated: 0 };
  const resolutionSla = { onTime: 0, evaluated: 0 };
  for (const ticket of slaTickets) {
    const responseDeadline = deadlineFrom(ticket.created_at, sla.firstResponseHours);
    if (ticket.first_response_at) {
      firstResponseSla.evaluated += 1;
      if (Date.parse(`${ticket.first_response_at.replace(" ", "T")}Z`) <= responseDeadline) firstResponseSla.onTime += 1;
    } else if (now > responseDeadline) {
      firstResponseSla.evaluated += 1;
    }

    const resolutionDeadline = deadlineFrom(ticket.created_at, sla.resolutionHours);
    if (ticket.resolved_at) {
      resolutionSla.evaluated += 1;
      if (Date.parse(`${ticket.resolved_at.replace(" ", "T")}Z`) <= resolutionDeadline) resolutionSla.onTime += 1;
    } else if (now > resolutionDeadline) {
      resolutionSla.evaluated += 1;
    }
  }
  const dateCounts = new Map();
  for (const row of createdByDay) dateCounts.set(row.day, { created: row.count, resolved: 0 });
  for (const row of resolvedByDay) {
    const counts = dateCounts.get(row.day) || { created: 0, resolved: 0 };
    counts.resolved = row.count;
    dateCounts.set(row.day, counts);
  }
  const daily = [];
  for (let time = end - (days - 1) * 24 * 60 * 60 * 1000; time <= end; time += 24 * 60 * 60 * 1000) {
    const day = new Date(time).toISOString().slice(0, 10);
    daily.push({ day, ...(dateCounts.get(day) || { created: 0, resolved: 0 }) });
  }
  const agentWorkload = await db.prepare(`
    SELECT u.id, u.name, u.routing_priority AS routingPriority,
           COUNT(DISTINCT CASE WHEN t.status != 'resolved' THEN t.id END) AS active,
           COUNT(DISTINCT CASE WHEN h.created_at >= ? AND h.created_at < ? THEN h.ticket_id END) AS assignedInPeriod,
           COUNT(DISTINCT CASE WHEN t.resolved_by = u.id AND t.resolved_at >= ? AND t.resolved_at < ? THEN t.id END) AS resolvedInPeriod
    FROM users u
    LEFT JOIN tickets t ON t.assignee_id = u.id
      AND ${req.user.role === "agent" ? "1 = 1" : "t.company_id = ?"}
    LEFT JOIN ticket_assignment_history h ON h.agent_id = u.id
      AND ${req.user.role === "agent" ? "1 = 1" : "EXISTS (SELECT 1 FROM tickets scoped WHERE scoped.id = h.ticket_id AND scoped.company_id = ?)"}
    WHERE u.role = 'agent' AND u.disabled_at IS NULL
    GROUP BY u.id ORDER BY u.routing_priority, active, u.id
  `).all(
    startAt, endAt, startAt, endAt,
    ...(req.user.role === "agent" ? [] : [req.user.company_id, req.user.company_id]),
  );
  const customerActivity = req.user.role === "customer" || req.user.is_admin
    ? await db.prepare(`
        SELECT u.id, u.name, u.email, c.name AS companyName,
               COUNT(DISTINCT CASE WHEN t.created_at >= ? AND t.created_at < ? THEN t.id END) AS raisedInPeriod,
               COUNT(DISTINCT CASE WHEN t.status != 'resolved' THEN t.id END) AS active,
               COUNT(DISTINCT CASE WHEN t.status = 'in_progress' THEN t.id END) AS inProgress,
               COUNT(DISTINCT CASE WHEN t.resolved_at >= ? AND t.resolved_at < ? THEN t.id END) AS resolvedInPeriod
        FROM users u
        LEFT JOIN companies c ON c.id = u.company_id
        LEFT JOIN tickets t ON t.customer_id = u.id
          AND ${req.user.role === "agent" ? "1 = 1" : "t.company_id = ?"}
        WHERE u.role = 'customer' AND u.approval_status = 'approved'
          AND ${req.user.role === "agent" ? "1 = 1" : "u.company_id = ?"}
        GROUP BY u.id, c.name ORDER BY 5 DESC, u.name
      `).all(
        startAt, endAt, startAt, endAt,
        ...(req.user.role === "agent" ? [] : [req.user.company_id, req.user.company_id]),
      )
    : [];
  const companyVolume = req.user.role === "agent" ? await db.prepare(`
    SELECT c.name, COUNT(t.id) AS count FROM tickets t
    JOIN companies c ON c.id = t.company_id
    WHERE t.created_at >= ? AND t.created_at < ?
    GROUP BY c.id ORDER BY count DESC, c.name LIMIT 8
  `).all(startAt, endAt) : [];

  res.json({
    days,
    startDate: startAt.slice(0, 10),
    endDate: new Date(end).toISOString().slice(0, 10),
    summary: { created: totals.created || 0, activeInPeriod: totals.active || 0, activeBacklog },
    statuses: ["open", "in_progress", "waiting", "resolved"].map((status) => ({
      status, count: statusRows.find((row) => row.status === status)?.count || 0,
    })),
    priorities: ["urgent", "high", "normal", "low"].map((priority) => ({
      priority, count: priorityRows.find((row) => row.priority === priority)?.count || 0,
    })),
    sources: ["portal", "email"].map((source) => ({
      source, count: sourceRows.find((row) => row.source === source)?.count || 0,
    })),
    daily,
    sla: {
      firstResponse: { ...firstResponseSla, targetHours: sla.firstResponseHours },
      resolution: { ...resolutionSla, targetHours: sla.resolutionHours },
    },
    agentWorkload,
    companyVolume,
    customerActivity,
  });
});

app.get("/api/customers", requireAuth, requireAgent, async (_req, res) => {
  const customers = await db.prepare(`
    SELECT u.id, u.name, u.email, u.company_id AS companyId, c.name AS companyName
    FROM users u LEFT JOIN companies c ON c.id = u.company_id
    WHERE u.role = 'customer' AND u.approval_status = 'approved' AND u.disabled_at IS NULL
    ORDER BY c.name, u.name
  `).all();
  res.json({ customers });
});

app.get("/api/agents", requireAuth, async (_req, res) => {
  const agents = await db.prepare(`
    SELECT id, name, email, is_admin AS isAdmin, routing_priority AS routingPriority
    FROM users WHERE role = 'agent' AND disabled_at IS NULL ORDER BY routing_priority, id
  `).all();
  res.json({ agents: agents.map((agent, index) => ({
    ...agent,
    priorityLabel: index === 0 ? "Primary" : index === 1 ? "Secondary" : `Agent ${index + 1}`,
  })) });
});

app.patch("/api/agents/:id", requireAuth, requireAdmin, async (req, res) => {
  const agentId = Number(req.params.id);
  if (!Number.isInteger(agentId) || agentId < 1) return res.status(400).json({ error: "Invalid agent id." });
  const hasDisabled = req.body.disabled !== undefined;
  const hasRoutingPriority = req.body.routingPriority !== undefined;
  if ((!hasDisabled && !hasRoutingPriority)
    || (hasDisabled && typeof req.body.disabled !== "boolean")
    || (hasRoutingPriority && (!Number.isInteger(req.body.routingPriority) || req.body.routingPriority < 1))) {
    return res.status(400).json({ error: "Choose a valid agent access or routing-priority update." });
  }
  const agent = await db.prepare("SELECT id, is_admin, disabled_at, routing_priority FROM users WHERE id = ? AND role = 'agent'").get(agentId);
  if (!agent) return res.status(404).json({ error: "Agent not found." });
  if (hasDisabled && req.body.disabled && agentId === req.user.id) {
    return res.status(400).json({ error: "You cannot disable your own account." });
  }
  if (hasDisabled && req.body.disabled && agent.is_admin) {
    const adminCount = (await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'agent' AND is_admin = 1 AND disabled_at IS NULL").get()).count;
    if (adminCount <= 1) return res.status(400).json({ error: "The last active administrator cannot be disabled." });
  }
  if (hasRoutingPriority) {
    if (agent.disabled_at) return res.status(400).json({ error: "Enable this agent before changing their routing priority." });
    const orderedAgents = await db.prepare(`
      SELECT id FROM users WHERE role = 'agent' AND disabled_at IS NULL
      ORDER BY routing_priority, id
    `).all();
    if (req.body.routingPriority > orderedAgents.length) return res.status(400).json({ error: "Choose a priority within the active agent list." });
    const currentIndex = orderedAgents.findIndex((entry) => entry.id === agentId);
    orderedAgents.splice(req.body.routingPriority - 1, 0, orderedAgents.splice(currentIndex, 1)[0]);
    const updatePriority = db.prepare("UPDATE users SET routing_priority = ? WHERE id = ?");
    await db.transaction(async () => {
      for (const [index, entry] of orderedAgents.entries()) {
        await updatePriority.run(index + 1, entry.id);
      }
    })();
  }
  if (hasDisabled) {
    await db.transaction(async () => {
      await db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").run(req.body.disabled ? new Date().toISOString() : null, agentId);
      if (req.body.disabled) {
        const releasedTickets = await db.prepare("SELECT id FROM tickets WHERE assignee_id = ? AND status != 'resolved'").all(agentId);
        await db.prepare("UPDATE tickets SET assignee_id = NULL WHERE assignee_id = ? AND status != 'resolved'").run(agentId);
        for (const ticket of releasedTickets) {
          await recordTicketAssignment(ticket.id, null, req.user.id, "agent_disabled");
        }
      }
      await normalizeActiveAgentPriorities();
    })();
  }
  res.json({ agent: await db.prepare("SELECT id, name, email, is_admin AS isAdmin, routing_priority AS routingPriority, disabled_at AS disabledAt FROM users WHERE id = ?").get(agentId) });
});

app.get("/api/admin/sla-settings", requireAuth, requireAdmin, async (_req, res) => {
  res.json({ sla: await slaConfiguration() });
});

app.put("/api/admin/sla-settings", requireAuth, requireAdmin, async (req, res) => {
  const firstResponseHours = Number(req.body.firstResponseHours);
  const resolutionHours = Number(req.body.resolutionHours);
  if (!Number.isFinite(firstResponseHours) || firstResponseHours < 0.25 || firstResponseHours > 720) {
    return res.status(400).json({ error: "First-response target must be between 0.25 and 720 hours." });
  }
  if (!Number.isFinite(resolutionHours) || resolutionHours < 0.5 || resolutionHours > 2160) {
    return res.status(400).json({ error: "Resolution target must be between 0.5 and 2,160 hours." });
  }
  await db.transaction(async () => {
    await db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('sla_first_response_hours', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(firstResponseHours));
    await db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('sla_resolution_hours', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(resolutionHours));
  })();
  res.json({ sla: await slaConfiguration() });
});

app.get("/api/admin/email-status", requireAuth, requireAdmin, async (_req, res) => {
  const outbox = await db.prepare("SELECT status, COUNT(*) AS count FROM mail_outbox GROUP BY status").all();
  const recentFailures = await db.prepare(`
    SELECT recipient, last_error AS error, status, attempts, created_at AS createdAt
    FROM mail_outbox WHERE last_error IS NOT NULL
    ORDER BY created_at DESC LIMIT 5
  `).all();
  res.json({
    smtpConfigured: emailIsConfigured(),
    imapConfigured: Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD),
    smtpHost: process.env.SMTP_HOST || null,
    inboundMailbox: process.env.IMAP_USER || null,
    outbox: Object.fromEntries(outbox.map((row) => [row.status, row.count])),
    recentFailures,
  });
});

app.get("/api/admin/agents", requireAuth, requireAdmin, async (_req, res) => {
  const agents = await db.prepare(`
    SELECT id, name, email, is_admin AS isAdmin, routing_priority AS routingPriority,
           disabled_at AS disabledAt
    FROM users WHERE role = 'agent' ORDER BY disabled_at IS NOT NULL, routing_priority, id
  `).all();
  const invitations = await db.prepare(`
    SELECT i.id, i.email, i.expires_at AS expiresAt, i.created_at AS createdAt, u.name AS invitedBy
    FROM agent_invitations i JOIN users u ON u.id = i.invited_by
    WHERE i.accepted_at IS NULL AND datetime(i.expires_at) > CURRENT_TIMESTAMP
    ORDER BY i.created_at DESC
  `).all();
  res.json({ agents, invitations });
});

app.get("/api/admin/companies", requireAuth, requireAdmin, async (_req, res) => {
  const companies = await db.prepare(`
    SELECT c.id, c.name, c.domain, c.is_active AS isActive,
           COUNT(DISTINCT u.id) AS userCount,
           COUNT(DISTINCT CASE WHEN u.approval_status = 'pending' THEN u.id END) AS pendingCount
    FROM companies c
    LEFT JOIN users u ON u.company_id = c.id AND u.role = 'customer'
    GROUP BY c.id ORDER BY c.name
  `).all();
  res.json({ companies });
});

app.post("/api/admin/companies", requireAuth, requireAdmin, async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const adminEmail = typeof req.body.adminEmail === "string" ? req.body.adminEmail.trim().toLowerCase() : "";
  const domainInput = typeof req.body.domain === "string" ? req.body.domain.trim().toLowerCase().replace(/^@/, "") : "";
  if (name.length < 2 || name.length > 120) return res.status(400).json({ error: "Company name must be between 2 and 120 characters." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) || adminEmail.length > 254) return res.status(400).json({ error: "Enter a valid first company administrator email." });
  if (domainInput && (!/^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domainInput))) {
    return res.status(400).json({ error: "Enter a valid company email domain, or leave it blank." });
  }
  if (await db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(adminEmail)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }
  if (isProduction && !emailIsConfigured()) return res.status(503).json({ error: "Company creation requires SMTP to invite its first administrator." });
  const slug = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
  if (!slug) return res.status(400).json({ error: "Company name must contain at least one letter or number." });
  const token = secureToken();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  let companyId;
  let invitationId;
  try {
    const created = db.transaction(async () => {
      const company = await db.prepare("INSERT INTO companies (name, slug, domain) VALUES (?, ?, ?)")
        .run(name, slug, domainInput || null);
      const companyIdValue = Number(company.lastInsertRowid);
      const invitation = await db.prepare(`
        INSERT INTO client_invitations (company_id, email, is_company_admin, token_hash, invited_by, expires_at)
        VALUES (?, ?, 1, ?, ?, ?)
      `).run(companyIdValue, adminEmail, hashToken(token), req.user.id, expiresAt);
      return { companyId: companyIdValue, invitationId: Number(invitation.lastInsertRowid) };
    });
    ({ companyId, invitationId } = await created());
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "A company with that name, address, or email domain already exists." });
    }
    throw error;
  }
  const invitationUrl = applicationUrl(`/client-invite?token=${encodeURIComponent(token)}`);
  try {
    if (emailIsConfigured()) {
      await sendEmail({
        to: adminEmail,
        subject: `Join ${name} on Jishnu Infotech Support`,
        text: `You have been invited to administer ${name}'s client support workspace. Accept within 48 hours:\n${invitationUrl}`,
      });
    }
  } catch (error) {
    await db.transaction(async () => {
      await db.prepare("DELETE FROM client_invitations WHERE id = ?").run(invitationId);
      await db.prepare("DELETE FROM companies WHERE id = ?").run(companyId);
    })();
    console.error("Company administrator invitation email delivery failed:", error.message);
    return res.status(503).json({ error: "Could not send the company administrator invitation. Check SMTP settings and try again." });
  }
  res.status(201).json({
    company: await db.prepare("SELECT id, name, domain FROM companies WHERE id = ?").get(companyId),
    invitation: {
      email: adminEmail,
      emailSent: emailIsConfigured(),
      expiresAt,
      ...(!isProduction && !emailIsConfigured() ? { invitationUrl } : {}),
    },
  });
});

app.get("/api/company/users", requireAuth, requireCompanyAdmin, async (req, res) => {
  const requestedCompanyId = Number(req.query.companyId);
  const companyId = req.user.role === "agent" && req.user.is_admin ? requestedCompanyId : req.user.company_id;
  if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error: "Choose a company." });
  const company = await db.prepare("SELECT id, name FROM companies WHERE id = ?").get(companyId);
  if (!company) return res.status(404).json({ error: "Company not found." });
  const users = await db.prepare(`
    SELECT id, name, email, is_company_admin AS isCompanyAdmin,
           approval_status AS approvalStatus, disabled_at AS disabledAt, created_at AS createdAt
    FROM users WHERE company_id = ? AND role = 'customer' ORDER BY approval_status = 'pending' DESC, name
  `).all(companyId);
  const invitations = await db.prepare(`
    SELECT id, email, is_company_admin AS isCompanyAdmin, expires_at AS expiresAt, created_at AS createdAt
    FROM client_invitations WHERE company_id = ? AND accepted_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP
    ORDER BY created_at DESC
  `).all(companyId);
  const joinCodes = await db.prepare(`
    SELECT id, expires_at AS expiresAt, revoked_at AS revokedAt, created_at AS createdAt
    FROM company_join_codes WHERE company_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(companyId);
  res.json({ company, users, invitations, joinCodes });
});

app.post("/api/company/invitations", requireAuth, requireCompanyAdmin, async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const isCompanyAdmin = req.body.isCompanyAdmin === true;
  const requestedCompanyId = Number(req.body.companyId);
  const companyId = req.user.role === "agent" && req.user.is_admin ? requestedCompanyId : req.user.company_id;
  if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error: "Choose a company." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid client email address." });
  if (await db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)) return res.status(409).json({ error: "An account with this email already exists." });
  if (await db.prepare("SELECT 1 FROM client_invitations WHERE email = ? COLLATE NOCASE AND accepted_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP").get(email)) {
    return res.status(409).json({ error: "A valid client invitation has already been sent to this email." });
  }
  if (isProduction && !emailIsConfigured()) return res.status(503).json({ error: "Client invitations require configured outbound SMTP email." });
  const company = await db.prepare("SELECT id, name FROM companies WHERE id = ? AND is_active = 1").get(companyId);
  if (!company) return res.status(404).json({ error: "Company not found." });
  const token = secureToken();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const result = await db.prepare(`
    INSERT INTO client_invitations (company_id, email, is_company_admin, token_hash, invited_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(companyId, email, isCompanyAdmin ? 1 : 0, hashToken(token), req.user.id, expiresAt);
  const invitationUrl = applicationUrl(`/client-invite?token=${encodeURIComponent(token)}`);
  try {
    if (emailIsConfigured()) await sendEmail({
      to: email,
      subject: `Invitation to ${company.name} support`,
      text: `You have been invited to the ${company.name} client support portal. Accept within 48 hours:\n${invitationUrl}`,
    });
  } catch (error) {
    await db.prepare("DELETE FROM client_invitations WHERE id = ?").run(result.lastInsertRowid);
    console.error("Client invitation email delivery failed:", error.message);
    return res.status(503).json({ error: "Could not send the client invitation. Check SMTP settings and try again." });
  }
  res.status(201).json({
    invitation: {
      email, expiresAt, emailSent: emailIsConfigured(),
      ...(!isProduction && !emailIsConfigured() ? { invitationUrl } : {}),
    },
  });
});

app.post("/api/company/join-codes", requireAuth, requireCompanyAdmin, async (req, res) => {
  const requestedCompanyId = Number(req.body.companyId);
  const companyId = req.user.role === "agent" && req.user.is_admin ? requestedCompanyId : req.user.company_id;
  if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error: "Choose a company." });
  const company = await db.prepare("SELECT id FROM companies WHERE id = ? AND is_active = 1").get(companyId);
  if (!company) return res.status(404).json({ error: "Company not found." });
  const code = secureToken().replace(/[-_]/g, "").slice(0, 16).toUpperCase();
  await db.prepare("INSERT INTO company_join_codes (company_id, code_hash, created_by, expires_at) VALUES (?, ?, ?, ?)")
    .run(companyId, hashToken(code), req.user.id, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
  res.status(201).json({ code, expiresInDays: 30 });
});

app.delete("/api/company/join-codes/:id", requireAuth, requireCompanyAdmin, async (req, res) => {
  const codeId = Number(req.params.id);
  const code = await db.prepare("SELECT id, company_id, revoked_at FROM company_join_codes WHERE id = ?").get(codeId);
  if (!code) return res.status(404).json({ error: "Invitation code not found." });
  if (!(req.user.role === "agent" && req.user.is_admin) && code.company_id !== req.user.company_id) {
    return res.status(404).json({ error: "Invitation code not found." });
  }
  await db.prepare("UPDATE company_join_codes SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(codeId);
  res.status(204).end();
});

app.patch("/api/company/users/:id", requireAuth, requireCompanyAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const user = await db.prepare("SELECT id, company_id, is_company_admin, approval_status, disabled_at FROM users WHERE id = ? AND role = 'customer'").get(userId);
  if (!user) return res.status(404).json({ error: "Client user not found." });
  const isWorkspaceAdmin = req.user.role === "agent" && req.user.is_admin;
  if (!isWorkspaceAdmin && user.company_id !== req.user.company_id) return res.status(404).json({ error: "Client user not found." });
  const updates = [];
  const values = [];
  if (req.body.approvalStatus !== undefined) {
    if (!["approved", "rejected"].includes(req.body.approvalStatus)) return res.status(400).json({ error: "Choose approved or rejected enrollment status." });
    updates.push("approval_status = ?");
    values.push(req.body.approvalStatus);
  }
  if (req.body.isCompanyAdmin !== undefined) {
    if (typeof req.body.isCompanyAdmin !== "boolean") return res.status(400).json({ error: "Company administrator setting must be true or false." });
    if (req.body.isCompanyAdmin !== Boolean(user.is_company_admin) && req.body.isCompanyAdmin === false) {
      const adminCount = (await db.prepare("SELECT COUNT(*) AS count FROM users WHERE company_id = ? AND is_company_admin = 1 AND approval_status = 'approved' AND disabled_at IS NULL").get(user.company_id)).count;
      if (user.is_company_admin && adminCount <= 1) return res.status(400).json({ error: "The last active company administrator cannot be removed." });
    }
    updates.push("is_company_admin = ?");
    values.push(req.body.isCompanyAdmin ? 1 : 0);
  }
  if (req.body.disabled !== undefined) {
    if (typeof req.body.disabled !== "boolean") return res.status(400).json({ error: "Disabled setting must be true or false." });
    if (req.body.disabled && user.is_company_admin) {
      const adminCount = (await db.prepare("SELECT COUNT(*) AS count FROM users WHERE company_id = ? AND is_company_admin = 1 AND approval_status = 'approved' AND disabled_at IS NULL").get(user.company_id)).count;
      if (adminCount <= 1) return res.status(400).json({ error: "The last active company administrator cannot be disabled." });
    }
    updates.push("disabled_at = ?");
    values.push(req.body.disabled ? new Date().toISOString() : null);
  }
  if (updates.length === 0) return res.status(400).json({ error: "Choose an account setting to update." });
  values.push(userId);
  await db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  await db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND kind = ?")
    .run(req.user.id, `company_join_request:${userId}`);
  const updatedUser = await db.prepare(`
    SELECT id, name, email, is_company_admin AS isCompanyAdmin,
           approval_status AS approvalStatus, disabled_at AS disabledAt
    FROM users WHERE id = ?
  `).get(userId);
  res.json({ user: updatedUser });
});

app.get("/api/notifications", requireAuth, requireAgent, async (req, res) => {
  const notifications = await db.prepare(`
    SELECT id, ticket_id AS ticketId, kind, message, read_at AS readAt, created_at AS createdAt
    FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json({ notifications, unreadCount: notifications.filter((notification) => !notification.readAt).length });
});

app.post("/api/notifications/read", requireAuth, requireAgent, async (req, res) => {
  const id = Number(req.body.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid notification id." });
  await db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(id, req.user.id);
  res.status(204).end();
});

app.get("/api/tickets/:id", requireAuth, async (req, res) => {
  const ticketId = Number(req.params.id);
  if (!Number.isInteger(ticketId) || ticketId < 1) return res.status(400).json({ error: "Invalid ticket id." });
  if (!await canAccessTicket(req.user, ticketId)) return res.status(404).json({ error: "Ticket not found." });

  const ticket = await db.prepare(`${ticketSelect} WHERE t.id = ?`).get(ticketId);
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });
  const messages = (await db.prepare(`
    SELECT m.id, m.body, m.is_internal AS isInternal, m.created_at AS createdAt, u.id AS authorId, u.name AS authorName, u.role AS authorRole
    FROM messages m JOIN users u ON u.id = m.author_id
    WHERE m.ticket_id = ? AND (? = 1 OR m.is_internal = 0) ORDER BY m.id
  `).all(ticketId, req.user.role === "agent" ? 1 : 0)
  ).map((message) => ({ ...message, isInternal: Boolean(message.isInternal) }));
  const attachments = await db.prepare(`
    SELECT id, original_name AS name, mime_type AS mimeType, size_bytes AS sizeBytes,
           created_at AS createdAt, uploaded_by AS uploadedBy
    FROM ticket_attachments WHERE ticket_id = ? ORDER BY id
  `).all(ticketId);
  const assignmentHistory = req.user.role === "agent" || req.user.is_company_admin
    ? await db.prepare(`
        SELECT h.id, h.source, h.created_at AS createdAt,
               agent.id AS agentId, COALESCE(agent.name, 'Unassigned') AS agentName,
               actor.name AS assignedByName
        FROM ticket_assignment_history h
        LEFT JOIN users agent ON agent.id = h.agent_id
        LEFT JOIN users actor ON actor.id = h.assigned_by
        WHERE h.ticket_id = ? ORDER BY h.id
      `).all(ticketId)
    : [];
  res.json({
    ticket: await ticketSummary(ticket),
    messages,
    attachments,
    assignmentHistory,
    categories: ticketCategories,
    canRate: req.user.role === "customer" && req.user.id === ticket.customer_id && ticket.status === "resolved",
  });
});

function receiveAttachments(req, res, next) {
  attachmentUpload.array("attachments", 5)(req, res, (error) => {
    if (!error) return next();
    const message = error instanceof multer.MulterError
      ? error.code === "LIMIT_FILE_SIZE"
        ? "Each attachment must be 10 MB or smaller."
        : error.code === "LIMIT_FILE_COUNT"
          ? "Attach up to 5 files to a ticket."
          : error.message
      : error.message;
    res.status(400).json({ error: message });
  });
}

function discardUploadedFiles(files = []) {
  for (const file of files) {
    try { unlinkSync(file.path); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

app.get("/api/tickets/:id/attachments/:attachmentId", requireAuth, async (req, res) => {
  const ticketId = Number(req.params.id);
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isInteger(ticketId) || !Number.isInteger(attachmentId) || ticketId < 1 || attachmentId < 1) {
    return res.status(400).json({ error: "Invalid ticket or attachment id." });
  }
  if (!await canAccessTicket(req.user, ticketId)) return res.status(404).json({ error: "Attachment not found." });
  const attachment = await db.prepare("SELECT storage_name, original_name, mime_type FROM ticket_attachments WHERE id = ? AND ticket_id = ?")
    .get(attachmentId, ticketId);
  if (!attachment) return res.status(404).json({ error: "Attachment not found." });
  res.type(attachment.mime_type);
  res.download(resolve(attachmentsRoot, attachment.storage_name), attachment.original_name, (error) => {
    if (error && !res.headersSent) res.status(error.code === "ENOENT" ? 404 : 500).json({ error: "Could not retrieve this attachment." });
  });
});

app.post("/api/tickets/:id/rating", requireAuth, async (req, res) => {
  const ticketId = Number(req.params.id);
  const rating = Number(req.body.rating);
  const comment = typeof req.body.comment === "string" ? req.body.comment.trim() : "";
  if (!Number.isInteger(ticketId) || ticketId < 1) return res.status(400).json({ error: "Invalid ticket id." });
  if (req.user.role !== "customer") return res.status(403).json({ error: "Only the ticket owner can submit customer feedback." });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "Choose a rating from 1 to 5." });
  if (comment.length > 1000) return res.status(400).json({ error: "Feedback must be 1,000 characters or fewer." });
  const ticket = await db.prepare("SELECT id, customer_id, status FROM tickets WHERE id = ? AND company_id = ?").get(ticketId, req.user.company_id);
  if (!ticket || ticket.customer_id !== req.user.id) return res.status(404).json({ error: "Ticket not found." });
  if (ticket.status !== "resolved") return res.status(409).json({ error: "Feedback is available after this ticket is resolved." });
  try {
    await db.prepare("INSERT INTO ticket_ratings (ticket_id, customer_id, rating, comment) VALUES (?, ?, ?, ?)")
      .run(ticketId, req.user.id, rating, comment);
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "Feedback has already been submitted for this ticket." });
    throw error;
  }
  res.status(201).json({
    rating: await db.prepare(`
      SELECT rating, comment, created_at AS createdAt, customer_id AS customerId
      FROM ticket_ratings WHERE ticket_id = ?
    `).get(ticketId),
  });
});

app.post("/api/tickets", requireAuth, receiveAttachments, async (req, res) => {
  const subject = typeof req.body.subject === "string" ? req.body.subject.trim() : "";
  const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
  const priority = ["low", "normal", "high", "urgent"].includes(req.body.priority) ? req.body.priority : "normal";
  if (subject.length < 4 || subject.length > 160) {
    discardUploadedFiles(req.files);
    return res.status(400).json({ error: "Subject must be between 4 and 160 characters." });
  }
  if (description.length < 10 || description.length > 5000) {
    discardUploadedFiles(req.files);
    return res.status(400).json({ error: "Description must be between 10 and 5,000 characters." });
  }
  const metadata = normalizedTicketMetadata(req.body);
  if (metadata.error) {
    discardUploadedFiles(req.files);
    return res.status(400).json({ error: metadata.error });
  }

  let customerId = req.user.id;
  let companyId = req.user.company_id;
  if (req.user.role === "agent") {
    customerId = Number(req.body.customerId);
    if (!Number.isInteger(customerId) || customerId < 1) {
      discardUploadedFiles(req.files);
      return res.status(400).json({ error: "Choose a customer for this ticket." });
    }
    const customer = await db.prepare("SELECT id, company_id FROM users WHERE id = ? AND role = 'customer' AND approval_status = 'approved' AND disabled_at IS NULL").get(customerId);
    if (!customer) {
      discardUploadedFiles(req.files);
      return res.status(400).json({ error: "Choose a valid customer." });
    }
    companyId = customer.company_id;
  }
  const requestedAssignee = req.body.assigneeId === "" || req.body.assigneeId === undefined ? null : Number(req.body.assigneeId);
  if (requestedAssignee !== null && (!Number.isInteger(requestedAssignee) || requestedAssignee < 1)) {
    discardUploadedFiles(req.files);
    return res.status(400).json({ error: "Choose a valid support agent." });
  }
  if (requestedAssignee !== null && !await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'agent' AND disabled_at IS NULL").get(requestedAssignee)) {
    discardUploadedFiles(req.files);
    return res.status(400).json({ error: "Choose an active support agent." });
  }
  const agent = req.user.role === "agent"
    ? { id: req.user.id }
    : requestedAssignee
      ? { id: requestedAssignee }
      : await selectRoutingAgent();
  const assignmentSource = req.user.role === "agent" ? "agent_created"
    : requestedAssignee ? "client_selected" : "automatic";
  const files = req.files || [];
  const verifiedFiles = [];
  try {
    for (const file of files) {
      const detected = await fileTypeFromFile(file.path);
      const requiredExtension = permittedAttachmentTypes.get(detected?.mime);
      if (!detected || !requiredExtension || file.mimetype !== detected.mime) {
        throw new Error(`The attachment "${file.originalname}" does not match an allowed PDF or image file.`);
      }
      const displayName = basename(file.originalname)
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[<>:"/\\|?*]/g, "_")
        .replace(/[. ]+$/, "")
        .slice(0, 150);
      const baseName = displayName.replace(/\.[^.]*$/, "").trim() || "attachment";
      verifiedFiles.push({ ...file, originalName: `${baseName}${requiredExtension}`, mimeType: detected.mime });
    }
  } catch (error) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: error.message });
  }

  let id;
  try {
    const createTicket = db.transaction(async () => {
      const result = await db.prepare(`
        INSERT INTO tickets (subject, description, priority, category, tags_json, custom_fields_json, customer_id, company_id, assignee_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        subject, description, priority, metadata.category, JSON.stringify(metadata.tags),
        JSON.stringify(metadata.customFields), customerId, companyId || null, agent?.id || null,
      );
      const ticketId = Number(result.lastInsertRowid);
      await db.prepare("INSERT INTO messages (ticket_id, author_id, body) VALUES (?, ?, ?)").run(ticketId, req.user.id, description);
      await recordTicketAssignment(ticketId, agent?.id, req.user.id, assignmentSource);
      const insertAttachment = db.prepare(`
        INSERT INTO ticket_attachments (ticket_id, uploaded_by, storage_name, original_name, mime_type, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const file of verifiedFiles) {
        await insertAttachment.run(ticketId, req.user.id, file.filename, file.originalName, file.mimeType, file.size);
      }
      return ticketId;
    });
    id = await createTicket();
  } catch (error) {
    discardUploadedFiles(files);
    throw error;
  }
  const ticket = await db.prepare(`${ticketSelect} WHERE t.id = ?`).get(id);
  res.status(201).json({ ticket: await ticketSummary(ticket) });
});

app.post("/api/tickets/:id/messages", requireAuth, async (req, res) => {
  const ticketId = Number(req.params.id);
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
  const isInternal = req.body.internal === true;
  if (!Number.isInteger(ticketId) || ticketId < 1) return res.status(400).json({ error: "Invalid ticket id." });
  if (!await canAccessTicket(req.user, ticketId)) return res.status(404).json({ error: "Ticket not found." });
  if (isInternal && req.user.role !== "agent") return res.status(403).json({ error: "Internal notes are only available to support agents." });
  if (body.length < 1 || body.length > 5000) return res.status(400).json({ error: "Reply must be between 1 and 5,000 characters." });
  const ticket = await db.prepare(`
    SELECT t.status, t.first_response_at, t.email_thread_id, t.subject, t.customer_id, c.email AS customer_email
    FROM tickets t JOIN users c ON c.id = t.customer_id WHERE t.id = ?
  `).get(ticketId);
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });

  const insertMessage = db.transaction(async () => {
    const emailMessageId = !isInternal && req.user.role !== "customer" && emailIsConfigured()
      ? `<${randomUUID()}@${process.env.SMTP_MESSAGE_ID_DOMAIN || "support.jishnuinfotech.com"}>`
      : null;
    const result = await db.prepare("INSERT INTO messages (ticket_id, author_id, body, is_internal, email_message_id) VALUES (?, ?, ?, ?, ?)")
      .run(ticketId, req.user.id, body, isInternal ? 1 : 0, emailMessageId);
    await db.prepare("UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ticketId);
    if (!isInternal && req.user.role === "customer" && ticket.status === "resolved") {
      await db.prepare("UPDATE tickets SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE id = ?").run(ticketId);
    }
    if (!isInternal && req.user.role !== "customer" && !ticket.first_response_at) {
      await db.prepare("UPDATE tickets SET first_response_at = CURRENT_TIMESTAMP WHERE id = ?").run(ticketId);
    }
    if (emailMessageId) {
      const previous = await db.prepare("SELECT email_message_id FROM messages WHERE ticket_id = ? AND id < ? AND email_message_id IS NOT NULL ORDER BY id DESC LIMIT 1")
        .get(ticketId, result.lastInsertRowid);
      const referencesHeader = [...new Set([ticket.email_thread_id, previous?.email_message_id].filter(Boolean))].join(" ");
      await db.prepare("INSERT INTO mail_outbox (recipient, subject, body, message_id, references_header) VALUES (?, ?, ?, ?, ?)")
        .run(
          ticket.customer_email,
          `Re: ${ticket.subject}`,
          body,
          emailMessageId,
          referencesHeader || null,
        );
      await db.prepare("UPDATE messages SET email_message_id = ? WHERE id = ?").run(emailMessageId, result.lastInsertRowid);
    }
    return result.lastInsertRowid;
  });
  const id = await insertMessage();
  const messageRow = await db.prepare(`
    SELECT m.id, m.body, m.is_internal AS isInternal, m.created_at AS createdAt, u.id AS authorId, u.name AS authorName, u.role AS authorRole
    FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?
  `).get(id);
  const message = { ...messageRow, isInternal: Boolean(messageRow.isInternal) };
  res.status(201).json({ message, emailQueued: !isInternal && req.user.role !== "customer" && emailIsConfigured() });
});

app.patch("/api/tickets/:id", requireAuth, requireAgent, async (req, res) => {
  const ticketId = Number(req.params.id);
  const status = req.body.status;
  const priority = req.body.priority;
  const assigneeId = req.body.assigneeId;
  const metadataRequested = ["category", "tags", "customFields"].some((key) => req.body[key] !== undefined);
  if (!Number.isInteger(ticketId) || ticketId < 1) return res.status(400).json({ error: "Invalid ticket id." });
  if (status !== undefined && !["open", "in_progress", "waiting", "resolved"].includes(status)) {
    return res.status(400).json({ error: "Invalid ticket status." });
  }
  if (priority !== undefined && !["low", "normal", "high", "urgent"].includes(priority)) {
    return res.status(400).json({ error: "Invalid ticket priority." });
  }
  if (assigneeId !== undefined && assigneeId !== null) {
    if (!Number.isInteger(assigneeId) || assigneeId < 1) return res.status(400).json({ error: "Invalid agent assignment." });
    const agent = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'agent' AND disabled_at IS NULL").get(assigneeId);
    if (!agent) return res.status(400).json({ error: "Choose a valid support agent." });
  }
  const existing = await db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId);
  if (!existing) return res.status(404).json({ error: "Ticket not found." });
  const metadata = metadataRequested ? normalizedTicketMetadata(req.body, {
    category: existing.category,
    tags: parseJsonArray(existing.tags_json),
    customFields: parseJsonObject(existing.custom_fields_json),
  }) : null;
  if (metadata?.error) return res.status(400).json({ error: metadata.error });
  if (status === undefined && priority === undefined && assigneeId === undefined && !metadataRequested) {
    return res.status(400).json({ error: "Choose ticket details to update." });
  }
  const fields = [];
  const values = [];
  if (status !== undefined) { fields.push("status = ?"); values.push(status); }
  if (priority !== undefined) { fields.push("priority = ?"); values.push(priority); }
  if (assigneeId !== undefined) { fields.push("assignee_id = ?"); values.push(assigneeId); }
  if (metadata) {
    fields.push("category = ?", "tags_json = ?", "custom_fields_json = ?");
    values.push(metadata.category, JSON.stringify(metadata.tags), JSON.stringify(metadata.customFields));
  }
  fields.push("updated_at = CURRENT_TIMESTAMP");
  if (status === "resolved") {
    fields.push("resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP)", "resolved_by = COALESCE(resolved_by, ?)");
    values.push(req.user.id);
  } else if (status !== undefined) {
    fields.push("resolved_at = NULL", "resolved_by = NULL");
  }
  values.push(ticketId);
  await db.transaction(async () => {
    await db.prepare(`UPDATE tickets SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    if (assigneeId !== undefined && assigneeId !== existing.assignee_id) {
      await recordTicketAssignment(ticketId, assigneeId, req.user.id, assigneeId === null ? "agent_unassigned" : "agent_reassigned");
    }
  })();
  res.json({ ticket: await ticketSummary(await db.prepare(`${ticketSelect} WHERE t.id = ?`).get(ticketId)) });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found." }));

let outboxRunning = false;
async function flushMailOutbox() {
  if (!emailIsConfigured() || outboxRunning) return;
  outboxRunning = true;
  try {
    const messages = await db.prepare(`
      SELECT id, recipient, subject, body, message_id AS messageId,
             references_header AS referencesHeader, attempts
      FROM mail_outbox
      WHERE status = 'pending' AND attempts < 5
      ORDER BY id LIMIT 20
    `).all();
    for (const message of messages) {
      try {
        const references = message.referencesHeader
          ? message.referencesHeader.split(/\s+/).filter(Boolean)
          : [];
        await sendEmail({
          to: message.recipient,
          subject: message.subject,
          text: message.body,
          messageId: message.messageId,
          headers: references.length
            ? { References: references.join(" "), "In-Reply-To": references[references.length - 1] }
            : undefined,
        });
        await db.prepare("UPDATE mail_outbox SET status = 'sent', sent_at = CURRENT_TIMESTAMP, attempts = attempts + 1, last_error = NULL WHERE id = ?").run(message.id);
      } catch (error) {
        const attempts = message.attempts + 1;
        await db.prepare(`
          UPDATE mail_outbox SET attempts = ?, last_error = ?, status = ?
          WHERE id = ?
        `).run(attempts, String(error.message).slice(0, 500), attempts >= 5 ? "failed" : "pending", message.id);
        console.error(`Outbound support email ${message.id} failed (attempt ${attempts}/5):`, error.message);
      }
    }
  } finally {
    outboxRunning = false;
  }
}

let mailboxPollRunning = false;
async function pollSupportMailbox() {
  if (mailboxPollRunning || !process.env.IMAP_HOST || !process.env.IMAP_USER || !process.env.IMAP_PASSWORD) return;
  mailboxPollRunning = true;
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT || (process.env.IMAP_SECURE === "false" ? 143 : 993)),
    secure: process.env.IMAP_SECURE !== "false",
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
    logger: false,
  });
  try {
    await client.connect();
    const mailbox = process.env.IMAP_MAILBOX || "INBOX";
    const lock = await client.getMailboxLock(mailbox);
    try {
      const uidValidity = String(client.mailbox.uidValidity);
      const cursor = await db.prepare("SELECT uid_validity, last_uid FROM email_cursors WHERE mailbox = ?").get(mailbox);
      const lastUid = cursor?.uid_validity === uidValidity ? cursor.last_uid : 0;
      const uids = await client.search({ uid: `${lastUid + 1}:*` });
      const maximumUid = uids.reduce((maximum, uid) => Math.max(maximum, uid), lastUid);
      for (const uid of uids.sort((left, right) => left - right)) {
        const fetched = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!fetched?.source) continue;
        const parsed = await simpleParser(fetched.source);
        const messageId = parsed.messageId?.trim();
        if (messageId && !await db.prepare("SELECT 1 FROM messages WHERE email_message_id = ?").get(messageId)) {
          const sender = parsed.from?.value?.[0]?.address?.trim().toLowerCase();
          const subject = (parsed.subject || "Email support request").replace(/^\s*(re|fw|fwd)\s*:\s*/i, "").trim().slice(0, 160) || "Email support request";
          const body = (parsed.text || parsed.html?.replace(/<[^>]*>/g, " ") || "").trim().slice(0, 5000);
          if (sender && body) {
            let senderUser = await db.prepare("SELECT id, role, email, company_id AS companyId, approval_status AS approvalStatus FROM users WHERE email = ? COLLATE NOCASE").get(sender);
            if (senderUser?.role === "agent") {
              await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
            } else if (senderUser && senderUser.approvalStatus !== "approved") {
              console.warn(`Inbound email from ${sender} skipped because the client account is not approved.`);
              await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
            } else {
              const senderDomain = sender.split("@")[1];
              const senderCompany = senderUser
                ? await db.prepare("SELECT id FROM companies WHERE id = ? AND is_active = 1").get(senderUser.companyId)
                : await db.prepare("SELECT id FROM companies WHERE domain = ? COLLATE NOCASE AND is_active = 1").get(senderDomain);
              if (!senderCompany) {
                console.warn(`Inbound email from ${sender} has no active client company mapping; configure the company's verified email domain.`);
                await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
                continue;
              }
              const references = [
                ...(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []),
                ...(parsed.inReplyTo ? [parsed.inReplyTo] : []),
              ].filter(Boolean);
              const referencedTicket = references.length
                ? await db.prepare(`
                    SELECT t.id FROM tickets t
                    LEFT JOIN messages m ON m.ticket_id = t.id
                    WHERE t.email_thread_id IN (${references.map(() => "?").join(",")})
                       OR m.email_message_id IN (${references.map(() => "?").join(",")})
                    ORDER BY t.id DESC LIMIT 1
                  `).get(...references, ...references)
                : null;

              const inboundId = senderUser?.id || Number((await db.prepare(
                "INSERT INTO users (name, email, password_hash, role, company_id, approval_status) VALUES (?, ?, ?, 'customer', ?, 'approved')",
              ).run(parsed.from.value[0].name?.trim().slice(0, 100) || sender, sender, bcrypt.hashSync(secureToken(), 12), senderCompany.id)).lastInsertRowid);
              const insertInbound = db.transaction(async () => {
                let ticketId = referencedTicket?.id;
                if (!ticketId) {
                  const assignedAgent = await selectRoutingAgent();
                  ticketId = Number((await db.prepare(`
                    INSERT INTO tickets (subject, description, status, priority, customer_id, company_id, assignee_id, source, email_thread_id)
                    VALUES (?, ?, 'open', 'normal', ?, ?, ?, 'email', ?)
                  `).run(subject, body, inboundId, senderCompany.id, assignedAgent?.id || null, messageId)).lastInsertRowid);
                  await recordTicketAssignment(ticketId, assignedAgent?.id || null, null, "email_automatic");
                }
                await db.prepare("INSERT OR IGNORE INTO messages (ticket_id, author_id, body, email_message_id) VALUES (?, ?, ?, ?)")
                  .run(ticketId, inboundId, body, messageId);
                await db.prepare("UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ticketId);
                const ticket = await db.prepare("SELECT assignee_id FROM tickets WHERE id = ?").get(ticketId);
                const recipients = ticket.assignee_id
                  ? [ticket.assignee_id]
                  : (await db.prepare("SELECT id FROM users WHERE role = 'agent' AND disabled_at IS NULL").all()).map((agent) => agent.id);
                const addNotification = db.prepare("INSERT OR IGNORE INTO notifications (user_id, ticket_id, kind, message) VALUES (?, ?, ?, ?)");
                for (const recipientId of recipients) {
                  await addNotification.run(recipientId, ticketId, `client_email_reply:${messageId}`, `New email from ${sender} on ${subject}`);
                }
              });
              await insertInbound();
              await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
            }
          }
        }
        await db.prepare(`
          INSERT INTO email_cursors (mailbox, uid_validity, last_uid, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(mailbox) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = MAX(email_cursors.last_uid, excluded.last_uid), updated_at = CURRENT_TIMESTAMP
        `).run(mailbox, uidValidity, uid);
      }
      await db.prepare(`
        INSERT INTO email_cursors (mailbox, uid_validity, last_uid, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(mailbox) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = MAX(email_cursors.last_uid, excluded.last_uid), updated_at = CURRENT_TIMESTAMP
      `).run(mailbox, uidValidity, maximumUid);
    } finally {
      lock.release();
    }
  } finally {
    try {
      if (client.usable) await client.logout();
    } finally {
      mailboxPollRunning = false;
    }
  }
}

async function checkServiceLevelDeadlines() {
  const sla = await slaConfiguration();
  const agents = await db.prepare("SELECT id FROM users WHERE role = 'agent' AND disabled_at IS NULL").all();
  const tickets = await db.prepare(`
    SELECT id, subject, status, created_at AS createdAt, first_response_at AS firstResponseAt, assignee_id AS assigneeId
    FROM tickets WHERE status != 'resolved'
  `).all();
  const addNotification = db.prepare("INSERT OR IGNORE INTO notifications (user_id, ticket_id, kind, message) VALUES (?, ?, ?, ?)");
  for (const ticket of tickets) {
    const recipients = ticket.assigneeId ? [ticket.assigneeId] : agents.map((agent) => agent.id);
    const overdueKinds = [];
    if (!ticket.firstResponseAt && Date.now() > deadlineFrom(ticket.createdAt, sla.firstResponseHours)) {
      overdueKinds.push(["first_response_overdue", `First response is overdue for #${ticket.id}: ${ticket.subject}`]);
    }
    if (Date.now() > deadlineFrom(ticket.createdAt, sla.resolutionHours)) {
      overdueKinds.push(["resolution_overdue", `Resolution target is overdue for #${ticket.id}: ${ticket.subject}`]);
    }
    for (const [kind, message] of overdueKinds) {
      for (const recipientId of recipients) {
        await addNotification.run(recipientId, ticket.id, kind, message);
      }
    }
  }
}

let slaCheckRunning = false;
async function safeSlaCheck() {
  if (slaCheckRunning) return;
  slaCheckRunning = true;
  try {
    await checkServiceLevelDeadlines();
  } catch (error) {
    console.error("Ticket SLA check failed:", error.message);
  } finally {
    slaCheckRunning = false;
  }
}

if (isProduction) {
  const webRoot = resolve("dist");
  app.use(express.static(webRoot));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve(webRoot, "index.html")));
}

await initializeDatabase();

app.listen(port, () => {
  console.log(`Ticketing API listening on port ${port}`);
  void safeSlaCheck();
  setInterval(() => { void safeSlaCheck(); }, 60 * 1000);
  if (emailIsConfigured()) {
    void flushMailOutbox();
    setInterval(() => { void flushMailOutbox(); }, 15 * 1000);
  }
  if (process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD) {
    void pollSupportMailbox().catch((error) => console.error("Inbound support email polling failed:", error.message));
    setInterval(() => {
      void pollSupportMailbox().catch((error) => console.error("Inbound support email polling failed:", error.message));
    }, Number(process.env.IMAP_POLL_INTERVAL_MS || 30_000));
  }
});
