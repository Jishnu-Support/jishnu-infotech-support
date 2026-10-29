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
import { parseHistoricalTicketWorkbook } from "./historical-ticket-import.js";
import { db, initializeDatabase } from "./db.js";
import { applicationUrl, emailIsConfigured, sendEmail } from "./email.js";
import { reportAccess, ticketAccessFilter, isInternalConsultant, canManageTicket, canEditChatMessage, canEditConsultantSolution } from "./authz.js";
import { normalizedTicketMetadata, ticketCategories, isAllowedAttachment, sanitizeAttachmentName } from "./validation.js";
import { deriveCompanyPrefix, formatCompanyTicketNumber } from "./ticket-numbering.js";
import { calculateReportDateRange, aggregateCompanyReport, formatTicketStatusDisplay } from "./company-reports.js";
import {
  getValidTATStartTime,
  calculateTATDeadline,
  calculateElapsedWorkingMinutes,
  determineTATStatus,
  formatTATDuration,
  formatISTDateTime,
  DEFAULT_PRIORITY_TAT_HOURS,
} from "./tat-engine.js";

const app = express();
const port = Number(process.env.PORT || 3001);
const isProduction = process.env.NODE_ENV === "production";
app.set("trust proxy", isProduction ? 1 : false);
const jwtSecret = process.env.JWT_SECRET;

if (isProduction && (!jwtSecret || Buffer.byteLength(jwtSecret, "utf8") < 32)) {
  throw new Error("JWT_SECRET must be set to at least 32 bytes in production.");
}
if (isProduction) {
  const publicUrl = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!publicUrl) throw new Error("Set APP_BASE_URL to the public HTTPS URL in production.");
  let parsedPublicUrl;
  try { parsedPublicUrl = new URL(publicUrl); } catch {
    throw new Error("APP_BASE_URL must be a valid public HTTPS URL in production.");
  }
  if (parsedPublicUrl.protocol !== "https:") {
    throw new Error("APP_BASE_URL must use HTTPS in production.");
  }
}
const tokenSecret = jwtSecret || "development-only-secret-change-before-deploy";
const attachmentsRoot = resolve(process.env.ATTACHMENTS_PATH || "data/attachments");
const manualsRoot = resolve(attachmentsRoot, "user-manuals");
mkdirSync(attachmentsRoot, { recursive: true });
mkdirSync(manualsRoot, { recursive: true });
const permittedAttachmentTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["application/pdf", ".pdf"],
]);
const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: attachmentsRoot,
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  }),
  limits: { files: 10, fields: 20, parts: 30, fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!isAllowedAttachment(file.originalname)) {
      return callback(new Error(`The file "${file.originalname}" is an executable format and cannot be attached.`), false);
    }
    callback(null, true);
  },
});

async function verifyTicketFiles(files = []) {
  const verifiedFiles = [];
  for (const file of files) {
    if (!isAllowedAttachment(file.originalname)) {
      throw new Error(`The attachment "${file.originalname}" is an executable format and cannot be attached.`);
    }
    let detectedMime = null;
    try {
      const detected = await fileTypeFromFile(file.path);
      detectedMime = detected?.mime;
    } catch {
      // ignore detection failures for non-binary formats
    }
    const mimeType = detectedMime || file.mimetype || "application/octet-stream";
    const originalName = sanitizeAttachmentName(file.originalname);
    verifiedFiles.push({ ...file, originalName, mimeType, size: file.size });
  }
  return verifiedFiles;
}
const permittedManualMediaTypes = new Map([
  ["audio/mpeg", { extension: ".mp3", kind: "audio" }],
  ["audio/mp4", { extension: ".m4a", kind: "audio" }],
  ["audio/wav", { extension: ".wav", kind: "audio" }],
  ["audio/x-wav", { extension: ".wav", kind: "audio" }],
  ["audio/ogg", { extension: ".ogg", kind: "audio" }],
  ["video/mpeg", { extension: ".mpeg", kind: "video" }],
  ["video/mp4", { extension: ".mp4", kind: "video" }],
  ["video/webm", { extension: ".webm", kind: "video" }],
]);
const permittedManualMediaExtensions = new Map([
  ["audio/mpeg", [".mp3", ".mp2", ".mpga"]], ["audio/mp4", [".m4a", ".mp4"]],
  ["audio/wav", [".wav"]], ["audio/x-wav", [".wav"]], ["audio/ogg", [".ogg", ".oga"]],
  ["video/mpeg", [".mpeg", ".mpg", ".mpe", ".mp2v", ".m2v"]],
  ["video/mp4", [".mp4", ".m4v"]], ["video/webm", [".webm"]],
]);
const permittedManualAttachmentTypes = new Map([
  ["image/jpeg", [".jpg", ".jpeg"]], ["image/png", [".png"]], ["image/webp", [".webp"]],
  ["image/gif", [".gif"]], ["image/bmp", [".bmp"]], ["application/pdf", [".pdf"]],
  ["text/csv", [".csv"]], ["application/csv", [".csv"]], ["application/vnd.ms-excel", [".xls", ".csv"]],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", [".xlsx"]],
  ["application/msword", [".doc"]], ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", [".docx"]],
  ["application/vnd.ms-powerpoint", [".ppt"]], ["application/vnd.openxmlformats-officedocument.presentationml.presentation", [".pptx"]],
  ["text/plain", [".txt", ".csv"]], ["application/rtf", [".rtf"]], ["text/rtf", [".rtf"]],
  ["application/vnd.oasis.opendocument.text", [".odt"]],
  ["application/vnd.oasis.opendocument.spreadsheet", [".ods"]],
  ["application/vnd.oasis.opendocument.presentation", [".odp"]],
  ["application/zip", [".zip"]], ["application/x-zip-compressed", [".zip"]],
]);
const manualUpload = multer({
  storage: multer.diskStorage({
    destination: manualsRoot,
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  }),
  limits: { files: 21, fields: 12, parts: 33, fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (["media", "mediaFiles"].includes(file.fieldname)
      && permittedManualMediaTypes.has(file.mimetype)
      && permittedManualMediaExtensions.get(file.mimetype)?.includes(extname(file.originalname).toLowerCase())) {
      return callback(null, true);
    }
    const extensions = permittedManualAttachmentTypes.get(file.mimetype);
    const extension = extname(file.originalname).toLowerCase();
    if (file.fieldname === "attachments" && extensions?.includes(extension)) return callback(null, true);
    callback(new Error(file.fieldname === "media"
      ? "Upload an MP3, M4A, WAV, OGG, MP4, or WebM audio/video file."
      : "This file type is not supported for user guide attachments."), false);
  },
});
const historicalWorkbookUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fields: 1, parts: 2, fileSize: 5 * 1024 * 1024 },
});

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "img-src": ["'self'", "data:", "blob:"],
        "media-src": ["'self'", "data:", "blob:"],
        "frame-src": ["'self'", "data:", "blob:"],
        "script-src": ["'self'", "'unsafe-inline'"],
      },
    },
  })
);
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
    username: user.username,
    email: user.email,
    contactNumber: user.contact_number || null,
    role: user.role,
    isAdmin: Boolean(user.is_admin),
    isCompanyAdmin: Boolean(user.is_company_admin),
    isInternalConsultant: Boolean(user.is_internal_consultant),
    internalRoutingPriority: user.internal_routing_priority || 0,
    companyId: user.company_id || null,
    companyName: user.company_name || null,
    companySupportValidUntil: user.company_support_valid_until || null,
    approvalStatus: user.approval_status || "approved",
  };
}

async function companyMemberships(userId) {
  const rows = await db.prepare(`
    SELECT c.id, c.name, c.support_valid_until AS supportValidUntil,
           c.internal_consultant_id AS internalConsultantId,
           m.is_company_admin AS isCompanyAdmin,
           m.is_internal_consultant AS isInternalConsultant,
           m.internal_routing_priority AS internalRoutingPriority,
           (SELECT COUNT(*) FROM company_memberships cm2
            JOIN users u2 ON u2.id = cm2.user_id
            WHERE cm2.company_id = c.id AND (cm2.is_internal_consultant = 1 OR u2.is_internal_consultant = 1)
              AND u2.role = 'customer' AND u2.approval_status = 'approved' AND u2.disabled_at IS NULL
           ) AS internalConsultantCount
    FROM company_memberships m JOIN companies c ON c.id = m.company_id
    WHERE m.user_id = ? AND c.is_active = 1
    ORDER BY c.name
  `).all(userId);
  return rows.map((row) => ({
    ...row,
    isInternalConsultant: Boolean(row.isInternalConsultant || (row.internalConsultantId && Number(row.internalConsultantId) === Number(userId))),
    internalRoutingPriority: row.internalRoutingPriority || 0,
    hasInternalConsultants: Number(row.internalConsultantCount) > 0 || Boolean(row.internalConsultantId),
  }));
}

function createToken(user, activeCompanyId = user.company_id) {
  const payload = { sub: user.id };
  if (user.role === "customer" && activeCompanyId) payload.companyId = Number(activeCompanyId);
  return jwt.sign(payload, tokenSecret, { expiresIn: "8h" });
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function secureToken() {
  return randomBytes(32).toString("base64url");
}

function validContactNumber(value) {
  if (typeof value !== "string") return null;
  const contactNumber = value.trim();
  const digits = contactNumber.replace(/\D/g, "");
  return /^\+?[0-9][0-9\s().-]{5,19}$/.test(contactNumber) && digits.length >= 7 && digits.length <= 15
    ? contactNumber
    : null;
}

function normalizeUsername(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validUsername(username) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username);
}

function usernameFromEmail(email) {
  const prefix = normalizeUsername(email?.split("@")[0]).replace(/[^a-z0-9._-]/g, "").slice(0, 24) || "user";
  const safePrefix = /^[a-z0-9]/.test(prefix) ? prefix : `u${prefix}`.slice(0, 24);
  return `${safePrefix}-${randomBytes(3).toString("hex")}`;
}

function optionalEmail(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : false;
}

function optionalContactNumber(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return validContactNumber(value) || false;
}

async function clientUsernameExistsInCompany(username, companyId, excludeUserId = null) {
  const excludeSelf = excludeUserId === null ? "" : " AND u.id <> ?";
  const params = [username, companyId, companyId];
  if (excludeUserId !== null) params.push(excludeUserId);
  return Boolean(await db.prepare(`
    SELECT 1 FROM users u
    LEFT JOIN company_memberships m ON m.user_id = u.id
    WHERE u.role = 'customer' AND u.username = ?
      AND (u.company_id = ? OR m.company_id = ?)${excludeSelf}
    LIMIT 1
  `).get(...params));
}

function validDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function supportContractExpired(supportValidUntil) {
  return Boolean(supportValidUntil && new Date().toISOString().slice(0, 10) > String(supportValidUntil).slice(0, 10));
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
    SELECT u.id, u.name, u.username, u.email, u.contact_number, u.role, u.is_admin, u.is_company_admin, u.company_id,
           u.approval_status, c.name AS company_name, c.support_valid_until AS company_support_valid_until
    FROM users u LEFT JOIN companies c ON c.id = u.company_id
    WHERE u.id = ? AND u.disabled_at IS NULL
  `).get(Number(payload.sub));
  if (!user) return res.status(401).json({ error: "Your session is no longer valid." });
  if (user.role === "customer" && user.approval_status !== "approved") {
    return res.status(403).json({ error: "Your company account is awaiting administrator approval." });
  }
  if (user.role === "customer") {
    const activeCompanyId = Number(payload.companyId) || Number(user.company_id);
    const membership = await db.prepare(`
      SELECT c.id, c.name, c.support_valid_until AS supportValidUntil,
             c.internal_consultant_id AS internalConsultantId,
             m.is_company_admin AS isCompanyAdmin,
             m.is_internal_consultant AS isInternalConsultant,
             m.internal_routing_priority AS internalRoutingPriority
      FROM company_memberships m JOIN companies c ON c.id = m.company_id
      WHERE m.user_id = ? AND m.company_id = ? AND c.is_active = 1
    `).get(user.id, activeCompanyId);
    if (!membership) return res.status(403).json({ error: "This account no longer has access to the selected company." });
    user.company_id = membership.id;
    user.company_name = membership.name;
    user.company_support_valid_until = membership.supportValidUntil;
    user.is_company_admin = membership.isCompanyAdmin;
    user.is_internal_consultant = (membership.isInternalConsultant === 1 || Number(membership.internalConsultantId) === Number(user.id)) ? 1 : 0;
    user.internal_routing_priority = membership.internalRoutingPriority || 0;
  } else if (user.role === "agent") {
    const assignedInternal = await db.prepare("SELECT 1 FROM companies WHERE internal_consultant_id = ? AND is_active = 1 LIMIT 1").get(user.id);
    user.is_internal_consultant = assignedInternal ? 1 : 0;
    user.internal_routing_priority = 0;
  }
  req.user = user;
  next();
}

function requireAgent(req, res, next) {
  if (req.user.role === "customer") return res.status(403).json({ error: "Only Consultants can do that." });
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

async function getActiveHolidayDates() {
  const rows = await db.prepare("SELECT holiday_date FROM holidays WHERE is_active = 1").all();
  return rows.map((r) => (typeof r.holiday_date === "string" ? r.holiday_date.slice(0, 10) : new Date(r.holiday_date).toISOString().slice(0, 10)));
}

async function tatConfiguration() {
  const settings = await db.prepare("SELECT key, value FROM workspace_settings WHERE key LIKE 'tat_%'").all();
  const map = Object.fromEntries(settings.map((r) => [r.key, r.value]));
  return {
    startHour: Number(map.tat_working_start_hour) || 8,
    endHour: Number(map.tat_working_end_hour) || 19,
    priorityHours: {
      critical: Number(map.tat_priority_critical_hours) || 2,
      high: Number(map.tat_priority_high_hours) || 4,
      normal: Number(map.tat_priority_medium_hours) || 8,
      medium: Number(map.tat_priority_medium_hours) || 8,
      low: Number(map.tat_priority_low_hours) || 16,
      urgent: Number(map.tat_priority_critical_hours) || 2,
    },
    warningPercent: Number(map.tat_warning_percent) || 80,
    timezone: map.tat_timezone || "Asia/Kolkata",
  };
}

function deadlineFrom(createdAt, hours) {
  return Date.parse(`${createdAt.replace(" ", "T")}Z`) + hours * 60 * 60 * 1000;
}

async function selectRoutingAgent(category) {
  const specialty = category === "Functional" || category === "Technical" ? category.toLowerCase() : null;
  const specialtyFilter = specialty ? "AND (u.specialty = 'both' OR u.specialty = ?)" : "";
  return await db.prepare(`
    SELECT u.id
    FROM users u
    LEFT JOIN tickets t ON t.assignee_id = u.id AND t.status != 'resolved'
    WHERE u.role = 'agent' AND u.disabled_at IS NULL
      ${specialtyFilter}
    GROUP BY u.id, u.routing_priority
    ORDER BY u.routing_priority, COUNT(t.id), u.id
    LIMIT 1
  `).get(...(specialty ? [specialty] : []));
}

async function selectInternalConsultant(companyId, excludeUserId = null) {
  if (!companyId) return null;
  const excludeClause = excludeUserId ? "AND u.id != ?" : "";
  const params = excludeUserId ? [companyId, excludeUserId] : [companyId];
  return await db.prepare(`
    SELECT u.id, u.name, u.email, cm.internal_routing_priority,
           COUNT(t.id) AS active_tickets
    FROM users u
    JOIN company_memberships cm ON cm.user_id = u.id AND cm.company_id = ?
    LEFT JOIN tickets t ON t.assignee_id = u.id AND t.status != 'resolved'
    WHERE u.role = 'customer'
      AND (cm.is_internal_consultant = 1 OR u.is_internal_consultant = 1)
      AND u.approval_status = 'approved'
      AND u.disabled_at IS NULL
      ${excludeClause}
    GROUP BY u.id, u.name, u.email, cm.internal_routing_priority
    ORDER BY COALESCE(NULLIF(cm.internal_routing_priority, 0), 999999) ASC,
             COUNT(t.id) ASC,
             u.id ASC
    LIMIT 1
  `).get(...params);
}

async function companyHasInternalConsultants(companyId) {
  if (!companyId) return false;
  const match = await db.prepare(`
    SELECT 1 FROM companies c
    LEFT JOIN company_memberships cm ON cm.company_id = c.id
    LEFT JOIN users u ON u.id = cm.user_id
    WHERE c.id = ? AND c.is_active = 1 AND (
      (c.internal_consultant_id IS NOT NULL AND c.internal_consultant_id > 0)
      OR
      (cm.is_internal_consultant = 1 AND u.role = 'customer' AND u.approval_status = 'approved' AND u.disabled_at IS NULL)
      OR
      EXISTS (
        SELECT 1 FROM users u2
        WHERE u2.company_id = c.id AND u2.is_internal_consultant = 1
          AND u2.role = 'customer' AND u2.approval_status = 'approved' AND u2.disabled_at IS NULL
      )
    )
    LIMIT 1
  `).get(companyId);
  return Boolean(match);
}

async function normalizeCompanyInternalPriorities(companyId) {
  if (!companyId) return;
  const consultants = await db.prepare(`
    SELECT m.user_id
    FROM company_memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.company_id = ? AND (m.is_internal_consultant = 1 OR u.is_internal_consultant = 1) AND u.disabled_at IS NULL
    ORDER BY COALESCE(NULLIF(m.internal_routing_priority, 0), 999999), m.user_id
  `).all(companyId);

  const updateMembership = db.prepare("UPDATE company_memberships SET internal_routing_priority = ? WHERE user_id = ? AND company_id = ?");
  const updateUser = db.prepare("UPDATE users SET internal_routing_priority = ? WHERE id = ? AND company_id = ?");

  for (const [index, row] of consultants.entries()) {
    const priority = index + 1;
    await updateMembership.run(priority, row.user_id, companyId);
    await updateUser.run(priority, row.user_id, companyId);
  }
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
  const access = ticketAccessFilter(user, ticketId);
  return Boolean(await db.prepare(`SELECT 1 FROM tickets WHERE ${access.sql}`).get(...access.params));
}

async function ticketSummary(row) {
  const sla = await slaConfiguration();
  const firstResponseDueAt = new Date(deadlineFrom(row.created_at, sla.firstResponseHours)).toISOString();
  const resolutionDueAt = new Date(deadlineFrom(row.created_at, sla.resolutionHours)).toISOString();
  const resolvedByInternalConsultant = Boolean(
    row.status === "resolved" && row.resolved_by && (
      row.resolved_by_is_internal_consultant === 1 ||
      (row.company_internal_consultant_id && Number(row.resolved_by) === Number(row.company_internal_consultant_id)) ||
      row.resolved_by_role === "customer"
    )
  );
  const ticketNumber = formatCompanyTicketNumber({
    companyId: row.company_id,
    companyName: row.company_name,
    adminUsername: row.company_admin_username,
    companyTicketSeq: row.company_ticket_seq,
    ticketId: row.id,
  });
  return {
    id: row.id,
    ticketNumber,
    companyTicketSeq: row.company_ticket_seq || null,
    subject: row.subject,
    description: row.description,
    status: row.status,
    priority: row.priority,
    source: row.source,
    isHistoricalImport: Boolean(row.import_key),
    isManualEntry: Boolean(parseJsonObject(row.custom_fields_json).manualEntry),
    solution: row.historical_solution || null,
    solutionConsultantName: row.historical_consultant_name || null,
    category: row.import_key ? "" : row.category || "Other",
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
    customer: row.customer_id || row.reported_client_name || row.reported_client_contact ? {
      id: row.customer_id || null,
      name: row.customer_name || row.reported_client_name || "",
      email: row.customer_email || "",
      contactNumber: row.customer_contact_number || row.reported_client_contact || null,
    } : { id: null, name: "", email: "", contactNumber: null },
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name, email: row.assignee_email, contactNumber: row.assignee_contact_number || null, role: row.assignee_role } : null,
    resolvedBy: row.resolved_by ? {
      id: row.resolved_by,
      name: row.resolved_by_name || (resolvedByInternalConsultant ? "Internal Consultant" : "Consultant"),
      role: row.resolved_by_role,
      isInternalConsultant: resolvedByInternalConsultant,
    } : null,
    resolvedByInternalConsultant,
    messageCount: row.message_count,
    lastMessage: row.last_message || row.description,
    firstResponseDueAt,
    resolutionDueAt,
    firstResponseAt: row.first_response_at,
    isFirstResponseOverdue: !row.first_response_at && row.status !== "resolved" && Date.now() > Date.parse(firstResponseDueAt),
    isResolutionOverdue: row.status !== "resolved" && Date.now() > Date.parse(resolutionDueAt),
    attachmentCount: row.attachment_count || 0,
    resolvedAt: row.resolved_at || null,
    tatStartAt: row.tat_start_at || null,
    tatDurationMinutes: row.tat_duration_minutes != null ? Number(row.tat_duration_minutes) : null,
    tatDueAt: row.tat_due_at || null,
    tatElapsedMinutes: row.tat_elapsed_minutes != null ? Number(row.tat_elapsed_minutes) : null,
    tatRemainingMinutes: row.tat_remaining_minutes != null ? Number(row.tat_remaining_minutes) : null,
    tatStatus: row.tat_status || null,
    tatPausedAt: row.tat_paused_at || null,
    tatTotalPausedMinutes: row.tat_total_paused_minutes != null ? Number(row.tat_total_paused_minutes) : 0,
    tatBreachedAt: row.tat_breached_at || null,
  };
}

const ticketSelect = `
  SELECT t.*, c.name AS customer_name, c.email AS customer_email, c.contact_number AS customer_contact_number,
         co.name AS company_name, co.internal_consultant_id AS company_internal_consultant_id,
         a.id AS assignee_id, a.name AS assignee_name, a.email AS assignee_email, a.contact_number AS assignee_contact_number,
         a.role AS assignee_role,
         res.id AS resolved_by_id, res.name AS resolved_by_name, res.role AS resolved_by_role,
         res_cm.is_internal_consultant AS resolved_by_is_internal_consultant,
         (
           SELECT u.username FROM users u
           JOIN company_memberships cm ON cm.user_id = u.id
           WHERE cm.company_id = t.company_id AND cm.is_company_admin = 1
           ORDER BY u.id ASC LIMIT 1
         ) AS company_admin_username,
         (SELECT COUNT(*) FROM messages m WHERE m.ticket_id = t.id AND m.is_internal = 0) AS message_count,
         (SELECT COUNT(*) FROM ticket_attachments x WHERE x.ticket_id = t.id) AS attachment_count,
         (SELECT body FROM messages m WHERE m.ticket_id = t.id AND m.is_internal = 0 ORDER BY m.id DESC LIMIT 1) AS last_message,
         r.rating, r.comment AS rating_comment, r.created_at AS rating_created_at,
         r.customer_id AS rating_customer_id
  FROM tickets t
  LEFT JOIN users c ON c.id = t.customer_id
  LEFT JOIN companies co ON co.id = t.company_id
  LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN users res ON res.id = t.resolved_by
  LEFT JOIN company_memberships res_cm ON res_cm.user_id = res.id AND res_cm.company_id = t.company_id
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

app.get("/api/health", async (_req, res) => {
  try {
    await db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const portal = req.body.portal;
  if (!username || !password) return res.status(400).json({ error: "Enter your username and password." });
  if (portal !== "agent" && portal !== "customer") return res.status(400).json({ error: "Choose the correct portal." });

  let user;
  if (portal === "customer") {
    const candidates = await db.prepare(`
      SELECT u.*, active_company.id AS active_company_id,
             active_company.name AS company_name,
             active_company.support_valid_until AS company_support_valid_until,
             COALESCE(active_company.is_company_admin, u.is_company_admin) AS current_company_admin
      FROM users u
      JOIN LATERAL (
        SELECT c.id, c.name, c.support_valid_until, m.is_company_admin
        FROM company_memberships m JOIN companies c ON c.id = m.company_id
        WHERE m.user_id = u.id AND c.is_active = 1
        ORDER BY (m.company_id = u.company_id) DESC, c.name, c.id
        LIMIT 1
      ) active_company ON TRUE
      WHERE u.username = ? AND u.role = 'customer' AND u.disabled_at IS NULL
      ORDER BY u.id
    `).all(username);
    const matchingUsers = candidates.filter((candidate) => bcrypt.compareSync(password, candidate.password_hash));
    if (matchingUsers.length > 1) {
      return res.status(409).json({ error: "This username and password match accounts in multiple companies. Ask an administrator to set a different password for one account." });
    }
    user = matchingUsers[0];
  } else {
    user = await db.prepare(`
      SELECT u.*, NULL AS company_name, NULL AS company_support_valid_until,
             0 AS current_company_admin
      FROM users u
      WHERE u.username = ? AND u.role = 'agent' AND u.disabled_at IS NULL
    `).get(username);
  }
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Username or password is incorrect." });
  }
  if (user.role === "customer" && user.approval_status !== "approved") {
    return res.status(403).json({ error: "Your company account is awaiting administrator approval." });
  }
  if (user.role === "customer") {
    user.is_company_admin = user.current_company_admin;
    user.company_id = Number(user.active_company_id);
  }

  const companies = user.role === "customer" ? await companyMemberships(user.id) : [];
  if (user.role === "customer" && !companies.some((company) => company.id === user.company_id)) {
    return res.status(403).json({ error: "This client account is not linked to an active company." });
  }
  res.cookie("relay_session", createToken(user, user.company_id), {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
  });
  const hasInternal = user.role === "customer" && user.company_id
    ? await companyHasInternalConsultants(user.company_id)
    : false;
  res.json({ user: publicUser(user), companies, companyHasInternalConsultants: hasInternal });
});

app.get("/api/companies/available", async (_req, res) => {
  const companies = await db.prepare("SELECT id, name FROM companies WHERE is_active = 1 ORDER BY name").all();
  res.json({ companies });
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const username = normalizeUsername(req.body.username);
  const email = optionalEmail(req.body.email);
  const contactNumber = optionalContactNumber(req.body.contactNumber);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const joinCode = typeof req.body.joinCode === "string" ? req.body.joinCode.trim() : "";
  const requestedCompanyId = Number(req.body.companyId);
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Name must be between 2 and 100 characters." });
  if (!validUsername(username)) return res.status(400).json({ error: "Username must be 3–32 characters and use letters, numbers, dots, underscores, or hyphens." });
  if (email === false) return res.status(400).json({ error: "Enter a valid email address or leave it blank." });
  if (!contactNumber) return res.status(400).json({ error: "Enter a valid mobile number (7 to 15 digits)." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Password must be between 8 and 128 characters." });

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

  const isInternalConsultant = Boolean(req.body.isInternalConsultant);

  if (await clientUsernameExistsInCompany(username, company.id)) {
    return res.status(409).json({ error: "That username is already in use in this company." });
  }

  try {
    let internalRoutingPriority = 0;
    if (isInternalConsultant) {
      const maxPri = (await db.prepare("SELECT COALESCE(MAX(internal_routing_priority), 0) AS max_pri FROM company_memberships WHERE company_id = ? AND is_internal_consultant = 1").get(company.id))?.max_pri || 0;
      internalRoutingPriority = maxPri + 1;
    }
    const id = Number((await db.prepare(`
      INSERT INTO users (name, username, email, contact_number, password_hash, role, company_id, approval_status, is_internal_consultant, internal_routing_priority)
      VALUES (?, ?, ?, ?, ?, 'customer', ?, ?, ?, ?)
    `).run(name, username, email, contactNumber, bcrypt.hashSync(password, 12), company.id, approvalStatus, isInternalConsultant ? 1 : 0, internalRoutingPriority)).lastInsertRowid);
    await db.prepare("INSERT INTO company_memberships (user_id, company_id, is_company_admin, is_internal_consultant, internal_routing_priority) VALUES (?, ?, 0, ?, ?) ON CONFLICT DO NOTHING")
      .run(id, company.id, isInternalConsultant ? 1 : 0, internalRoutingPriority);
    if (approvalStatus === "pending") {
      await db.prepare(`
        INSERT INTO notifications (user_id, ticket_id, kind, message)
        SELECT u.id, NULL, ?, ? FROM users u
        JOIN company_memberships m ON m.user_id = u.id
        WHERE u.role = 'customer' AND m.is_company_admin = 1 AND m.company_id = ? AND u.approval_status = 'approved'
      `).run(`company_join_request:${id}`, `${name} (${username}) requested access to ${company.name}.`, company.id);
      return res.status(202).json({
        pendingApproval: true,
        message: `Your account for ${company.name} is waiting for a company administrator to approve it.`,
      });
    }
    const user = await db.prepare(`
      SELECT u.id, u.name, u.username, u.email, u.contact_number, u.role, u.is_admin, u.is_company_admin, u.company_id,
             u.approval_status, c.name AS company_name, c.support_valid_until AS company_support_valid_until
      FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?
    `).get(id);
    res.cookie("relay_session", createToken(user, user.company_id), {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    });
    return res.status(201).json({ user: publicUser(user), companies: await companyMemberships(user.id) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That username or email address is already in use." });
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
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: "Password must be between 8 and 128 characters." });
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
    SELECT email, specialty FROM agent_invitations
    WHERE token_hash = ? AND accepted_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP
  `).get(hashToken(token));
  if (!invitation) return res.status(400).json({ error: "This invitation link is invalid or expired. Ask an administrator for a new invitation." });
  res.json({ email: invitation.email });
});

app.post("/api/auth/agent-invitations/accept", async (req, res) => {
  const token = typeof req.body.token === "string" ? req.body.token : "";
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const contactNumber = validContactNumber(req.body.contactNumber);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Name must be between 2 and 100 characters." });
  if (!contactNumber) return res.status(400).json({ error: "Enter a valid contact number (7 to 15 digits)." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Password must be between 8 and 128 characters." });
  const tokenHash = hashToken(token);
  const invitation = await db.prepare(`
    SELECT id, email, specialty FROM agent_invitations
    WHERE token_hash = ? AND accepted_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP
  `).get(tokenHash);
  if (!invitation) return res.status(400).json({ error: "This invitation link is invalid or expired. Ask an administrator for a new invitation." });

  let userId;
  try {
    const accept = db.transaction(async () => {
      const nextPriority = (await db.prepare("SELECT COALESCE(MAX(routing_priority), 0) + 1 AS priority FROM users WHERE role = 'agent' AND disabled_at IS NULL").get()).priority;
      const user = await db.prepare("INSERT INTO users (name, username, email, contact_number, password_hash, role, routing_priority, specialty) VALUES (?, ?, ?, ?, ?, 'agent', ?, ?)")
        .run(name, usernameFromEmail(invitation.email), invitation.email, contactNumber, bcrypt.hashSync(password, 12), nextPriority, invitation.specialty);
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
  const user = await db.prepare("SELECT id, name, username, email, contact_number, role, is_admin FROM users WHERE id = ?").get(userId);
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
  const contactNumber = validContactNumber(req.body.contactNumber);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Name must be between 2 and 100 characters." });
  if (!contactNumber) return res.status(400).json({ error: "Enter a valid contact number (7 to 15 digits)." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Password must be between 8 and 128 characters." });
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
        INSERT INTO users (name, username, email, contact_number, password_hash, role, company_id, is_company_admin)
        VALUES (?, ?, ?, ?, ?, 'customer', ?, ?)
      `).run(name, usernameFromEmail(invitation.email), invitation.email, contactNumber, bcrypt.hashSync(password, 12), invitation.company_id, invitation.is_company_admin);
      await db.prepare("INSERT INTO company_memberships (user_id, company_id, is_company_admin) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
        .run(user.lastInsertRowid, invitation.company_id, invitation.is_company_admin);
      const updated = await db.prepare("UPDATE client_invitations SET accepted_at = CURRENT_TIMESTAMP WHERE id = ? AND accepted_at IS NULL")
        .run(invitation.id);
      if (updated.changes !== 1) throw new Error("Company invitation has already been accepted.");
      return Number(user.lastInsertRowid);
    });
    const userId = await accept();
    const user = await db.prepare(`
      SELECT u.id, u.name, u.username, u.email, u.contact_number, u.role, u.is_admin, u.is_company_admin, u.company_id,
             u.approval_status, c.name AS company_name, c.support_valid_until AS company_support_valid_until
      FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?
    `).get(userId);
    res.cookie("relay_session", createToken(user, user.company_id), {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    });
    return res.status(201).json({ user: publicUser(user), companies: await companyMemberships(user.id) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "An account with this email already exists." });
    if (error.message === "Company invitation has already been accepted.") return res.status(400).json({ error: "This company invitation has already been used." });
    throw error;
  }
});

app.post("/api/agent-invitations", requireAuth, requireAdmin, async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const specialty = req.body.specialty;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Enter a valid Consultant email address." });
  }
  if (!["functional", "technical", "both"].includes(specialty)) {
    return res.status(400).json({ error: "Choose Functional, Technical, or Both for the Consultant specialty." });
  }
  if (await db.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").get(email)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }
  if (await db.prepare("SELECT 1 FROM agent_invitations WHERE email = ? COLLATE NOCASE AND accepted_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP").get(email)) {
    return res.status(409).json({ error: "A valid invitation has already been sent to this email address." });
  }
  const token = secureToken();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const result = await db.prepare(`
    INSERT INTO agent_invitations (email, specialty, token_hash, invited_by, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(email, specialty, hashToken(token), req.user.id, expiresAt);
  const invitationUrl = applicationUrl(`/invite?token=${encodeURIComponent(token)}`);
  if (emailIsConfigured()) {
    try {
      await sendEmail({
        to: email,
        subject: "You are invited to the Jishnu Infotech Consultant portal",
        text: `You have been invited to join the Jishnu Infotech support team. Accept your invitation within 48 hours:\n${invitationUrl}`,
      });
    } catch (error) {
      await db.prepare("DELETE FROM agent_invitations WHERE id = ?").run(result.lastInsertRowid);
      console.error("Consultant invitation email delivery failed:", error.message);
      return res.status(503).json({ error: "Could not send the Consultant invitation email. Please check SMTP settings and try again." });
    }
  }
  res.status(201).json({
    invitation: {
      email,
      expiresAt,
      emailSent: emailIsConfigured(),
      ...(!emailIsConfigured() ? { invitationUrl } : {}),
    },
  });
});

app.get("/api/agent-invitations", requireAuth, requireAdmin, async (_req, res) => {
  const invitations = await db.prepare(`
    SELECT i.id, i.email, i.specialty, i.expires_at AS expiresAt, i.accepted_at AS acceptedAt, i.created_at AS createdAt,
           u.name AS invitedBy
    FROM agent_invitations i JOIN users u ON u.id = i.invited_by
    WHERE i.accepted_at IS NULL AND datetime(i.expires_at) > CURRENT_TIMESTAMP
    ORDER BY i.created_at DESC
  `).all();
  res.json({ invitations });
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const hasInternal = req.user.role === "customer" && req.user.company_id
    ? await companyHasInternalConsultants(req.user.company_id)
    : false;

  res.json({
    user: publicUser(req.user),
    companies: req.user.role === "customer" ? await companyMemberships(req.user.id) : [],
    companyHasInternalConsultants: hasInternal,
  });
});

app.get("/api/tickets/routing-options", requireAuth, async (req, res) => {
  const companyId = req.user.role === "customer" ? req.user.company_id : Number(req.query.companyId);
  const hasInternal = await companyHasInternalConsultants(companyId);
  res.json({ companyHasInternalConsultants: hasInternal });
});

app.post("/api/auth/select-company", requireAuth, async (req, res) => {
  if (req.user.role !== "customer") return res.status(403).json({ error: "Company selection is only available to client accounts." });
  const companyId = Number(req.body.companyId);
  if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error: "Choose a valid company." });
  const membership = await db.prepare(`
    SELECT c.id, c.name, c.support_valid_until AS supportValidUntil,
           m.is_company_admin AS isCompanyAdmin
    FROM company_memberships m JOIN companies c ON c.id = m.company_id
    WHERE m.user_id = ? AND m.company_id = ? AND c.is_active = 1
  `).get(req.user.id, companyId);
  if (!membership) return res.status(403).json({ error: "This account does not have access to that company." });
  const activeUser = {
    ...req.user,
    company_id: membership.id,
    company_name: membership.name,
    company_support_valid_until: membership.supportValidUntil,
    is_company_admin: membership.isCompanyAdmin,
  };
  res.cookie("relay_session", createToken(activeUser, membership.id), {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000,
  });
  const hasInternal = await companyHasInternalConsultants(membership.id);
  res.json({
    user: publicUser(activeUser),
    companies: await companyMemberships(req.user.id),
    companyHasInternalConsultants: hasInternal,
  });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("relay_session", { httpOnly: true, secure: isProduction, sameSite: "lax" });
  res.status(204).end();
});

app.get("/api/tickets", requireAuth, async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  const rows = req.user.role === "agent"
    ? await db.prepare(`${ticketSelect} ORDER BY
        CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        t.updated_at DESC`).all()
    : req.user.company_id
      ? await db.prepare(`${ticketSelect} WHERE t.company_id = ? ORDER BY t.updated_at DESC`).all(req.user.company_id)
      : await db.prepare(`${ticketSelect} WHERE t.customer_id = ? ORDER BY t.updated_at DESC`).all(req.user.id);
  res.json({ tickets: await Promise.all(rows.map(ticketSummary)) });
});

app.get("/api/reports", requireAuth, async (req, res) => {
  const access = reportAccess(req.user);
  const isWorkspaceAdmin = access.workspaceWide;
  if (!access.allowed) {
    return res.status(403).json({ error: "Reports are available to the Super Admin and company administrators." });
  }
  let scopeCompanyId = access.companyId;
  let scopeCompanyName = null;
  if (req.query.companyId !== undefined) {
    if (!isWorkspaceAdmin) return res.status(403).json({ error: "Only the Super Admin can select a client company." });
    const requestedCompanyId = Number(req.query.companyId);
    if (!Number.isInteger(requestedCompanyId) || requestedCompanyId < 1) {
      return res.status(400).json({ error: "Choose a valid client company." });
    }
    const company = await db.prepare("SELECT id, name FROM companies WHERE id = ?").get(requestedCompanyId);
    if (!company) return res.status(404).json({ error: "Client company not found." });
    scopeCompanyId = Number(company.id);
    scopeCompanyName = company.name;
  }
  const days = Number(req.query.days ?? 30);
  if (![7, 30, 90].includes(days)) return res.status(400).json({ error: "Choose a report period of 7, 30, or 90 days." });

  const today = new Date();
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const startAt = new Date(end - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + " 00:00:00";
  const endAt = new Date(end + 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + " 00:00:00";
  const isAllCompaniesScope = scopeCompanyId === null;
  const scopeClause = isAllCompaniesScope ? "1 = 1" : "company_id = ?";
  const scopeParams = isAllCompaniesScope ? [] : [scopeCompanyId];
  const createdRangeClause = `${scopeClause} AND created_at >= ? AND created_at < ?`;
  const createdRangeParams = [...scopeParams, startAt, endAt];
  const activeBacklog = (await db.prepare(`SELECT COUNT(*) AS count FROM tickets WHERE ${scopeClause} AND status != 'resolved'`)
    .get(...scopeParams)).count;
  const waitingTickets = (await db.prepare(`SELECT COUNT(*) AS count FROM tickets WHERE ${scopeClause} AND status = 'waiting'`)
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
    FROM tickets WHERE ${createdRangeClause} GROUP BY 1
  `).all(...createdRangeParams);
  const resolvedByDay = await db.prepare(`
    SELECT substr(resolved_at, 1, 10) AS day, COUNT(*) AS count
    FROM tickets WHERE ${scopeClause} AND resolved_at >= ? AND resolved_at < ?
    GROUP BY 1
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
      AND ${isAllCompaniesScope ? "1 = 1" : "t.company_id = ?"}
    LEFT JOIN ticket_assignment_history h ON h.agent_id = u.id
      AND ${isAllCompaniesScope ? "1 = 1" : "EXISTS (SELECT 1 FROM tickets scoped WHERE scoped.id = h.ticket_id AND scoped.company_id = ?)"}
    WHERE u.role = 'agent' AND u.disabled_at IS NULL
    GROUP BY u.id, u.name, u.routing_priority ORDER BY u.routing_priority, active, u.id
  `).all(
    startAt, endAt, startAt, endAt,
    ...(isAllCompaniesScope ? [] : [scopeCompanyId, scopeCompanyId]),
  );
  const customerActivity = req.user.role === "customer" || req.user.is_admin
    ? await db.prepare(`
        SELECT u.id, u.name, u.email, c.name AS companyName,
               COUNT(DISTINCT CASE WHEN t.created_at >= ? AND t.created_at < ? THEN t.id END) AS raisedInPeriod,
               COUNT(DISTINCT CASE WHEN t.status != 'resolved' THEN t.id END) AS active,
               COUNT(DISTINCT CASE WHEN t.status = 'in_progress' THEN t.id END) AS inProgress,
               COUNT(DISTINCT CASE WHEN t.resolved_at >= ? AND t.resolved_at < ? THEN t.id END) AS resolvedInPeriod
        FROM users u
        JOIN company_memberships m ON m.user_id = u.id
        JOIN companies c ON c.id = m.company_id
        LEFT JOIN tickets t ON t.customer_id = u.id AND t.company_id = m.company_id
          AND ${isAllCompaniesScope ? "1 = 1" : "t.company_id = ?"}
        WHERE u.role = 'customer' AND u.approval_status = 'approved'
          AND c.is_active = 1
          AND ${isAllCompaniesScope ? "1 = 1" : "m.company_id = ?"}
        GROUP BY u.id, u.name, u.email, c.name ORDER BY 5 DESC, u.name
      `).all(
        startAt, endAt, startAt, endAt,
        ...(isAllCompaniesScope ? [] : [scopeCompanyId, scopeCompanyId]),
      )
    : [];
  const companyVolume = isWorkspaceAdmin && isAllCompaniesScope ? await db.prepare(`
    SELECT c.name, COUNT(t.id) AS count FROM tickets t
    JOIN companies c ON c.id = t.company_id
    WHERE t.created_at >= ? AND t.created_at < ?
    GROUP BY c.id, c.name ORDER BY count DESC, c.name LIMIT 8
  `).all(startAt, endAt) : [];

  const solvedByInternalRow = await db.prepare(`
    SELECT 
      COUNT(DISTINCT CASE WHEN (
        res_cm.is_internal_consultant = 1 OR
        res.role = 'customer' OR
        (co.internal_consultant_id IS NOT NULL AND t.resolved_by = co.internal_consultant_id)
      ) THEN t.id END) AS solvedByInternal,
      COUNT(DISTINCT CASE WHEN (
        res.role = 'agent' AND (co.internal_consultant_id IS NULL OR t.resolved_by != co.internal_consultant_id)
      ) THEN t.id END) AS solvedByExternal
    FROM tickets t
    LEFT JOIN companies co ON co.id = t.company_id
    LEFT JOIN users res ON res.id = t.resolved_by
    LEFT JOIN company_memberships res_cm ON res_cm.user_id = t.resolved_by AND res_cm.company_id = t.company_id
    WHERE ${isAllCompaniesScope ? "1 = 1" : "t.company_id = ?"} AND t.status = 'resolved' AND t.resolved_at >= ? AND t.resolved_at < ?
  `).get(...scopeParams, startAt, endAt);

  const internalConsultantWorkload = await db.prepare(`
    SELECT u.id, u.name, u.email, c.name AS companyName,
           m.internal_routing_priority AS routingPriority,
           COUNT(DISTINCT CASE WHEN t.status != 'resolved' AND t.assignee_id = u.id THEN t.id END) AS active,
           COUNT(DISTINCT CASE WHEN t.resolved_by = u.id AND t.resolved_at >= ? AND t.resolved_at < ? THEN t.id END) AS resolvedInPeriod
    FROM users u
    JOIN company_memberships m ON m.user_id = u.id AND (m.is_internal_consultant = 1 OR u.is_internal_consultant = 1)
    JOIN companies c ON c.id = m.company_id
    LEFT JOIN tickets t ON (t.assignee_id = u.id OR t.resolved_by = u.id)
      AND ${isAllCompaniesScope ? "1 = 1" : "t.company_id = ?"}
    WHERE u.role = 'customer' AND u.disabled_at IS NULL
      AND ${isAllCompaniesScope ? "1 = 1" : "m.company_id = ?"}
    GROUP BY u.id, u.name, u.email, c.name, m.internal_routing_priority
    ORDER BY 7 DESC, m.internal_routing_priority ASC, u.name
  `).all(
    startAt, endAt,
    ...(isAllCompaniesScope ? [] : [scopeCompanyId, scopeCompanyId]),
  );

  const scopeCompany = scopeCompanyId === null
    ? null
    : { id: scopeCompanyId, name: scopeCompanyName || (await db.prepare("SELECT name FROM companies WHERE id = ?").get(scopeCompanyId))?.name || "Company" };

  res.json({
    days,
    startDate: startAt.slice(0, 10),
    endDate: new Date(end).toISOString().slice(0, 10),
    scopeCompany,
    summary: { created: totals.created || 0, activeInPeriod: totals.active || 0, activeBacklog, waiting: waitingTickets || 0 },
    solvedByInternal: Number(solvedByInternalRow?.solvedByInternal || 0),
    solvedByExternal: Number(solvedByInternalRow?.solvedByExternal || 0),
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
    internalConsultantWorkload,
    companyVolume,
    customerActivity,
  });
});

app.get("/api/report-tickets", requireAuth, async (req, res) => {
  const access = reportAccess(req.user);
  if (!access.allowed) return res.status(403).json({ error: "Reports are available to the Super Admin and company administrators." });
  let scopeCompanyId = access.companyId;
  if (req.query.companyId !== undefined) {
    if (!access.workspaceWide) return res.status(403).json({ error: "Only the Super Admin can select a client company." });
    const requestedCompanyId = Number(req.query.companyId);
    if (!Number.isInteger(requestedCompanyId) || requestedCompanyId < 1) return res.status(400).json({ error: "Choose a valid client company." });
    const company = await db.prepare("SELECT id FROM companies WHERE id = ?").get(requestedCompanyId);
    if (!company) return res.status(404).json({ error: "Client company not found." });
    scopeCompanyId = Number(company.id);
  }

  const filters = [];
  const params = [];
  if (scopeCompanyId !== null) {
    filters.push("t.company_id = ?");
    params.push(scopeCompanyId);
  }
  const customerId = req.query.customerId === undefined || req.query.customerId === "" ? null : Number(req.query.customerId);
  const consultantId = req.query.consultantId === undefined || req.query.consultantId === "" ? null : Number(req.query.consultantId);
  if (customerId !== null) {
    if (!Number.isInteger(customerId) || customerId < 1) return res.status(400).json({ error: "Choose a valid client user." });
    filters.push("t.customer_id = ?");
    params.push(customerId);
  }
  if (consultantId !== null) {
    if (!Number.isInteger(consultantId) || consultantId < 1) return res.status(400).json({ error: "Choose a valid Consultant." });
    filters.push("t.assignee_id = ?");
    params.push(consultantId);
  }
  const dateFrom = typeof req.query.dateFrom === "string" && req.query.dateFrom ? req.query.dateFrom : null;
  const dateTo = typeof req.query.dateTo === "string" && req.query.dateTo ? req.query.dateTo : null;
  const month = typeof req.query.month === "string" && req.query.month ? req.query.month : null;
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: "Choose a valid month." });
    const [year, monthNumber] = month.split("-").map(Number);
    const from = `${month}-01 00:00:00`;
    const next = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10) + " 00:00:00";
    filters.push("t.created_at >= ? AND t.created_at < ?");
    params.push(from, next);
  } else {
    if (dateFrom && !validDate(dateFrom)) return res.status(400).json({ error: "Choose a valid start date." });
    if (dateTo && !validDate(dateTo)) return res.status(400).json({ error: "Choose a valid end date." });
    if (dateFrom && dateTo && dateFrom > dateTo) return res.status(400).json({ error: "Start date must be before or equal to end date." });
    if (dateFrom) {
      filters.push("t.created_at >= ?");
      params.push(`${dateFrom} 00:00:00`);
    }
    if (dateTo) {
      const nextDay = new Date(Date.parse(`${dateTo}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      filters.push("t.created_at < ?");
      params.push(`${nextDay} 00:00:00`);
    }
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const requestedPage = Number(req.query.page ?? 1);
  if (!Number.isInteger(requestedPage) || requestedPage < 1) return res.status(400).json({ error: "Choose a valid ticket page." });
  const pageSize = 50;
  const total = Number((await db.prepare(`SELECT COUNT(*) AS count FROM tickets t ${where}`).get(...params)).count);
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  const tickets = await db.prepare(`
    SELECT t.id, t.subject, t.status, t.priority, t.updated_at AS updatedAt,
           t.company_id AS companyId, t.customer_id AS customerId, t.assignee_id AS consultantId,
           co.name AS companyName, COALESCE(NULLIF(t.reported_client_name, ''), customer.name, '') AS customerName,
           consultant.name AS consultantName,
           t.company_ticket_seq AS companyTicketSeq,
           (
             SELECT u.username FROM users u
             JOIN company_memberships cm ON cm.user_id = u.id
             WHERE cm.company_id = t.company_id AND cm.is_company_admin = 1
             ORDER BY u.id ASC LIMIT 1
           ) AS companyAdminUsername
    FROM tickets t
    LEFT JOIN users customer ON customer.id = t.customer_id
    LEFT JOIN companies co ON co.id = t.company_id
    LEFT JOIN users consultant ON consultant.id = t.assignee_id
    ${where}
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);
  const formattedTickets = tickets.map((t) => ({
    ...t,
    ticketNumber: formatCompanyTicketNumber({
      companyId: t.companyId,
      companyName: t.companyName,
      adminUsername: t.companyAdminUsername,
      companyTicketSeq: t.companyTicketSeq,
      ticketId: t.id,
    }),
  }));
  const [companies, customers, consultants] = await Promise.all([
    access.workspaceWide
      ? db.prepare("SELECT id, name FROM companies ORDER BY name").all()
      : Promise.resolve([]),
    db.prepare(`
      SELECT u.id, u.name, u.email, c.name AS companyName
      FROM users u JOIN company_memberships m ON m.user_id = u.id JOIN companies c ON c.id = m.company_id
      WHERE u.role = 'customer' AND u.approval_status = 'approved'
        ${scopeCompanyId === null ? "" : "AND m.company_id = ?"}
      ORDER BY c.name, u.name
    `).all(...(scopeCompanyId === null ? [] : [scopeCompanyId])),
    db.prepare("SELECT id, name FROM users WHERE role = 'agent' ORDER BY name, id").all(),
  ]);
  res.json({ tickets: formattedTickets, total, page, pageSize, companies, customers, consultants });
});

app.get("/api/reports/company-pdf-data", requireAuth, requireAgent, async (req, res) => {
  const companies = await db.prepare("SELECT id, name FROM companies WHERE is_active = 1 ORDER BY name ASC").all();
  if (companies.length === 0) {
    return res.json({ companies: [], report: null });
  }

  const requestedCompanyId = req.query.companyId ? Number(req.query.companyId) : null;
  const targetCompanyId = (requestedCompanyId && Number.isInteger(requestedCompanyId))
    ? requestedCompanyId
    : Number(companies[0].id);

  const company = await db.prepare("SELECT id, name FROM companies WHERE id = ?").get(targetCompanyId);
  if (!company) {
    return res.status(404).json({ error: "Company not found." });
  }

  const adminUser = await db.prepare(`
    SELECT u.username FROM users u
    JOIN company_memberships cm ON cm.user_id = u.id
    WHERE cm.company_id = ? AND cm.is_company_admin = 1
    ORDER BY u.id ASC LIMIT 1
  `).get(company.id);

  const period = typeof req.query.period === "string" ? req.query.period : "weekly";
  const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom : null;
  const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo : null;

  const range = calculateReportDateRange(period, dateFrom, dateTo);
  const holidays = await getActiveHolidayDates();

  // Note: Only tickets raised within this period itself (created_at >= startAt AND created_at <= endAt)
  // are included with their status (solved or not).
  const ticketRows = await db.prepare(`
    SELECT t.id, t.subject, t.description, t.status, t.priority, t.created_at, t.company_ticket_seq,
           t.resolved_at, t.tat_start_at, t.tat_duration_minutes, t.tat_due_at, t.tat_elapsed_minutes,
           t.tat_status, t.tat_total_paused_minutes,
           COALESCE(NULLIF(t.reported_client_name, ''), customer.name, 'Unknown Client') AS client_name,
           customer.id AS client_id
    FROM tickets t
    LEFT JOIN users customer ON customer.id = t.customer_id
    WHERE t.company_id = ? AND t.created_at >= ? AND t.created_at <= ?
    ORDER BY t.created_at ASC, t.id ASC
  `).all(company.id, range.startAt, range.endAt);

  const report = aggregateCompanyReport({
    company,
    adminUsername: adminUser?.username || null,
    tickets: ticketRows,
    period: range.period,
    startDate: range.startDate,
    endDate: range.endDate,
    holidays,
  });

  res.json({ companies, report });
});

app.get("/api/customers", requireAuth, requireAgent, async (_req, res) => {
  const customers = await db.prepare(`
    SELECT u.id, u.name, u.username, u.email, m.company_id AS companyId, c.name AS companyName
    FROM users u JOIN company_memberships m ON m.user_id = u.id JOIN companies c ON c.id = m.company_id
    WHERE u.role = 'customer' AND u.approval_status = 'approved' AND u.disabled_at IS NULL
    ORDER BY c.name, u.name
  `).all();
  res.json({ customers });
});

async function userManualList(user) {
  const isSuperAdmin = user.role === "agent" && user.is_admin;
  const visibility = isSuperAdmin ? "" : `WHERE m.is_published = 1 AND (
    m.audience_type = 'all'
    OR (m.audience_type = 'user' AND (m.audience_user_id = ? OR EXISTS (
      SELECT 1 FROM user_manual_recipients mr WHERE mr.manual_id = m.id AND mr.user_id = ?
    )))
    OR (m.audience_type = 'company' AND ? = 'customer' AND EXISTS (
      SELECT 1 FROM company_memberships cm WHERE cm.user_id = ? AND cm.company_id = m.audience_company_id
    ))
  )`;
  return db.prepare(`
    SELECT m.id, m.title, m.summary, m.content, m.media_kind AS mediaKind,
           m.original_name AS mediaName, m.mime_type AS mediaMimeType, m.size_bytes AS mediaSizeBytes,
           m.is_published AS isPublished, m.audience_type AS audienceType,
           m.audience_company_id AS audienceCompanyId, c.name AS audienceCompanyName,
           m.audience_user_id AS audienceUserId, u.name AS audienceUserName,
           ARRAY(SELECT mr.user_id FROM user_manual_recipients mr WHERE mr.manual_id = m.id ORDER BY mr.user_id) AS audienceUserIds,
           ARRAY(SELECT ru.name FROM user_manual_recipients mr JOIN users ru ON ru.id = mr.user_id WHERE mr.manual_id = m.id ORDER BY ru.name) AS audienceUserNames,
           COALESCE((SELECT json_agg(json_build_object(
             'id', ma.id, 'name', ma.original_name, 'mimeType', ma.mime_type, 'sizeBytes', ma.size_bytes, 'kind', ma.file_kind
           ) ORDER BY ma.id) FROM user_manual_attachments ma WHERE ma.manual_id = m.id), '[]'::json) AS attachments,
           COALESCE((SELECT json_agg(json_build_object(
             'id', ml.id, 'label', ml.label, 'url', ml.url
           ) ORDER BY ml.id) FROM user_manual_links ml WHERE ml.manual_id = m.id), '[]'::json) AS links,
           m.created_at AS createdAt, m.updated_at AS updatedAt
    FROM user_manuals m
    LEFT JOIN companies c ON c.id = m.audience_company_id
    LEFT JOIN users u ON u.id = m.audience_user_id
    ${visibility}
    ORDER BY m.updated_at DESC, m.id DESC
  `).all(...(isSuperAdmin ? [] : [user.id, user.id, user.role, user.id]));
}

app.get("/api/user-manuals", requireAuth, async (req, res) => {
  res.json({ manuals: await userManualList(req.user) });
});

app.get("/api/user-manual-audience", requireAuth, requireAdmin, async (_req, res) => {
  const [companies, users] = await Promise.all([
    db.prepare("SELECT id, name FROM companies WHERE is_active = 1 ORDER BY name, id").all(),
    db.prepare(`
      SELECT id, name, username, role FROM users
      WHERE disabled_at IS NULL AND approval_status = 'approved'
        AND (role = 'customer' OR (role = 'agent' AND is_admin = 0))
      ORDER BY role, name, id
    `).all(),
  ]);
  res.json({ companies, users });
});

function receiveUserManualFiles(req, res, next) {
  manualUpload.fields([{ name: "media", maxCount: 1 }, { name: "mediaFiles", maxCount: 10 }, { name: "attachments", maxCount: 10 }])(req, res, (error) => {
    const files = Object.values(req.files || {}).flat();
    if (error) {
      discardUploadedFiles(files);
      const message = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
        ? "Each audio/video file can be up to 200 MB; each document attachment must be 10 MB or smaller."
        : error instanceof multer.MulterError && error.code === "LIMIT_FILE_COUNT"
          ? "Upload up to 10 audio/video files and up to 10 document attachments."
          : error.message;
      return res.status(400).json({ error: message });
    }
    req.file = req.files?.media?.[0];
    req.manualMediaFiles = req.files?.mediaFiles || [];
    req.manualAttachments = req.files?.attachments || [];
    next();
  });
}

async function saveUserManual(req, res, manualId = null) {
  const file = req.file;
  const mediaFiles = req.manualMediaFiles || [];
  const attachments = req.manualAttachments || [];
  const discardManualUploads = () => discardUploadedFiles([...(file ? [file] : []), ...mediaFiles, ...attachments]);
  const reject = (status, message) => {
    discardManualUploads();
    return res.status(status).json({ error: message });
  };
  const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
  const summary = typeof req.body.summary === "string" ? req.body.summary.trim() : "";
  const content = typeof req.body.content === "string" ? req.body.content.trim() : "";
  let links = [];
  try {
    const parsedLinks = typeof req.body.links === "string" ? JSON.parse(req.body.links) : req.body.links;
    links = Array.isArray(parsedLinks) ? parsedLinks : [];
  } catch { links = null; }
  const isPublished = req.body.isPublished !== "false" && req.body.isPublished !== false;
  const audienceType = typeof req.body.audienceType === "string" ? req.body.audienceType : "all";
  const audienceCompanyId = audienceType === "company" ? Number(req.body.audienceCompanyId) : null;
  let audienceUserIds = [];
  if (audienceType === "user") {
    try {
      const parsed = typeof req.body.audienceUserIds === "string" ? JSON.parse(req.body.audienceUserIds) : req.body.audienceUserIds;
      audienceUserIds = Array.isArray(parsed) ? [...new Set(parsed.map(Number))] : [];
    } catch { audienceUserIds = []; }
  }
  const audienceUserId = audienceUserIds[0] || null;
  const removeMedia = req.body.removeMedia === "true" || req.body.removeMedia === true;
  if (title.length < 3 || title.length > 160) return reject(400, "Title must be between 3 and 160 characters.");
  if (summary.length > 500) return reject(400, "Summary cannot exceed 500 characters.");
  if (content.length > 20000) return reject(400, "Guide content cannot exceed 20,000 characters.");
  if (!links || links.length > 20) return reject(400, "Add up to 20 valid links to a guide.");
  const preparedLinks = [];
  for (const item of links) {
    const label = typeof item?.label === "string" ? item.label.trim() : "";
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return reject(400, "Enter a valid link URL."); }
    if (!label || label.length > 120 || url.length > 2048 || !["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      return reject(400, "Links need a label and a valid HTTP or HTTPS address.");
    }
    preparedLinks.push({ label, url: parsedUrl.toString() });
  }
  if (!["all", "company", "user"].includes(audienceType)) return reject(400, "Choose a valid guide audience.");
  if (audienceType === "company" && (!Number.isInteger(audienceCompanyId) || audienceCompanyId < 1)) return reject(400, "Choose a company for this guide.");
  if (audienceType === "user" && (!audienceUserIds.length || audienceUserIds.some((id) => !Number.isInteger(id) || id < 1))) return reject(400, "Choose one or more users for this guide.");
  if (audienceType === "company") {
    const company = await db.prepare("SELECT id FROM companies WHERE id = ? AND is_active = 1").get(audienceCompanyId);
    if (!company) return reject(400, "The selected company is unavailable.");
  }
  if (audienceType === "user") {
    const validIds = await Promise.all(audienceUserIds.map(async (id) => Boolean(await db.prepare(`
      SELECT id FROM users WHERE id = ? AND disabled_at IS NULL AND approval_status = 'approved'
        AND (role = 'customer' OR (role = 'agent' AND is_admin = 0))
    `).get(id))));
    if (validIds.some((isValid) => !isValid)) return reject(400, "One or more selected users are unavailable.");
  }

  const existing = manualId === null ? null : await db.prepare(`
    SELECT id, storage_name AS storageName, media_kind AS mediaKind, original_name AS mediaName,
           mime_type AS mediaMimeType, size_bytes AS mediaSizeBytes
    FROM user_manuals WHERE id = ?
  `).get(manualId);
  if (manualId !== null && !existing) return reject(404, "User manual not found.");
  let detectedMedia = null;
  if (file) {
    const detected = await fileTypeFromFile(file.path);
    const permitted = permittedManualMediaTypes.get(detected?.mime);
    if (!detected || !permitted || detected.mime !== file.mimetype) {
      return reject(400, `The uploaded media is not a supported audio or video file (${detected?.mime || "unknown file type"}).`);
    }
    const safeName = basename(file.originalname)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/[. ]+$/, "")
      .slice(0, 150);
    detectedMedia = { ...permitted, mimeType: detected.mime, originalName: safeName || `manual-media${permitted.extension}` };
    if (!permittedManualMediaExtensions.get(detected.mime)?.some((extension) => detectedMedia.originalName.toLowerCase().endsWith(extension))) {
      detectedMedia.originalName = `${detectedMedia.originalName}${permitted.extension}`;
    }
  }
  const mediaKind = detectedMedia?.kind || (removeMedia ? null : existing?.mediaKind || null);
  const mediaName = detectedMedia?.originalName || (removeMedia ? null : existing?.mediaName || null);
  const mediaMimeType = detectedMedia?.mimeType || (removeMedia ? null : existing?.mediaMimeType || null);
  const mediaSizeBytes = file?.size || (removeMedia ? null : existing?.mediaSizeBytes || null);
  const storageName = file?.filename || (removeMedia ? null : existing?.storageName || null);
  if (attachments.some((attachment) => attachment.size > 10 * 1024 * 1024)) return reject(400, "Each document attachment must be 10 MB or smaller.");

  const preparedAttachments = [];
  for (const attachment of attachments) {
    const extension = extname(attachment.originalname).toLowerCase();
    const allowedExtensions = permittedManualAttachmentTypes.get(attachment.mimetype);
    if (!allowedExtensions?.includes(extension)) return reject(400, "One or more guide attachments have an unsupported file type.");
    const originalName = basename(attachment.originalname)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/[. ]+$/, "")
      .slice(0, 150) || `guide-attachment${extension}`;
    preparedAttachments.push({ file: attachment, originalName });
  }
  if (!summary && !content && !storageName && !mediaFiles.length && !preparedAttachments.length && !preparedLinks.length) return reject(400, "Add written instructions or upload a guide file or link.");

  const preparedMediaFiles = [];
  for (const mediaFile of mediaFiles) {
    const detected = await fileTypeFromFile(mediaFile.path);
    const permitted = permittedManualMediaTypes.get(mediaFile.mimetype);
    const extension = extname(mediaFile.originalname).toLowerCase();
    if (!permitted || !permittedManualMediaExtensions.get(mediaFile.mimetype)?.includes(extension)
      || (detected && detected.mime !== mediaFile.mimetype)) {
      return reject(400, `The uploaded audio/video file “${mediaFile.originalname}” is not a supported format.`);
    }
    const originalName = basename(mediaFile.originalname)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/[. ]+$/, "")
      .slice(0, 150);
    preparedMediaFiles.push({ file: mediaFile, originalName: originalName || `guide-media${extension}`, kind: permitted.kind });
  }

  try {
    const saveRecord = db.transaction(async () => {
      let savedId;
      if (manualId === null) {
        const created = await db.prepare(`
          INSERT INTO user_manuals
            (title, summary, content, media_kind, storage_name, original_name, mime_type, size_bytes,
             is_published, created_by, audience_type, audience_company_id, audience_user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
        `).run(title, summary, content, mediaKind, storageName, mediaName, mediaMimeType, mediaSizeBytes,
          isPublished ? 1 : 0, req.user.id, audienceType, audienceCompanyId, audienceUserId);
        savedId = Number(created.lastInsertRowid);
      } else {
        await db.prepare(`
          UPDATE user_manuals SET title = ?, summary = ?, content = ?, media_kind = ?, storage_name = ?,
            original_name = ?, mime_type = ?, size_bytes = ?, is_published = ?, audience_type = ?,
            audience_company_id = ?, audience_user_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(title, summary, content, mediaKind, storageName, mediaName, mediaMimeType, mediaSizeBytes,
          isPublished ? 1 : 0, audienceType, audienceCompanyId, audienceUserId, manualId);
        savedId = manualId;
      }
      await db.prepare("DELETE FROM user_manual_recipients WHERE manual_id = ?").run(savedId);
      if (audienceType === "user") {
        for (const userId of audienceUserIds) {
          await db.prepare("INSERT INTO user_manual_recipients (manual_id, user_id) VALUES (?, ?)").run(savedId, userId);
        }
      }
      const addAttachment = db.prepare(`
        INSERT INTO user_manual_attachments (manual_id, storage_name, original_name, mime_type, size_bytes, file_kind)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of preparedAttachments) {
        await addAttachment.run(savedId, item.file.filename, item.originalName, item.file.mimetype, item.file.size, "file");
      }
      for (const item of preparedMediaFiles) {
        await addAttachment.run(savedId, item.file.filename, item.originalName, item.file.mimetype, item.file.size, item.kind);
      }
      await db.prepare("DELETE FROM user_manual_links WHERE manual_id = ?").run(savedId);
      const addLink = db.prepare("INSERT INTO user_manual_links (manual_id, label, url) VALUES (?, ?, ?)");
      for (const link of preparedLinks) await addLink.run(savedId, link.label, link.url);
      return savedId;
    });
    const savedId = await saveRecord();
    if (existing?.storageName && (file || removeMedia)) {
      try { unlinkSync(resolve(manualsRoot, existing.storageName)); } catch { /* Missing old media does not undo the saved guide. */ }
    }
    const manuals = await userManualList(req.user);
    res.status(manualId === null ? 201 : 200).json({ manual: manuals.find((item) => Number(item.id) === Number(savedId)) });
  } catch (error) {
    discardManualUploads();
    throw error;
  }
}

app.post("/api/user-manuals", requireAuth, requireAdmin, receiveUserManualFiles, async (req, res) => saveUserManual(req, res));
app.patch("/api/user-manuals/:id", requireAuth, requireAdmin, receiveUserManualFiles, async (req, res) => {
  const manualId = Number(req.params.id);
  if (!Number.isInteger(manualId) || manualId < 1) {
    discardUploadedFiles([...(req.file ? [req.file] : []), ...(req.manualMediaFiles || []), ...(req.manualAttachments || [])]);
    return res.status(400).json({ error: "Choose a valid user manual." });
  }
  return saveUserManual(req, res, manualId);
});
app.delete("/api/user-manuals/:id", requireAuth, requireAdmin, async (req, res) => {
  const manualId = Number(req.params.id);
  if (!Number.isInteger(manualId) || manualId < 1) return res.status(400).json({ error: "Choose a valid user manual." });
  const manual = await db.prepare("SELECT storage_name AS storageName FROM user_manuals WHERE id = ?").get(manualId);
  if (!manual) return res.status(404).json({ error: "User manual not found." });
  const attachments = await db.prepare("SELECT storage_name AS storageName FROM user_manual_attachments WHERE manual_id = ?").all(manualId);
  await db.prepare("DELETE FROM user_manuals WHERE id = ?").run(manualId);
  for (const storageName of [manual.storageName, ...attachments.map((attachment) => attachment.storageName)].filter(Boolean)) {
    try { unlinkSync(resolve(manualsRoot, storageName)); } catch { /* The database record is already removed. */ }
  }
  res.status(204).end();
});
app.get("/api/user-manuals/:id/media", requireAuth, async (req, res) => {
  const manualId = Number(req.params.id);
  if (!Number.isInteger(manualId) || manualId < 1) return res.status(400).json({ error: "Choose a valid user manual." });
  const isSuperAdmin = req.user.role === "agent" && req.user.is_admin;
  const visibility = isSuperAdmin ? "" : `AND is_published = 1 AND (
    audience_type = 'all'
    OR (audience_type = 'user' AND (audience_user_id = ? OR EXISTS (
      SELECT 1 FROM user_manual_recipients mr WHERE mr.manual_id = user_manuals.id AND mr.user_id = ?
    )))
    OR (audience_type = 'company' AND ? = 'customer' AND EXISTS (
      SELECT 1 FROM company_memberships cm WHERE cm.user_id = ? AND cm.company_id = user_manuals.audience_company_id
    ))
  )`;
  const manual = await db.prepare(`
    SELECT storage_name AS storageName, original_name AS mediaName, mime_type AS mediaMimeType
    FROM user_manuals WHERE id = ? ${visibility}
  `).get(...(isSuperAdmin ? [manualId] : [manualId, req.user.id, req.user.id, req.user.role, req.user.id]));
  if (!manual?.storageName) return res.status(404).json({ error: "Published manual media not found." });
  res.type(manual.mediaMimeType);
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(resolve(manualsRoot, manual.storageName), (error) => {
    if (error && !res.headersSent) res.status(error.code === "ENOENT" ? 404 : 500).json({ error: "Could not retrieve this manual media." });
  });
});

app.get("/api/user-manuals/:id/attachments/:attachmentId", requireAuth, async (req, res) => {
  const manualId = Number(req.params.id);
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isInteger(manualId) || manualId < 1 || !Number.isInteger(attachmentId) || attachmentId < 1) {
    return res.status(400).json({ error: "Choose a valid guide attachment." });
  }
  const isSuperAdmin = req.user.role === "agent" && req.user.is_admin;
  const visibility = isSuperAdmin ? "" : `AND m.is_published = 1 AND (
    m.audience_type = 'all'
    OR (m.audience_type = 'user' AND (m.audience_user_id = ? OR EXISTS (
      SELECT 1 FROM user_manual_recipients mr WHERE mr.manual_id = m.id AND mr.user_id = ?
    )))
    OR (m.audience_type = 'company' AND ? = 'customer' AND EXISTS (
      SELECT 1 FROM company_memberships cm WHERE cm.user_id = ? AND cm.company_id = m.audience_company_id
    ))
  )`;
  const attachment = await db.prepare(`
    SELECT a.storage_name AS storageName, a.original_name AS originalName, a.mime_type AS mimeType
    FROM user_manual_attachments a JOIN user_manuals m ON m.id = a.manual_id
    WHERE m.id = ? AND a.id = ? ${visibility}
  `).get(...(isSuperAdmin ? [manualId, attachmentId] : [manualId, attachmentId, req.user.id, req.user.id, req.user.role, req.user.id]));
  if (!attachment) return res.status(404).json({ error: "Guide attachment not found." });
  res.type(attachment.mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");
  res.sendFile(resolve(manualsRoot, attachment.storageName), (error) => {
    if (error && !res.headersSent) res.status(error.code === "ENOENT" ? 404 : 500).json({ error: "Could not retrieve this guide attachment." });
  });
});

app.delete("/api/user-manuals/:id/attachments/:attachmentId", requireAuth, requireAdmin, async (req, res) => {
  const manualId = Number(req.params.id);
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isInteger(manualId) || manualId < 1 || !Number.isInteger(attachmentId) || attachmentId < 1) {
    return res.status(400).json({ error: "Choose a valid guide attachment." });
  }
  const attachment = await db.prepare(`
    SELECT storage_name AS storageName FROM user_manual_attachments WHERE id = ? AND manual_id = ?
  `).get(attachmentId, manualId);
  if (!attachment) return res.status(404).json({ error: "Guide attachment not found." });
  await db.prepare("DELETE FROM user_manual_attachments WHERE id = ? AND manual_id = ?").run(attachmentId, manualId);
  try { unlinkSync(resolve(manualsRoot, attachment.storageName)); } catch { /* The database row is already removed. */ }
  res.status(204).end();
});

async function informationCenterPayload(user, search) {
  const params = [];
  let visibility = "";
  if (user.role === "customer") {
    visibility = `AND (p.all_clients = 1 OR EXISTS (
      SELECT 1 FROM information_post_recipients r WHERE r.information_id = p.id AND r.client_id = ?
    ) OR EXISTS (
      SELECT 1 FROM information_post_company_recipients cr
      JOIN company_memberships cm ON cm.company_id = cr.company_id
      WHERE cr.information_id = p.id AND cm.user_id = ?
    ))`;
    params.push(user.id, user.id);
  }
  const searchClause = search ? "AND (p.information ILIKE ? OR p.consultant_name ILIKE ? OR COALESCE(p.consultant_mobile, '') ILIKE ?)" : "";
  if (search) params.push(...Array(3).fill(`%${search}%`));
  const where = `WHERE 1 = 1 ${visibility} ${searchClause}`;
  const total = Number((await db.prepare(`SELECT COUNT(*) AS count FROM information_posts p ${where}`).get(...params)).count);
  const posts = await db.prepare(`
    SELECT p.id, p.consultant_id AS consultantId, p.consultant_name AS consultantName,
           p.consultant_mobile AS consultantMobile, p.information, p.all_clients AS allClients,
           p.created_at AS postedAt, p.updated_at AS updatedAt
    FROM information_posts p ${where}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT 500
  `).all(...params);
  for (const post of posts) post.attachments = [];
  if (posts.length) {
    const attachments = await db.prepare(`
      SELECT id, information_id AS informationId, original_name AS name,
             mime_type AS mimeType, size_bytes AS sizeBytes, created_at AS createdAt
      FROM information_post_attachments
      WHERE information_id IN (${posts.map(() => "?").join(",")})
      ORDER BY id
    `).all(...posts.map((post) => post.id));
    const attachmentsByPost = new Map();
    for (const attachment of attachments) {
      const list = attachmentsByPost.get(attachment.informationId) || [];
      list.push(attachment);
      attachmentsByPost.set(attachment.informationId, list);
    }
    for (const post of posts) post.attachments = attachmentsByPost.get(post.id) || [];
  }
  if (user.role === "agent" && posts.length) {
    const recipients = await db.prepare(`
      SELECT information_id AS informationId, client_id AS clientId
      FROM information_post_recipients
      WHERE information_id IN (${posts.map(() => "?").join(",")})
      ORDER BY client_id
    `).all(...posts.map((post) => post.id));
    const recipientsByPost = new Map();
    for (const recipient of recipients) {
      const list = recipientsByPost.get(recipient.informationId) || [];
      list.push(recipient.clientId);
      recipientsByPost.set(recipient.informationId, list);
    }
    for (const post of posts) post.recipientIds = recipientsByPost.get(post.id) || [];
    const companyRecipients = await db.prepare(`
      SELECT information_id AS informationId, company_id AS companyId
      FROM information_post_company_recipients
      WHERE information_id IN (${posts.map(() => "?").join(",")})
      ORDER BY company_id
    `).all(...posts.map((post) => post.id));
    const companiesByPost = new Map();
    for (const recipient of companyRecipients) {
      const list = companiesByPost.get(recipient.informationId) || [];
      list.push(recipient.companyId);
      companiesByPost.set(recipient.informationId, list);
    }
    for (const post of posts) post.recipientCompanyIds = companiesByPost.get(post.id) || [];
  }
  return { posts, total };
}

app.get("/api/information-center", requireAuth, async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 120) : "";
  const result = await informationCenterPayload(req.user, search);
  if (req.user.role !== "agent") return res.json(result);
  const clients = await db.prepare(`
    SELECT u.id, u.name, u.username, u.contact_number AS contactNumber,
           (SELECT string_agg(c.name, ', ' ORDER BY c.name)
            FROM company_memberships m JOIN companies c ON c.id = m.company_id
            WHERE m.user_id = u.id) AS companyNames
    FROM users u
    WHERE u.role = 'customer' AND u.approval_status = 'approved' AND u.disabled_at IS NULL
    ORDER BY u.name, u.id
  `).all();
  const companies = await db.prepare("SELECT id, name FROM companies ORDER BY name, id").all();
  res.json({ ...result, clients, companies });
});

async function saveInformationPost(req, res, postId = null) {
  const files = req.files || [];
  const reject = (status, error) => {
    discardUploadedFiles(files);
    return res.status(status).json({ error });
  };
  const information = typeof req.body.information === "string" ? req.body.information.trim() : "";
  const legacyAllClients = req.body.allClients === true || req.body.allClients === "true";
  const audience = ["all", "clients", "company"].includes(req.body.audience)
    ? req.body.audience
    : legacyAllClients ? "all" : "clients";
  const allClients = audience === "all";
  const companyId = Number(req.body.companyId);
  let rawClientIds = req.body.clientIds;
  if (typeof rawClientIds === "string") {
    try { rawClientIds = JSON.parse(rawClientIds); } catch { return reject(400, "The selected client list is invalid."); }
  }
  const clientIds = Array.isArray(rawClientIds)
    ? [...new Set(rawClientIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    : [];
  if (information.length < 5 || information.length > 10000) {
    return reject(400, "Information must be between 5 and 10,000 characters.");
  }
  if (audience === "clients" && clientIds.length === 0) {
    return reject(400, "Select at least one client or choose all clients.");
  }
  if (audience === "company" && (!Number.isInteger(companyId) || companyId < 1)) {
    return reject(400, "Select a company for this information post.");
  }
  const verifiedFiles = [];
  try {
    for (const file of files) {
      const detected = await fileTypeFromFile(file.path);
      const requiredExtension = permittedAttachmentTypes.get(detected?.mime);
      if (!detected || !requiredExtension || file.mimetype !== detected.mime) {
        throw new Error(`The attachment "${file.originalname}" is not a valid PDF or image file.`);
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
    return reject(400, error.message);
  }
  if (audience === "clients" && clientIds.length) {
    const found = Number((await db.prepare(`
      SELECT COUNT(*) AS count FROM users
      WHERE role = 'customer' AND approval_status = 'approved' AND disabled_at IS NULL
        AND id IN (${clientIds.map(() => "?").join(",")})
    `).get(...clientIds)).count);
    if (found !== clientIds.length) return reject(400, "One or more selected clients are no longer active.");
  }
  if (audience === "company") {
    const company = await db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId);
    if (!company) return reject(400, "The selected company is no longer available.");
  }

  if (postId !== null) {
    const existing = await db.prepare("SELECT id, consultant_id AS consultantId FROM information_posts WHERE id = ?").get(postId);
    if (!existing) return reject(404, "Information post not found.");
    if (Number(existing.consultantId) !== Number(req.user.id) && !req.user.is_admin) {
      return reject(403, "Only the posting Consultant or Super Admin can edit this information.");
    }
  }

  let id;
  try {
    id = await db.transaction(async () => {
      let savedId = postId;
      if (postId === null) {
        const inserted = await db.prepare(`
          INSERT INTO information_posts (consultant_id, consultant_name, consultant_mobile, information, all_clients)
          VALUES (?, ?, ?, ?, ?) RETURNING id
        `).run(req.user.id, req.user.name, req.user.contact_number || null, information, allClients ? 1 : 0);
        savedId = Number(inserted.lastInsertRowid);
      } else {
        await db.prepare(`
          UPDATE information_posts SET information = ?, all_clients = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(information, allClients ? 1 : 0, postId);
        await db.prepare("DELETE FROM information_post_recipients WHERE information_id = ?").run(postId);
        await db.prepare("DELETE FROM information_post_company_recipients WHERE information_id = ?").run(postId);
      }
      if (audience === "clients" && clientIds.length) {
        const insertRecipient = db.prepare("INSERT INTO information_post_recipients (information_id, client_id) VALUES (?, ?)");
        for (const clientId of clientIds) await insertRecipient.run(savedId, clientId);
      }
      if (audience === "company") {
        await db.prepare("INSERT INTO information_post_company_recipients (information_id, company_id) VALUES (?, ?)")
          .run(savedId, companyId);
      }
      const insertAttachment = db.prepare(`
        INSERT INTO information_post_attachments (information_id, uploaded_by, storage_name, original_name, mime_type, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const file of verifiedFiles) {
        await insertAttachment.run(savedId, req.user.id, file.filename, file.originalName, file.mimeType, file.size);
      }
      await db.prepare("DELETE FROM information_post_notifications WHERE information_id = ?").run(savedId);
      const notifiedClients = allClients
        ? await db.prepare("SELECT id FROM users WHERE role = 'customer' AND approval_status = 'approved' AND disabled_at IS NULL AND id <> ?").all(req.user.id)
        : audience === "company"
          ? await db.prepare(`
              SELECT DISTINCT u.id FROM users u JOIN company_memberships cm ON cm.user_id = u.id
              WHERE cm.company_id = ? AND u.role = 'customer' AND u.approval_status = 'approved'
                AND u.disabled_at IS NULL AND u.id <> ?
            `).all(companyId, req.user.id)
          : clientIds.filter((clientId) => Number(clientId) !== Number(req.user.id)).map((userId) => ({ id: userId }));
      const notifiedConsultants = await db.prepare(
        "SELECT id FROM users WHERE role = 'agent' AND disabled_at IS NULL AND id <> ?"
      ).all(req.user.id);
      const addNotification = db.prepare("INSERT INTO information_post_notifications (information_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING");
      for (const recipient of [...notifiedClients, ...notifiedConsultants]) await addNotification.run(savedId, recipient.id);
      return savedId;
    })();
  } catch (error) {
    discardUploadedFiles(files);
    throw error;
  }
  const result = await informationCenterPayload(req.user, "");
  const post = result.posts.find((item) => Number(item.id) === Number(id));
  res.status(postId === null ? 201 : 200).json({ post });
}

app.post("/api/information-center", requireAuth, requireAgent, receiveAttachments, async (req, res) => saveInformationPost(req, res));
app.patch("/api/information-center/:id", requireAuth, requireAgent, receiveAttachments, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Choose a valid information post." });
  return saveInformationPost(req, res, id);
});

app.get("/api/information-center/notifications", requireAuth, async (req, res) => {
  if (req.user.role !== "customer" && req.user.role !== "agent") return res.json({ notifications: [] });
  const audienceVisibility = req.user.role === "customer"
    ? `AND (p.all_clients = 1 OR EXISTS (
        SELECT 1 FROM information_post_recipients r WHERE r.information_id = p.id AND r.client_id = n.user_id
      ) OR EXISTS (
        SELECT 1 FROM information_post_company_recipients cr
        JOIN company_memberships cm ON cm.company_id = cr.company_id
        WHERE cr.information_id = p.id AND cm.user_id = n.user_id
      ))`
    : "AND p.consultant_id <> n.user_id";
  const notifications = await db.prepare(`
    SELECT n.id, n.information_id AS informationId, n.created_at AS createdAt,
           p.consultant_name AS consultantName, p.consultant_mobile AS consultantMobile,
           p.information, p.created_at AS postedAt
    FROM information_post_notifications n
    JOIN information_posts p ON p.id = n.information_id
    WHERE n.user_id = ? AND n.read_at IS NULL
      ${audienceVisibility}
    ORDER BY n.created_at DESC, n.id DESC LIMIT 20
  `).all(req.user.id);
  if (notifications.length) {
    const attachments = await db.prepare(`
      SELECT id, information_id AS informationId, original_name AS name, mime_type AS mimeType,
             size_bytes AS sizeBytes, created_at AS createdAt
      FROM information_post_attachments
      WHERE information_id IN (${notifications.map(() => "?").join(",")}) ORDER BY id
    `).all(...notifications.map((item) => item.informationId));
    const attachmentsByPost = new Map();
    for (const attachment of attachments) {
      const list = attachmentsByPost.get(attachment.informationId) || [];
      list.push(attachment);
      attachmentsByPost.set(attachment.informationId, list);
    }
    for (const notification of notifications) notification.attachments = attachmentsByPost.get(notification.informationId) || [];
  }
  res.json({ notifications });
});

app.post("/api/information-center/notifications/read", requireAuth, async (req, res) => {
  const id = Number(req.body.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid information notification id." });
  await db.prepare("UPDATE information_post_notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
    .run(id, req.user.id);
  res.status(204).end();
});

app.get("/api/information-center/:id/attachments/:attachmentId", requireAuth, async (req, res) => {
  const informationId = Number(req.params.id);
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isInteger(informationId) || !Number.isInteger(attachmentId) || informationId < 1 || attachmentId < 1) {
    return res.status(400).json({ error: "Invalid information or attachment id." });
  }
  if (req.user.role === "customer") {
    const visible = await db.prepare(`
      SELECT p.id FROM information_posts p
      WHERE p.id = ? AND (p.all_clients = 1 OR EXISTS (
        SELECT 1 FROM information_post_recipients r WHERE r.information_id = p.id AND r.client_id = ?
      ) OR EXISTS (
        SELECT 1 FROM information_post_company_recipients cr
        JOIN company_memberships cm ON cm.company_id = cr.company_id
        WHERE cr.information_id = p.id AND cm.user_id = ?
      ))
    `).get(informationId, req.user.id, req.user.id);
    if (!visible) return res.status(404).json({ error: "Attachment not found." });
  }
  const attachment = await db.prepare(`
    SELECT storage_name, original_name, mime_type FROM information_post_attachments
    WHERE id = ? AND information_id = ?
  `).get(attachmentId, informationId);
  if (!attachment) return res.status(404).json({ error: "Attachment not found." });
  res.type(attachment.mime_type);
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(attachment.original_name)}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(resolve(attachmentsRoot, attachment.storage_name), (error) => {
    if (error && !res.headersSent) res.status(error.code === "ENOENT" ? 404 : 500).json({ error: "Could not retrieve this attachment." });
  });
});

app.get("/api/knowledge-base", requireAuth, requireAgent, async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const pageSize = 50;
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 120) : "";
  const companyId = req.query.companyId === undefined ? null : Number(req.query.companyId);
  if (!Number.isInteger(page) || page < 1 || page > 100000) {
    return res.status(400).json({ error: "Choose a valid Knowledge Base page." });
  }
  if (companyId !== null && (!Number.isInteger(companyId) || companyId < 1)) {
    return res.status(400).json({ error: "Choose a valid company." });
  }

  const searchClause = search
    ? `AND (LOWER(t.subject) LIKE LOWER(?) OR LOWER(t.description) LIKE LOWER(?) OR LOWER(COALESCE(t.category, '')) LIKE LOWER(?) OR LOWER(COALESCE(t.reported_client_name, customer.name, '')) LIKE LOWER(?) OR LOWER(COALESCE(t.historical_consultant_name, consultant.name, '')) LIKE LOWER(?) OR LOWER(COALESCE(t.historical_solution, solution.body, '')) LIKE LOWER(?))`
    : "";
  const searchParams = search ? Array(6).fill(`%${search}%`) : [];
  const companyClause = companyId === null ? "" : "AND t.company_id = ?";
  const companyParams = companyId === null ? [] : [companyId];
  const knowledgeFrom = `
    FROM tickets t
    LEFT JOIN users customer ON customer.id = t.customer_id
    LEFT JOIN users consultant ON consultant.id = COALESCE(
      t.resolved_by, t.assignee_id,
      (SELECT h.agent_id FROM ticket_assignment_history h
       WHERE h.ticket_id = t.id AND h.agent_id IS NOT NULL ORDER BY h.id DESC LIMIT 1)
    )
    LEFT JOIN messages solution ON solution.id = (
      SELECT m.id FROM messages m JOIN users author ON author.id = m.author_id
      WHERE m.ticket_id = t.id AND m.is_internal = 0 AND author.role = 'agent'
      ORDER BY m.id DESC LIMIT 1
    )
    WHERE t.status = 'resolved' ${searchClause} ${companyClause}
  `;
  const [{ count }] = await db.prepare(`SELECT COUNT(*) AS count ${knowledgeFrom}`).all(...searchParams, ...companyParams);
  const tickets = await db.prepare(`
    SELECT t.id, t.subject AS issue, t.description,
           t.created_at AS reportedAt, COALESCE(t.resolved_at, t.updated_at) AS closedAt,
           COALESCE(t.historical_solution, solution.body, 'No consultant solution recorded.') AS solution,
           CASE WHEN t.import_key IS NOT NULL THEN '' ELSE COALESCE(t.category, 'Unspecified') END AS solutionType,
           COALESCE(NULLIF(t.reported_client_name, ''), customer.name, '') AS clientName,
           COALESCE(NULLIF(t.historical_consultant_name, ''), consultant.name, '') AS consultantName
    ${knowledgeFrom}
    ORDER BY COALESCE(t.resolved_at, t.updated_at) DESC, t.id DESC
    LIMIT ? OFFSET ?
  `).all(...searchParams, ...companyParams, pageSize, (page - 1) * pageSize);
  res.json({ tickets, total: Number(count), page, pageSize });
});

app.get("/api/agents", requireAuth, async (_req, res) => {
  const agents = await db.prepare(`
    SELECT id, name, username, email, is_admin AS isAdmin, routing_priority AS routingPriority, specialty
    FROM users WHERE role = 'agent' AND disabled_at IS NULL ORDER BY routing_priority, id
  `).all();
  res.json({ agents: agents.map((agent, index) => ({
    ...agent,
    priorityLabel: index === 0 ? "Primary" : index === 1 ? "Secondary" : `Consultant ${index + 1}`,
  })) });
});

app.patch("/api/agents/:id", requireAuth, requireAdmin, async (req, res) => {
  const agentId = Number(req.params.id);
  if (!Number.isInteger(agentId) || agentId < 1) return res.status(400).json({ error: "Invalid Consultant id." });
  const hasDisabled = req.body.disabled !== undefined;
  const hasRoutingPriority = req.body.routingPriority !== undefined;
  const hasSpecialty = req.body.specialty !== undefined;
  const hasPassword = req.body.password !== undefined;
  const hasName = req.body.name !== undefined;
  const hasUsername = req.body.username !== undefined;
  const hasEmail = req.body.email !== undefined;
  const hasContactNumber = req.body.contactNumber !== undefined;
  if ((!hasDisabled && !hasRoutingPriority && !hasSpecialty && !hasPassword && !hasName && !hasUsername && !hasEmail && !hasContactNumber)
    || (hasDisabled && typeof req.body.disabled !== "boolean")
    || (hasRoutingPriority && (!Number.isInteger(req.body.routingPriority) || req.body.routingPriority < 1))
    || (hasSpecialty && !["functional", "technical", "both"].includes(req.body.specialty))
    || (hasPassword && (typeof req.body.password !== "string" || req.body.password.length < 8 || req.body.password.length > 128))) {
    return res.status(400).json({ error: "Choose a valid Consultant access or routing-priority update." });
  }
  const profileUpdates = [];
  const profileValues = [];
  if (hasName) {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (name.length < 2 || name.length > 120) return res.status(400).json({ error: "Enter a name between 2 and 120 characters." });
    profileUpdates.push("name = ?");
    profileValues.push(name);
  }
  if (hasUsername) {
    const username = normalizeUsername(req.body.username);
    if (!validUsername(username)) return res.status(400).json({ error: "Username must be 3 to 32 characters and use letters, numbers, dots, underscores, or hyphens." });
    if (await db.prepare("SELECT 1 FROM users WHERE role = 'agent' AND username = ? AND id <> ?").get(username, agentId)) {
      return res.status(409).json({ error: "That Consultant username is already in use." });
    }
    profileUpdates.push("username = ?");
    profileValues.push(username);
  }
  if (hasEmail) {
    const email = optionalEmail(req.body.email);
    if (email === false) return res.status(400).json({ error: "Enter a valid email address or leave it blank." });
    if (email && await db.prepare("SELECT 1 FROM users WHERE lower(email) = ? AND id <> ?").get(email, agentId)) {
      return res.status(409).json({ error: "That email address is already in use." });
    }
    profileUpdates.push("email = ?");
    profileValues.push(email);
  }
  if (hasContactNumber) {
    const contactNumber = optionalContactNumber(req.body.contactNumber);
    if (!contactNumber) return res.status(400).json({ error: "Enter a valid mobile number (7 to 15 digits)." });
    profileUpdates.push("contact_number = ?");
    profileValues.push(contactNumber);
  }
  const agent = await db.prepare("SELECT id, is_admin, disabled_at, routing_priority FROM users WHERE id = ? AND role = 'agent'").get(agentId);
  if (!agent) return res.status(404).json({ error: "Consultant not found." });
  if (hasDisabled && req.body.disabled && agentId === req.user.id) {
    return res.status(400).json({ error: "You cannot disable your own account." });
  }
  if (hasDisabled && req.body.disabled && agent.is_admin) {
    const adminCount = (await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'agent' AND is_admin = 1 AND disabled_at IS NULL").get()).count;
    if (adminCount <= 1) return res.status(400).json({ error: "The last active administrator cannot be disabled." });
  }
  if (hasRoutingPriority) {
    if (agent.disabled_at) return res.status(400).json({ error: "Enable this Consultant before changing their routing priority." });
    const orderedAgents = await db.prepare(`
      SELECT id FROM users WHERE role = 'agent' AND disabled_at IS NULL
      ORDER BY routing_priority, id
    `).all();
    if (req.body.routingPriority > orderedAgents.length) return res.status(400).json({ error: "Choose a priority within the active Consultant list." });
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
  if (hasSpecialty) await db.prepare("UPDATE users SET specialty = ? WHERE id = ?").run(req.body.specialty, agentId);
  if (hasPassword) await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(req.body.password, 12), agentId);
  if (profileUpdates.length) {
    try {
      await db.prepare(`UPDATE users SET ${profileUpdates.join(", ")} WHERE id = ?`).run(...profileValues, agentId);
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "That Consultant username or email address is already in use." });
      throw error;
    }
  }
  res.json({ agent: await db.prepare("SELECT id, name, username, email, contact_number AS contactNumber, is_admin AS isAdmin, routing_priority AS routingPriority, specialty, disabled_at AS disabledAt FROM users WHERE id = ?").get(agentId) });
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

app.get("/api/admin/tat-settings", requireAuth, requireAdmin, async (_req, res) => {
  res.json({ tat: await tatConfiguration() });
});

app.put("/api/admin/tat-settings", requireAuth, requireAdmin, async (req, res) => {
  const { startHour, endHour, priorityHours, warningPercent } = req.body;
  await db.transaction(async () => {
    if (startHour !== undefined && Number.isFinite(Number(startHour))) {
      await db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('tat_working_start_hour', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(startHour));
    }
    if (endHour !== undefined && Number.isFinite(Number(endHour))) {
      await db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('tat_working_end_hour', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(endHour));
    }
    if (warningPercent !== undefined && Number.isFinite(Number(warningPercent))) {
      await db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('tat_warning_percent', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(warningPercent));
    }
    if (priorityHours && typeof priorityHours === "object") {
      if (priorityHours.critical !== undefined) {
        await db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('tat_priority_critical_hours', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(priorityHours.critical));
      }
      if (priorityHours.high !== undefined) {
        await db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('tat_priority_high_hours', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(priorityHours.high));
      }
      if (priorityHours.medium !== undefined || priorityHours.normal !== undefined) {
        const med = priorityHours.medium ?? priorityHours.normal;
        await db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('tat_priority_medium_hours', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(med));
      }
      if (priorityHours.low !== undefined) {
        await db.prepare("INSERT INTO workspace_settings (key, value) VALUES ('tat_priority_low_hours', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(priorityHours.low));
      }
    }
  })();
  res.json({ tat: await tatConfiguration() });
});

app.get("/api/admin/holidays", requireAuth, requireAdmin, async (_req, res) => {
  const holidays = await db.prepare("SELECT * FROM holidays ORDER BY holiday_date ASC").all();
  res.json({ holidays });
});

app.post("/api/admin/holidays", requireAuth, requireAdmin, async (req, res) => {
  const holidayDate = typeof req.body.holidayDate === "string" ? req.body.holidayDate.trim().slice(0, 10) : "";
  const holidayName = typeof req.body.holidayName === "string" ? req.body.holidayName.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(holidayDate) || !holidayName) {
    return res.status(400).json({ error: "Provide a valid holiday date (YYYY-MM-DD) and holiday name." });
  }
  const result = await db.prepare(`
    INSERT INTO holidays (holiday_date, holiday_name, is_active)
    VALUES (?, ?, 1)
    ON CONFLICT (holiday_date) DO UPDATE SET holiday_name = excluded.holiday_name, is_active = 1, updated_at = CURRENT_TIMESTAMP
    RETURNING *
  `).get(holidayDate, holidayName);
  res.status(201).json({ holiday: result });
});

app.patch("/api/admin/holidays/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid holiday id." });
  const existing = await db.prepare("SELECT * FROM holidays WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Holiday not found." });

  const holidayName = req.body.holidayName !== undefined ? String(req.body.holidayName).trim() : existing.holiday_name;
  const holidayDate = req.body.holidayDate !== undefined ? String(req.body.holidayDate).trim().slice(0, 10) : existing.holiday_date;
  const isActive = req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : existing.is_active;

  const updated = await db.prepare(`
    UPDATE holidays SET holiday_name = ?, holiday_date = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    RETURNING *
  `).get(holidayName, holidayDate, isActive, id);
  res.json({ holiday: updated });
});

app.delete("/api/admin/holidays/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid holiday id." });
  await db.prepare("DELETE FROM holidays WHERE id = ?").run(id);
  res.json({ success: true });
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
    SELECT id, name, username, email, contact_number AS contactNumber,
           is_admin AS isAdmin, routing_priority AS routingPriority, specialty,
           disabled_at AS disabledAt
    FROM users WHERE role = 'agent' ORDER BY disabled_at IS NOT NULL, routing_priority, id
  `).all();
  const invitations = await db.prepare(`
    SELECT i.id, i.email, i.specialty, i.expires_at AS expiresAt, i.created_at AS createdAt, u.name AS invitedBy
    FROM agent_invitations i JOIN users u ON u.id = i.invited_by
    WHERE i.accepted_at IS NULL AND datetime(i.expires_at) > CURRENT_TIMESTAMP
    ORDER BY i.created_at DESC
  `).all();
  res.json({ agents, invitations });
});

app.post("/api/admin/agents", requireAuth, requireAdmin, async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const username = normalizeUsername(req.body.username);
  const email = optionalEmail(req.body.email);
  const contactNumber = optionalContactNumber(req.body.contactNumber);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const isAdmin = req.body.isAdmin === true;
  const specialty = req.body.specialty;
  if (name.length < 2 || name.length > 120) return res.status(400).json({ error: "Enter a name between 2 and 120 characters." });
  if (!validUsername(username)) return res.status(400).json({ error: "Username must be 3–32 characters and use letters, numbers, dots, underscores, or hyphens." });
  if (email === false) return res.status(400).json({ error: "Enter a valid email address or leave it blank." });
  if (!contactNumber) return res.status(400).json({ error: "Enter a valid mobile number (7 to 15 digits)." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Set an initial password between 8 and 128 characters." });
  if (!["functional", "technical", "both"].includes(specialty)) return res.status(400).json({ error: "Choose Functional, Technical, or Both for the Consultant specialty." });
  try {
    const routingPriority = Number((await db.prepare("SELECT COALESCE(MAX(routing_priority), 0) AS priority FROM users WHERE role = 'agent'").get()).priority) + 1;
    const created = await db.prepare(`
      INSERT INTO users (name, username, email, contact_number, password_hash, role, is_admin, routing_priority, specialty)
      VALUES (?, ?, ?, ?, ?, 'agent', ?, ?, ?) RETURNING id, name, username, email, contact_number AS contactNumber, is_admin AS isAdmin, routing_priority AS routingPriority, specialty
    `).run(name, username, email, contactNumber, bcrypt.hashSync(password, 12), Number(isAdmin), routingPriority, specialty);
    const agent = await db.prepare(`
      SELECT id, name, username, email, is_admin AS isAdmin, routing_priority AS routingPriority, specialty, disabled_at AS disabledAt
      FROM users WHERE id = ?
    `).get(created.lastInsertRowid);
    return res.status(201).json({ agent });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That username or email address is already in use." });
    throw error;
  }
});

app.get("/api/admin/companies", requireAuth, requireAdmin, async (_req, res) => {
  const companies = await db.prepare(`
    SELECT c.id, c.name, c.domain, c.support_valid_until AS supportValidUntil, c.is_active AS isActive,
           c.internal_consultant_id AS internalConsultantId,
           ic.name AS internalConsultantName, ic.role AS internalConsultantRole,
           COUNT(DISTINCT u.id) AS userCount,
           COUNT(DISTINCT CASE WHEN u.approval_status = 'pending' THEN u.id END) AS pendingCount
    FROM companies c
    LEFT JOIN users ic ON ic.id = c.internal_consultant_id
    LEFT JOIN company_memberships m ON m.company_id = c.id
    LEFT JOIN users u ON u.id = m.user_id AND u.role = 'customer'
    GROUP BY c.id, ic.name, ic.role ORDER BY c.name
  `).all();
  res.json({ companies });
});

app.patch("/api/admin/companies/:id", requireAuth, requireAdmin, async (req, res) => {
  const companyId = Number(req.params.id);
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const domain = typeof req.body.domain === "string" ? req.body.domain.trim().toLowerCase().replace(/^@/, "") : "";
  const supportValidUntil = req.body.supportValidUntil;
  let internalConsultantId = req.body.internalConsultantId !== undefined
    ? (req.body.internalConsultantId === null || req.body.internalConsultantId === "" ? null : Number(req.body.internalConsultantId))
    : undefined;

  if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error: "Choose a valid company." });
  if (name.length < 2 || name.length > 120) return res.status(400).json({ error: "Company name must be between 2 and 120 characters." });
  if (domain && (!/^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain))) {
    return res.status(400).json({ error: "Enter a valid company email domain, or leave it blank." });
  }
  if (supportValidUntil && !validDateOnly(supportValidUntil)) return res.status(400).json({ error: "Enter a valid Support valid until date." });

  if (internalConsultantId !== undefined && internalConsultantId !== null) {
    if (!Number.isInteger(internalConsultantId) || internalConsultantId < 1) {
      return res.status(400).json({ error: "Choose a valid Internal Consultant." });
    }
    const candidate = await db.prepare(`
      SELECT u.id, u.name, u.role FROM users u
      LEFT JOIN company_memberships m ON m.user_id = u.id AND m.company_id = ?
      WHERE u.id = ? AND u.disabled_at IS NULL AND (
        u.role = 'agent' OR (u.role = 'customer' AND m.company_id IS NOT NULL AND u.approval_status = 'approved')
      )
    `).get(companyId, internalConsultantId);
    if (!candidate) {
      return res.status(400).json({ error: "The Internal Consultant must be an active Consultant or an approved client in this company." });
    }
  }

  const slug = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
  if (!slug) return res.status(400).json({ error: "Company name must contain at least one letter or number." });
  try {
    const fields = ["name = ?", "slug = ?", "domain = ?", "support_valid_until = ?"];
    const values = [name, slug, domain || null, supportValidUntil || null];
    if (internalConsultantId !== undefined) {
      fields.push("internal_consultant_id = ?");
      values.push(internalConsultantId);
    }
    values.push(companyId);
    const updated = await db.prepare(`
      UPDATE companies SET ${fields.join(", ")} WHERE id = ?
    `).run(...values);
    if (updated.changes !== 1) return res.status(404).json({ error: "Company not found." });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That company name, email domain, or URL slug is already in use." });
    throw error;
  }
  res.json({ company: await db.prepare(`
    SELECT c.id, c.name, c.domain, c.support_valid_until AS supportValidUntil,
           c.internal_consultant_id AS internalConsultantId,
           ic.name AS internalConsultantName, ic.role AS internalConsultantRole
    FROM companies c
    LEFT JOIN users ic ON ic.id = c.internal_consultant_id
    WHERE c.id = ?
  `).get(companyId) });
});

app.patch("/api/admin/companies/:id/status", requireAuth, requireAdmin, async (req, res) => {
  const companyId = Number(req.params.id);
  const isActive = req.body.isActive;
  if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error: "Choose a valid company." });
  if (typeof isActive !== "boolean") return res.status(400).json({ error: "Choose whether the company should be active." });
  const updated = await db.prepare("UPDATE companies SET is_active = ? WHERE id = ?").run(isActive ? 1 : 0, companyId);
  if (updated.changes !== 1) return res.status(404).json({ error: "Company not found." });
  const company = await db.prepare(`
    SELECT id, name, domain, support_valid_until AS supportValidUntil, is_active AS isActive
    FROM companies WHERE id = ?
  `).get(companyId);
  res.json({ company, message: isActive ? "Company access enabled." : "Company access disabled." });
});

app.get("/api/admin/companies/:id/ticket-clients", requireAuth, requireAdmin, async (req, res) => {
  const companyId = Number(req.params.id);
  if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error: "Choose a valid company." });
  const company = await db.prepare("SELECT id FROM companies WHERE id = ? AND is_active = 1").get(companyId);
  if (!company) return res.status(404).json({ error: "Active company not found." });
  const clients = await db.prepare(`
    SELECT u.id, u.name, u.username, u.contact_number AS contactNumber
    FROM users u JOIN company_memberships m ON m.user_id = u.id
    WHERE m.company_id = ? AND u.role = 'customer' AND u.approval_status = 'approved'
      AND u.disabled_at IS NULL
    ORDER BY u.name, u.id
  `).all(companyId);
  res.json({ clients });
});

app.post("/api/admin/manual-tickets", requireAuth, requireAdmin, receiveAttachments, async (req, res) => {
  const files = req.files || [];
  const reject = (status, error) => {
    discardUploadedFiles(files);
    return res.status(status).json({ error });
  };

  let verifiedFiles = [];
  try {
    verifiedFiles = await verifyTicketFiles(files);
  } catch (error) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: error.message });
  }

  const companyId = Number(req.body.companyId);
  const clientId = Number(req.body.clientId);
  const consultantId = Number(req.body.consultantId);
  const subject = typeof req.body.subject === "string" ? req.body.subject.trim() : "";
  const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
  const solution = typeof req.body.solution === "string" ? req.body.solution.trim() : "";
  const raisedDate = req.body.raisedDate;
  const requestedStatus = req.body.status;
  const status = requestedStatus === "closed" ? "resolved" : requestedStatus;
  const closedDate = req.body.closedDate;

  if (!Number.isInteger(companyId) || companyId < 1) return reject(400, "Choose a valid company.");
  if (!Number.isInteger(clientId) || clientId < 1) return reject(400, "Choose a client.");
  if (!Number.isInteger(consultantId) || consultantId < 1) return reject(400, "Choose a Consultant.");
  if (subject.length < 4 || subject.length > 160) return reject(400, "Ticket subject must be between 4 and 160 characters.");
  if (description.length < 10 || description.length > 5000) return reject(400, "Ticket description must be between 10 and 5,000 characters.");
  if (solution.length > 5000) return reject(400, "Consultant solution must be 5,000 characters or fewer.");
  if (!validDateOnly(raisedDate)) return reject(400, "Choose a valid ticket raised date.");
  if (!["open", "in_progress", "waiting", "resolved"].includes(status)) return reject(400, "Choose Open, In progress, Waiting, or Closed as the ticket status.");
  if (status === "resolved" && !validDateOnly(closedDate)) return reject(400, "Choose a valid closed date for a Closed ticket.");
  if (status === "resolved" && closedDate < raisedDate) return reject(400, "Closed date cannot be before the ticket raised date.");

  const company = await db.prepare("SELECT id, name FROM companies WHERE id = ? AND is_active = 1").get(companyId);
  if (!company) return reject(404, "Active company not found.");
  const client = await db.prepare(`
    SELECT u.id, u.name, u.contact_number AS contactNumber
    FROM users u JOIN company_memberships m ON m.user_id = u.id
    WHERE u.id = ? AND m.company_id = ? AND u.role = 'customer' AND u.approval_status = 'approved'
      AND u.disabled_at IS NULL
  `).get(clientId, companyId);
  if (!client) return reject(400, "Choose an active client in the selected company.");
  const consultant = await db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'agent' AND disabled_at IS NULL").get(consultantId);
  if (!consultant) return reject(400, "Choose an active Consultant.");

  const raisedAt = `${raisedDate} 00:00:00`;
  const resolvedAt = status === "resolved" ? `${closedDate} 00:00:00` : null;
  const updatedAt = resolvedAt || raisedAt;

  let ticketId;
  try {
    ticketId = await db.transaction(async () => {
      const seqRow = await db.prepare("SELECT COALESCE(MAX(company_ticket_seq), 0) AS max_seq FROM tickets WHERE company_id = ?").get(company.id);
      const companyTicketSeq = Number(seqRow?.max_seq || 0) + 1;

      const tatCfg = await tatConfiguration();
      const tatDurationMinutes = tatCfg.priorityHours.normal * 60;
      const holidays = await getActiveHolidayDates();
      const tatStartAt = getValidTATStartTime(raisedAt, holidays, tatCfg.startHour, tatCfg.endHour)?.toISOString();
      const tatDueAt = calculateTATDeadline(raisedAt, tatDurationMinutes, holidays, tatCfg.startHour, tatCfg.endHour)?.toISOString();
      let tatStatus = "within_tat";
      let tatElapsed = 0;
      if (status === "resolved") {
        const closeDate = resolvedAt ? new Date(resolvedAt) : new Date();
        tatElapsed = calculateElapsedWorkingMinutes(tatStartAt || raisedAt, closeDate, holidays, tatCfg.startHour, tatCfg.endHour);
        const dueTime = tatDueAt ? new Date(tatDueAt).getTime() : 0;
        tatStatus = (dueTime > 0 && closeDate.getTime() <= dueTime) ? "resolved_within_tat" : "resolved_after_tat";
      }

      const created = await db.prepare(`
        INSERT INTO tickets (
          subject, description, status, priority, customer_id, company_id, assignee_id, source,
          category, tags_json, custom_fields_json, created_at, updated_at, resolved_at, resolved_by,
          reported_client_name, reported_client_contact, historical_solution, historical_consultant_name,
          company_ticket_seq, tat_start_at, tat_duration_minutes, tat_due_at, tat_elapsed_minutes, tat_status
        ) VALUES (?, ?, ?, 'normal', ?, ?, ?, 'portal', 'Other', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
      `).run(
        subject, description, status, client.id, company.id, consultant.id,
        JSON.stringify({ manualEntry: true, enteredBy: req.user.name }),
        raisedAt, updatedAt, resolvedAt, status === "resolved" ? consultant.id : null,
        client.name, client.contactNumber, solution || null, consultant.name,
        companyTicketSeq,
        tatStartAt, tatDurationMinutes, tatDueAt, tatElapsed, tatStatus,
      );
      const id = Number(created.lastInsertRowid);
      const msgResult = await db.prepare("INSERT INTO messages (ticket_id, author_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING id")
        .run(id, client.id, description, raisedAt);
      const initialMessageId = Number(msgResult.lastInsertRowid);
      await db.prepare(`
        INSERT INTO ticket_assignment_history (ticket_id, agent_id, assigned_by, source, created_at)
        VALUES (?, ?, ?, 'manual_entry', ?)
      `).run(id, consultant.id, req.user.id, raisedAt);

      if (verifiedFiles.length > 0) {
        const insertAttachment = db.prepare(`
          INSERT INTO ticket_attachments (ticket_id, uploaded_by, storage_name, original_name, mime_type, size_bytes, message_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const file of verifiedFiles) {
          await insertAttachment.run(id, req.user.id, file.filename, file.originalName, file.mimeType, file.size, initialMessageId);
        }
      }

      if (status !== "resolved") {
        await db.prepare(`
          INSERT INTO notifications (user_id, ticket_id, kind, message)
          VALUES (?, ?, 'ticket_created', ?)
          ON CONFLICT (user_id, ticket_id, kind) DO NOTHING
        `).run(consultant.id, id, `Manually entered ticket from ${client.name}: ${subject}`);
      }
      return id;
    })();
  } catch (error) {
    discardUploadedFiles(files);
    throw error;
  }

  const ticket = await db.prepare(`${ticketSelect} WHERE t.id = ?`).get(ticketId);
  res.status(201).json({ ticket: await ticketSummary(ticket) });
});

function historicalAccountMatch(accounts, record) {
  const digits = (value) => String(value || "").replace(/\D/g, "");
  const phoneKey = (value) => {
    const valueDigits = digits(value);
    return valueDigits.length > 10 ? valueDigits.slice(-10) : valueDigits;
  };
  const ticketPhone = phoneKey(record.reporterContact);
  if (ticketPhone) {
    const phoneMatches = accounts.filter((account) => phoneKey(account.contact_number) === ticketPhone);
    if (phoneMatches.length === 1) return phoneMatches[0];
    if (phoneMatches.length > 1) return null;
  }
  const nameKey = (value) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const ticketName = nameKey(record.reporterName);
  const nameMatches = ticketName ? accounts.filter((account) => nameKey(account.name) === ticketName) : [];
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

async function historicalAccountMatches(companyId, tickets) {
  const [clients, consultants] = companyId ? await Promise.all([
    db.prepare(`
      SELECT u.id, u.name, u.contact_number FROM users u
      JOIN company_memberships m ON m.user_id = u.id
      WHERE m.company_id = ? AND u.role = 'customer'
    `).all(companyId),
    db.prepare("SELECT id, name, contact_number FROM users WHERE role = 'agent' AND disabled_at IS NULL").all(),
  ]) : [[], []];
  return tickets.map((ticket) => ({
    customer: ticket.reporterType === "client" ? historicalAccountMatch(clients, ticket) : null,
    consultant: ticket.reporterType === "consultant" ? historicalAccountMatch(consultants, ticket) : null,
  }));
}

app.post("/api/admin/historical-tickets/import", requireAuth, requireAdmin, historicalWorkbookUpload.single("workbook"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose an .xlsx workbook to import." });
  if (extname(req.file.originalname).toLowerCase() !== ".xlsx") {
    return res.status(400).json({ error: "Upload an Excel .xlsx workbook." });
  }

  let parsed;
  try {
    parsed = parseHistoricalTicketWorkbook(req.file.buffer);
  } catch (error) {
    return res.status(400).json({ error: error.message || "Could not read the Excel workbook." });
  }

  if (req.body.mode === "preview") {
    const company = await db.prepare("SELECT id, name FROM companies WHERE lower(name) IN ('steel center', 'steel') ORDER BY CASE lower(name) WHEN 'steel center' THEN 0 ELSE 1 END LIMIT 1").get();
    const matches = await historicalAccountMatches(company?.id, parsed.tickets);
    return res.json({
      mode: "preview",
      companyName: company?.name || "Steel Center",
      total: parsed.tickets.length,
      clientTickets: parsed.tickets.filter((ticket) => ticket.reporterType === "client").length,
      consultantTickets: parsed.tickets.filter((ticket) => ticket.reporterType === "consultant").length,
      linkedClientTickets: matches.filter((match) => match.customer).length,
      assignedConsultantTickets: matches.filter((match) => match.consultant).length,
      skipped: parsed.skippedRows,
    });
  }
  if (req.body.mode !== "import") return res.status(400).json({ error: "Review the workbook before importing it." });

  const result = await db.transaction(async () => {
    let company = await db.prepare(`
      SELECT id, name, is_active AS isActive FROM companies
      WHERE lower(name) IN ('steel center', 'steel')
      ORDER BY CASE lower(name) WHEN 'steel center' THEN 0 ELSE 1 END
      LIMIT 1
    `).get();
    if (!company) {
      company = await db.prepare(`
        INSERT INTO companies (name, slug, is_active) VALUES ('Steel Center', 'steel-center', 1)
        ON CONFLICT (name) DO NOTHING
        RETURNING id, name, is_active AS isActive
      `).get();
    }
    if (!company) throw new Error("Could not prepare the Steel Center company for import.");
    if (company.isActive === 0) throw new Error("Steel Center is disabled. Enable the company before importing historical tickets.");
    const matches = await historicalAccountMatches(company.id, parsed.tickets);

    let inserted = 0;
    let updated = 0;
    let linkedClientTickets = 0;
    let assignedConsultantTickets = 0;
    for (const [index, ticket] of parsed.tickets.entries()) {
      const existing = await db.prepare("SELECT id FROM tickets WHERE import_key = ?").get(ticket.importKey);
      const customerId = matches[index].customer?.id || null;
      const assigneeId = matches[index].consultant?.id || null;
      const reporterLabel = ticket.reporterType === "consultant" ? `Consultant-raised: ${ticket.reporterName}` : ticket.reporterName;
      const customFields = JSON.stringify({
        importSource: ticket.sourceSheet,
        sourceRow: String(ticket.sourceRow),
        reporterType: ticket.reporterType,
        reporterName: ticket.reporterName,
        reporterMobile: ticket.reporterContact,
      });
      await db.prepare(`
        INSERT INTO tickets (
          subject, description, status, priority, customer_id, company_id, assignee_id, source,
          category, tags_json, custom_fields_json, resolved_at, created_at, updated_at,
          reported_client_name, reported_client_contact, historical_solution,
          historical_consultant_name, import_key
        ) VALUES (?, ?, 'resolved', 'normal', ?, ?, ?, 'portal', 'Other', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (import_key) DO UPDATE SET
          subject = EXCLUDED.subject,
          description = EXCLUDED.description,
          status = 'resolved',
          priority = 'normal',
          customer_id = EXCLUDED.customer_id,
          company_id = EXCLUDED.company_id,
          assignee_id = EXCLUDED.assignee_id,
          source = 'portal',
          category = 'Other',
          tags_json = '[]',
          custom_fields_json = EXCLUDED.custom_fields_json,
          resolved_at = EXCLUDED.resolved_at,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          reported_client_name = EXCLUDED.reported_client_name,
          reported_client_contact = EXCLUDED.reported_client_contact,
          historical_solution = EXCLUDED.historical_solution,
          historical_consultant_name = EXCLUDED.historical_consultant_name
      `).run(
        ticket.issue.replace(/\s+/g, " ").slice(0, 120), ticket.issue,
        customerId, company.id, assigneeId, customFields,
        `${ticket.closedAt} 00:00:00`, `${ticket.openedAt} 00:00:00`, `${ticket.closedAt} 00:00:00`,
        reporterLabel, ticket.reporterContact || null, ticket.solution || null,
        ticket.reporterType === "consultant" ? ticket.reporterName : null, ticket.importKey,
      );
      if (existing) updated += 1;
      else inserted += 1;
      if (customerId) linkedClientTickets += 1;
      if (assigneeId) {
        assignedConsultantTickets += 1;
        const importedTicket = await db.prepare("SELECT id FROM tickets WHERE import_key = ?").get(ticket.importKey);
        await db.prepare(`
          INSERT INTO ticket_assignment_history (ticket_id, agent_id, source, created_at)
          SELECT ?, ?, 'historical_import', ?
          WHERE NOT EXISTS (
            SELECT 1 FROM ticket_assignment_history
            WHERE ticket_id = ? AND agent_id = ? AND source = 'historical_import'
          )
        `).run(importedTicket.id, assigneeId, `${ticket.openedAt} 00:00:00`, importedTicket.id, assigneeId);
      }
    }
    return { company, inserted, updated, linkedClientTickets, assignedConsultantTickets };
  })();

  res.status(200).json({
    companyName: result.company.name,
    imported: result.inserted,
    updated: result.updated,
    linkedClientTickets: result.linkedClientTickets,
    assignedConsultantTickets: result.assignedConsultantTickets,
    skipped: parsed.skippedRows,
  });
});

app.get("/api/admin/client-accounts", requireAuth, requireAdmin, async (_req, res) => {
  const clients = await db.prepare(`
    SELECT u.id, u.name, u.username, u.email, u.contact_number AS contactNumber,
           COALESCE(json_agg(json_build_object('id', c.id, 'name', c.name)) FILTER (WHERE c.id IS NOT NULL), '[]') AS companies
    FROM users u
    LEFT JOIN company_memberships m ON m.user_id = u.id
    LEFT JOIN companies c ON c.id = m.company_id AND c.is_active = 1
    WHERE u.role = 'customer' AND u.approval_status = 'approved' AND u.disabled_at IS NULL
    GROUP BY u.id ORDER BY u.name, u.email
  `).all();
  res.json({ clients });
});

app.post("/api/admin/companies/:id/clients", requireAuth, requireAdmin, async (req, res) => {
  const companyId = Number(req.params.id);
  const userId = Number(req.body.userId);
  if (!Number.isInteger(companyId) || companyId < 1 || !Number.isInteger(userId) || userId < 1) {
    return res.status(400).json({ error: "Choose a valid company and client account." });
  }
  const company = await db.prepare("SELECT id, name FROM companies WHERE id = ? AND is_active = 1").get(companyId);
  if (!company) return res.status(404).json({ error: "Company not found or inactive." });
  const client = await db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'customer' AND approval_status = 'approved' AND disabled_at IS NULL").get(userId);
  if (!client) return res.status(404).json({ error: "Active client account not found." });
  if (await clientUsernameExistsInCompany(client.username, companyId, userId)) {
    return res.status(409).json({ error: "A client with this username already exists in that company." });
  }
  try {
    await db.prepare("INSERT INTO company_memberships (user_id, company_id, is_company_admin) VALUES (?, ?, 0)").run(userId, companyId);
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "This client already belongs to that company." });
    throw error;
  }
  res.status(201).json({ message: `${client.name} can now access ${company.name}.` });
});

app.post("/api/admin/companies", requireAuth, requireAdmin, async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const adminName = typeof req.body.adminName === "string" ? req.body.adminName.trim() : "";
  const adminUsername = normalizeUsername(req.body.adminUsername);
  const adminEmail = optionalEmail(req.body.adminEmail);
  const adminPassword = typeof req.body.adminPassword === "string" ? req.body.adminPassword : "";
  const adminContactNumber = optionalContactNumber(req.body.adminContactNumber);
  const supportValidUntil = req.body.supportValidUntil;
  const domainInput = typeof req.body.domain === "string" ? req.body.domain.trim().toLowerCase().replace(/^@/, "") : "";
  if (name.length < 2 || name.length > 120) return res.status(400).json({ error: "Company name must be between 2 and 120 characters." });
  if (adminName.length < 2 || adminName.length > 100) return res.status(400).json({ error: "Enter the first company administrator's name." });
  if (!validUsername(adminUsername)) return res.status(400).json({ error: "Administrator username must be 3–32 characters and use letters, numbers, dots, underscores, or hyphens." });
  if (adminEmail === false) return res.status(400).json({ error: "Enter a valid email address or leave it blank." });
  if (adminPassword.length < 8 || adminPassword.length > 128) return res.status(400).json({ error: "Set an initial password between 8 and 128 characters." });
  if (!adminContactNumber) return res.status(400).json({ error: "Enter the first company administrator's valid mobile number (7 to 15 digits)." });
  if (!validDateOnly(supportValidUntil)) return res.status(400).json({ error: "Enter a valid Support valid until date." });
  if (domainInput && (!/^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domainInput))) {
    return res.status(400).json({ error: "Enter a valid company email domain, or leave it blank." });
  }
  if (adminEmail && await db.prepare("SELECT 1 FROM users WHERE lower(email) = ?").get(adminEmail)) return res.status(409).json({ error: "An account with this email already exists." });
  const slug = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
  if (!slug) return res.status(400).json({ error: "Company name must contain at least one letter or number." });
  let companyId;
  let adminUserId;
  try {
    const created = db.transaction(async () => {
      const company = await db.prepare("INSERT INTO companies (name, slug, domain, support_valid_until) VALUES (?, ?, ?, ?)")
        .run(name, slug, domainInput || null, supportValidUntil);
      const companyIdValue = Number(company.lastInsertRowid);
      const admin = await db.prepare(`
        INSERT INTO users (name, username, email, contact_number, password_hash, role, company_id, is_company_admin, approval_status)
        VALUES (?, ?, ?, ?, ?, 'customer', ?, 1, 'approved') RETURNING id
      `).run(adminName, adminUsername, adminEmail, adminContactNumber, bcrypt.hashSync(adminPassword, 12), companyIdValue);
      await db.prepare("INSERT INTO company_memberships (user_id, company_id, is_company_admin) VALUES (?, ?, 1)")
        .run(admin.lastInsertRowid, companyIdValue);
      return { companyId: companyIdValue, adminUserId: Number(admin.lastInsertRowid) };
    });
    ({ companyId, adminUserId } = await created());
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "That company name, email domain, or administrator username is already in use." });
    }
    throw error;
  }
  res.status(201).json({
    company: await db.prepare("SELECT id, name, domain, support_valid_until AS supportValidUntil FROM companies WHERE id = ?").get(companyId),
    administrator: await db.prepare("SELECT id, name, username FROM users WHERE id = ?").get(adminUserId),
  });
});

app.patch("/api/admin/companies/:id/support-valid-until", requireAuth, requireAdmin, async (req, res) => {
  const companyId = Number(req.params.id);
  const supportValidUntil = req.body.supportValidUntil;
  if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error: "Choose a valid company." });
  if (!validDateOnly(supportValidUntil)) return res.status(400).json({ error: "Enter a valid Support valid until date." });
  const updated = await db.prepare("UPDATE companies SET support_valid_until = ? WHERE id = ?").run(supportValidUntil, companyId);
  if (updated.changes !== 1) return res.status(404).json({ error: "Company not found." });
  res.json({ company: await db.prepare("SELECT id, name, support_valid_until AS supportValidUntil FROM companies WHERE id = ?").get(companyId) });
});

app.post("/api/company/users", requireAuth, requireCompanyAdmin, async (req, res) => {
  if (req.user.role !== "customer") return res.status(403).json({ error: "Client accounts must be created by a company administrator in the client portal." });
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const username = normalizeUsername(req.body.username);
  const email = optionalEmail(req.body.email);
  const contactNumber = optionalContactNumber(req.body.contactNumber);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Name must be between 2 and 100 characters." });
  if (!validUsername(username)) return res.status(400).json({ error: "Username must be 3–32 characters and use letters, numbers, dots, underscores, or hyphens." });
  if (email === false) return res.status(400).json({ error: "Enter a valid email address or leave it blank." });
  if (!contactNumber) return res.status(400).json({ error: "Enter a valid mobile number (7 to 15 digits)." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Password must be between 8 and 128 characters." });
  const company = await db.prepare("SELECT id, name FROM companies WHERE id = ? AND is_active = 1").get(req.user.company_id);
  if (!company) return res.status(404).json({ error: "Company not found or inactive." });
  if (await clientUsernameExistsInCompany(username, company.id)) {
    return res.status(409).json({ error: "That username is already in use in this company." });
  }
  if (email && await db.prepare("SELECT 1 FROM users WHERE lower(email) = ?").get(email)) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }
  try {
    const created = await db.prepare(`
      INSERT INTO users (name, username, email, contact_number, password_hash, role, company_id, approval_status)
      VALUES (?, ?, ?, ?, ?, 'customer', ?, 'approved') RETURNING id
    `).run(name, username, email, contactNumber, bcrypt.hashSync(password, 12), company.id);
    await db.prepare("INSERT INTO company_memberships (user_id, company_id, is_company_admin) VALUES (?, ?, 0)").run(created.lastInsertRowid, company.id);
    const user = await db.prepare(`
      SELECT id, name, username, email, contact_number AS contactNumber, is_company_admin AS isCompanyAdmin,
             approval_status AS approvalStatus, disabled_at AS disabledAt, created_at AS createdAt
      FROM users WHERE id = ?
    `).get(created.lastInsertRowid);
    return res.status(201).json({ user, companyName: company.name });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That username or email address is already in use." });
    throw error;
  }
});

app.get("/api/company/users", requireAuth, requireCompanyAdmin, async (req, res) => {
  const requestedCompanyId = Number(req.query.companyId);
  const companyId = req.user.role === "agent" && req.user.is_admin ? requestedCompanyId : req.user.company_id;
  if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error: "Choose a company." });
  const company = await db.prepare("SELECT id, name FROM companies WHERE id = ?").get(companyId);
  if (!company) return res.status(404).json({ error: "Company not found." });
  const users = await db.prepare(`
    SELECT u.id, u.name, u.username, u.email, u.contact_number AS contactNumber, m.is_company_admin AS isCompanyAdmin,
           m.is_internal_consultant AS isInternalConsultant, m.internal_routing_priority AS internalRoutingPriority,
           u.approval_status AS approvalStatus, u.disabled_at AS disabledAt, u.created_at AS createdAt
    FROM users u JOIN company_memberships m ON m.user_id = u.id
    WHERE m.company_id = ? AND u.role = 'customer'
    ORDER BY u.approval_status = 'pending' DESC, m.is_internal_consultant DESC, m.internal_routing_priority ASC, u.name
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
      ...(!emailIsConfigured() ? { invitationUrl } : {}),
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
  const companyId = req.user.role === "customer" ? req.user.company_id : Number(req.body.companyId);
  const user = await db.prepare(`
    SELECT u.id, u.approval_status, u.disabled_at, m.is_company_admin
    FROM users u JOIN company_memberships m ON m.user_id = u.id AND m.company_id = ?
    WHERE u.id = ? AND u.role = 'customer'
  `).get(companyId, userId);
  if (!user) return res.status(404).json({ error: "Client user not found." });
  const isWorkspaceAdmin = req.user.role === "agent" && req.user.is_admin;
  if (!isWorkspaceAdmin && companyId !== req.user.company_id) return res.status(404).json({ error: "Client user not found." });
  const updates = [];
  const values = [];
  let membershipChanged = false;
  if (req.body.name !== undefined) {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (name.length < 2 || name.length > 100) return res.status(400).json({ error: "Name must be between 2 and 100 characters." });
    updates.push("name = ?");
    values.push(name);
  }
  if (req.body.email !== undefined) {
    const email = optionalEmail(req.body.email);
    if (email === false) return res.status(400).json({ error: "Enter a valid email address or leave it blank." });
    if (email && await db.prepare("SELECT 1 FROM users WHERE lower(email) = ? AND id <> ?").get(email, userId)) {
      return res.status(409).json({ error: "That email address is already in use." });
    }
    updates.push("email = ?");
    values.push(email);
  }
  if (req.body.contactNumber !== undefined) {
    const contactNumber = optionalContactNumber(req.body.contactNumber);
    if (!contactNumber) return res.status(400).json({ error: "Enter a valid mobile number (7 to 15 digits)." });
    updates.push("contact_number = ?");
    values.push(contactNumber);
  }
  if (req.body.password !== undefined) {
    if (typeof req.body.password !== "string" || req.body.password.length < 8 || req.body.password.length > 128) {
      return res.status(400).json({ error: "Set a password between 8 and 128 characters." });
    }
    updates.push("password_hash = ?");
    values.push(bcrypt.hashSync(req.body.password, 12));
  }
  if (req.body.approvalStatus !== undefined) {
    if (!["approved", "rejected"].includes(req.body.approvalStatus)) return res.status(400).json({ error: "Choose approved or rejected enrollment status." });
    updates.push("approval_status = ?");
    values.push(req.body.approvalStatus);
  }
  if (req.body.isCompanyAdmin !== undefined) {
    if (typeof req.body.isCompanyAdmin !== "boolean") return res.status(400).json({ error: "Company administrator setting must be true or false." });
    if (req.body.isCompanyAdmin !== Boolean(user.is_company_admin) && req.body.isCompanyAdmin === false) {
      const adminCount = (await db.prepare("SELECT COUNT(*) AS count FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? AND m.is_company_admin = 1 AND u.approval_status = 'approved' AND u.disabled_at IS NULL").get(companyId)).count;
      if (user.is_company_admin && adminCount <= 1) return res.status(400).json({ error: "The last active company administrator cannot be removed." });
      await db.prepare("UPDATE company_memberships SET is_company_admin = 0 WHERE user_id = ? AND company_id = ?").run(userId, companyId);
      membershipChanged = true;
    }
    if (req.body.isCompanyAdmin && !user.is_company_admin) {
      await db.prepare("UPDATE company_memberships SET is_company_admin = 1 WHERE user_id = ? AND company_id = ?").run(userId, companyId);
      membershipChanged = true;
    }
  }
  if (req.body.isInternalConsultant !== undefined) {
    if (typeof req.body.isInternalConsultant !== "boolean") return res.status(400).json({ error: "Internal Consultant setting must be true or false." });
    const isInternal = req.body.isInternalConsultant;
    let pri = Number(req.body.internalRoutingPriority) || 0;
    if (isInternal && pri < 1) {
      const maxPri = (await db.prepare("SELECT COALESCE(MAX(internal_routing_priority), 0) AS max_pri FROM company_memberships WHERE company_id = ? AND is_internal_consultant = 1").get(companyId))?.max_pri || 0;
      pri = maxPri + 1;
    } else if (!isInternal) {
      pri = 0;
    }
    await db.prepare("UPDATE company_memberships SET is_internal_consultant = ?, internal_routing_priority = ? WHERE user_id = ? AND company_id = ?")
      .run(isInternal ? 1 : 0, pri, userId, companyId);
    await db.prepare("UPDATE users SET is_internal_consultant = ?, internal_routing_priority = ? WHERE id = ? AND company_id = ?")
      .run(isInternal ? 1 : 0, pri, userId, companyId);
    await normalizeCompanyInternalPriorities(companyId);
    membershipChanged = true;
  }
  if (req.body.internalRoutingPriority !== undefined && req.body.isInternalConsultant === undefined) {
    const pri = Math.max(1, Number(req.body.internalRoutingPriority) || 1);
    await db.prepare("UPDATE company_memberships SET internal_routing_priority = ? WHERE user_id = ? AND company_id = ?")
      .run(pri, userId, companyId);
    await db.prepare("UPDATE users SET internal_routing_priority = ? WHERE id = ? AND company_id = ?")
      .run(pri, userId, companyId);
    await normalizeCompanyInternalPriorities(companyId);
    membershipChanged = true;
  }
  if (req.body.disabled !== undefined) {
    if (typeof req.body.disabled !== "boolean") return res.status(400).json({ error: "Disabled setting must be true or false." });
    if (req.body.disabled && user.is_company_admin) {
      const adminCount = (await db.prepare("SELECT COUNT(*) AS count FROM company_memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? AND m.is_company_admin = 1 AND u.approval_status = 'approved' AND u.disabled_at IS NULL").get(companyId)).count;
      if (adminCount <= 1) return res.status(400).json({ error: "The last active company administrator cannot be disabled." });
    }
    updates.push("disabled_at = ?");
    values.push(req.body.disabled ? new Date().toISOString() : null);
  }
  if (updates.length === 0 && !membershipChanged) return res.status(400).json({ error: "Choose an account setting to update." });
  values.push(userId);
  if (updates.length) {
    try {
      await db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "That email address is already in use." });
      throw error;
    }
  }
  await db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND kind = ?")
    .run(req.user.id, `company_join_request:${userId}`);
  const updatedUser = await db.prepare(`
    SELECT u.id, u.name, u.username, u.email, u.contact_number AS contactNumber,
           m.is_company_admin AS isCompanyAdmin,
           m.is_internal_consultant AS isInternalConsultant,
           m.internal_routing_priority AS internalRoutingPriority,
           u.approval_status AS approvalStatus, u.disabled_at AS disabledAt
    FROM users u JOIN company_memberships m ON m.user_id = u.id AND m.company_id = ? WHERE u.id = ?
  `).get(companyId, userId);
  res.json({ user: updatedUser });
});

app.get("/api/notifications", requireAuth, async (req, res) => {
  const notifications = await db.prepare(`
    SELECT n.id, n.ticket_id AS ticketId, n.kind, n.message, n.read_at AS readAt, n.created_at AS createdAt,
           t.subject, t.description, t.category, t.priority, customer.name AS customerName,
           t.company_id AS companyId, co.name AS companyName, t.company_ticket_seq AS companyTicketSeq,
           (
             SELECT u.username FROM users u
             JOIN company_memberships cm ON cm.user_id = u.id
             WHERE cm.company_id = t.company_id AND cm.is_company_admin = 1
             ORDER BY u.id ASC LIMIT 1
           ) AS companyAdminUsername
    FROM notifications n
    LEFT JOIN tickets t ON t.id = n.ticket_id
    LEFT JOIN companies co ON co.id = t.company_id
    LEFT JOIN users customer ON customer.id = t.customer_id
    WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 50
  `).all(req.user.id);
  const formattedNotifications = notifications.map((n) => ({
    ...n,
    ticketNumber: formatCompanyTicketNumber({
      companyId: n.companyId,
      companyName: n.companyName,
      adminUsername: n.companyAdminUsername,
      companyTicketSeq: n.companyTicketSeq,
      ticketId: n.ticketId,
    }),
  }));
  res.json({ notifications: formattedNotifications, unreadCount: notifications.filter((notification) => !notification.readAt).length });
});

app.post("/api/notifications/read", requireAuth, async (req, res) => {
  const id = Number(req.body.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid notification id." });
  await db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(id, req.user.id);
  res.status(204).end();
});

async function getTicketMessages(ticketId, userRole, ticket, attachments) {
  const attachmentsByMessage = new Map();
  for (const att of attachments) {
    if (att.messageId) {
      const list = attachmentsByMessage.get(att.messageId) || [];
      list.push(att);
      attachmentsByMessage.set(att.messageId, list);
    }
  }

  const rawMessages = (await db.prepare(`
    SELECT m.id, m.body, m.is_internal AS isInternal, m.created_at AS createdAt, m.edited_at AS editedAt,
           COALESCE(m.is_solution, 0) AS isSolution,
           u.id AS authorId, u.name AS authorName, u.role AS authorRole,
           COALESCE(u.is_internal_consultant, 0) AS authorIsInternalConsultant
    FROM messages m JOIN users u ON u.id = m.author_id
    WHERE m.ticket_id = ? AND (? = 1 OR m.is_internal = 0) ORDER BY m.id
  `).all(ticketId, userRole === "agent" ? 1 : 0)
  ).map((message) => ({
    ...message,
    isInternal: Boolean(message.isInternal),
    isSolution: Boolean(message.isSolution),
    authorIsInternalConsultant: Boolean(message.authorIsInternalConsultant),
    attachments: attachmentsByMessage.get(message.id) || [],
  }));

  const messages = [...rawMessages];
  if (ticket.import_key) {
    const consultantRaised = Boolean(ticket.historical_consultant_name);
    messages.unshift({
      id: 0,
      body: ticket.description,
      isInternal: false,
      isSolution: false,
      createdAt: ticket.created_at,
      authorId: consultantRaised ? ticket.assignee_id || null : null,
      authorName: consultantRaised
        ? ticket.assignee_name || ticket.historical_consultant_name
        : ticket.reported_client_name || "Client",
      authorRole: consultantRaised ? "agent" : "customer",
      attachments: attachments.filter((att) => !att.messageId && !att.isSolution),
    });
  } else if (messages.length > 0) {
    const unlinkedAttachments = attachments.filter((att) => !att.messageId && !att.isSolution);
    if (unlinkedAttachments.length > 0 && (!messages[0].attachments || messages[0].attachments.length === 0)) {
      messages[0].attachments = unlinkedAttachments;
    }
  }

  if (ticket.historical_solution && !messages.some((m) => m.isSolution)) {
    const solutionAttachments = attachments.filter((att) => Boolean(att.isSolution) && !att.messageId);
    messages.push({
      id: -1,
      body: ticket.historical_solution,
      isInternal: false,
      isSolution: true,
      createdAt: ticket.resolved_at || ticket.updated_at || ticket.created_at,
      editedAt: null,
      authorId: ticket.resolved_by || ticket.assignee_id || null,
      authorName: ticket.historical_consultant_name || ticket.assignee_name || "Consultant",
      authorRole: "agent",
      authorIsInternalConsultant: false,
      attachments: solutionAttachments,
    });
  }

  return messages;
}

app.get("/api/tickets/:id", requireAuth, async (req, res) => {
  const ticketId = Number(req.params.id);
  if (!Number.isInteger(ticketId) || ticketId < 1) return res.status(400).json({ error: "Invalid ticket id." });
  if (!await canAccessTicket(req.user, ticketId)) return res.status(404).json({ error: "Ticket not found." });

  const ticket = await db.prepare(`${ticketSelect} WHERE t.id = ?`).get(ticketId);
  if (!ticket) return res.status(404).json({ error: "Ticket not found." });
  const attachments = await db.prepare(`
    SELECT id, original_name AS name, mime_type AS mimeType, size_bytes AS sizeBytes,
           created_at AS createdAt, uploaded_by AS uploadedBy, message_id AS messageId,
           COALESCE(is_solution, 0) AS isSolution
    FROM ticket_attachments WHERE ticket_id = ? ORDER BY id
  `).all(ticketId);

  const messages = await getTicketMessages(ticketId, req.user.role, ticket, attachments);
  const assignmentHistory = req.user.role === "agent" || req.user.is_company_admin || req.user.is_internal_consultant || ticket.assignee_id === req.user.id
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
  attachmentUpload.array("attachments", 10)(req, res, (error) => {
    if (!error) return next();
    const message = error instanceof multer.MulterError
      ? error.code === "LIMIT_FILE_SIZE"
        ? "Each attachment must be 25 MB or smaller."
        : error.code === "LIMIT_FILE_COUNT"
          ? "Attach up to 10 files."
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
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(attachment.original_name)}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(resolve(attachmentsRoot, attachment.storage_name), (error) => {
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
  if (metadata.error || !["Functional", "Technical"].includes(metadata.category)) {
    discardUploadedFiles(req.files);
    return res.status(400).json({ error: metadata.error || "Choose Functional or Technical as the ticket category." });
  }

  let customerId = req.user.id;
  let companyId = req.user.company_id;
  if (req.user.role === "agent") {
    // Older deployed forms submit the combined "companyId:customerId" value
    // under customerId. Accept that format as well as the current separate fields.
    const rawCustomerSelection = String(req.body.customerId ?? "");
    const [selectedCompanyId, selectedCustomerId] = rawCustomerSelection.includes(":")
      ? rawCustomerSelection.split(":", 2)
      : ["", rawCustomerSelection];
    customerId = Number(selectedCustomerId);
    if (!Number.isInteger(customerId) || customerId < 1) {
      discardUploadedFiles(req.files);
      return res.status(400).json({ error: "Choose a customer for this ticket." });
    }
    const requestedCompanyId = Number(req.body.companyId || selectedCompanyId);
    const customer = Number.isInteger(requestedCompanyId) && requestedCompanyId > 0
      ? await db.prepare(`
        SELECT u.id, m.company_id FROM users u JOIN company_memberships m ON m.user_id = u.id
        WHERE u.id = ? AND m.company_id = ? AND u.role = 'customer' AND u.approval_status = 'approved' AND u.disabled_at IS NULL
      `).get(customerId, requestedCompanyId)
      : null;
    if (!customer) {
      discardUploadedFiles(req.files);
      return res.status(400).json({ error: "Choose a valid customer." });
    }
    companyId = customer.company_id;
  }
  if (req.user.role === "customer") {
    const company = await db.prepare("SELECT support_valid_until AS supportValidUntil FROM companies WHERE id = ? AND is_active = 1").get(companyId);
    if (supportContractExpired(company?.supportValidUntil)) {
      discardUploadedFiles(req.files);
      return res.status(403).json({
        error: "Please Renewal Your Support Contract",
        code: "SUPPORT_CONTRACT_EXPIRED",
      });
    }
  }
  const requestedAssignee = req.body.assigneeId === "" || req.body.assigneeId === undefined ? null : Number(req.body.assigneeId);
  if (requestedAssignee !== null && (!Number.isInteger(requestedAssignee) || requestedAssignee < 1)) {
    discardUploadedFiles(req.files);
    return res.status(400).json({ error: "Choose a valid Consultant." });
  }
  const requestedAgent = requestedAssignee === null ? null : await db.prepare("SELECT id, specialty FROM users WHERE id = ? AND role = 'agent' AND disabled_at IS NULL").get(requestedAssignee);
  if (requestedAssignee !== null && !requestedAgent) {
    discardUploadedFiles(req.files);
    return res.status(400).json({ error: "Choose an active Consultant." });
  }
  const ticketSpecialty = metadata.category.toLowerCase();
  if (req.user.role === "customer" && requestedAgent && requestedAgent.specialty !== "both" && requestedAgent.specialty !== ticketSpecialty) {
    discardUploadedFiles(req.files);
    return res.status(400).json({ error: "Choose a Consultant who supports the selected ticket category." });
  }
  const companyRecord = await db.prepare("SELECT internal_consultant_id FROM companies WHERE id = ?").get(companyId);
  const isCreatorInternalConsultant = Boolean(
    req.user.role === "customer" && (
      req.user.is_internal_consultant ||
      (companyRecord?.internal_consultant_id && Number(companyRecord.internal_consultant_id) === Number(req.user.id)) ||
      (await db.prepare("SELECT 1 FROM company_memberships WHERE user_id = ? AND company_id = ? AND is_internal_consultant = 1").get(req.user.id, companyId))
    )
  );
  const companyHasInternal = await companyHasInternalConsultants(companyId);

  const routingPreference = req.body.routingPreference === "external" ? "external" : (req.body.routingPreference === "internal" ? "internal" : null);

  let agent;
  let assignmentSource;
  if (req.user.role === "agent") {
    agent = { id: req.user.id };
    assignmentSource = "agent_created";
  } else if (companyHasInternal && routingPreference === "internal") {
    let internalConsultant = await selectInternalConsultant(companyId, isCreatorInternalConsultant ? req.user.id : null);
    if (!internalConsultant && !isCreatorInternalConsultant) {
      internalConsultant = await selectInternalConsultant(companyId);
    }
    if (internalConsultant) {
      agent = { id: internalConsultant.id };
      assignmentSource = "internal_consultant_auto";
    } else {
      agent = await selectRoutingAgent(metadata.category);
      assignmentSource = "external_consultant_auto";
    }
  } else if (companyHasInternal && routingPreference === "external") {
    agent = await selectRoutingAgent(metadata.category);
    assignmentSource = "external_consultant_priority";
  } else if (isCreatorInternalConsultant) {
    // Internal consultant raising a ticket without preference routes to external consultant in priority order
    agent = await selectRoutingAgent(metadata.category);
    assignmentSource = "external_consultant_auto";
  } else if (companyHasInternal) {
    const internalConsultant = await selectInternalConsultant(companyId);
    if (internalConsultant) {
      agent = { id: internalConsultant.id };
      assignmentSource = "internal_consultant_auto";
    } else {
      agent = await selectRoutingAgent(metadata.category);
      assignmentSource = "automatic";
    }
  } else if (requestedAssignee) {
    agent = { id: requestedAssignee };
    assignmentSource = "client_selected";
  } else {
    agent = await selectRoutingAgent(metadata.category);
    assignmentSource = "automatic";
  }
  const files = req.files || [];
  let verifiedFiles = [];
  try {
    verifiedFiles = await verifyTicketFiles(files);
  } catch (error) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: error.message });
  }

  let id;
  try {
    const createTicket = db.transaction(async () => {
      let companyTicketSeq = null;
      if (companyId) {
        const seqRow = await db.prepare("SELECT COALESCE(MAX(company_ticket_seq), 0) AS max_seq FROM tickets WHERE company_id = ?").get(companyId);
        companyTicketSeq = Number(seqRow?.max_seq || 0) + 1;
      }
      const tatCfg = await tatConfiguration();
      const priorityKey = (priority || "normal").toLowerCase();
      const priorityHours = tatCfg.priorityHours[priorityKey] || 8;
      const tatDurationMinutes = priorityHours * 60;
      const holidays = await getActiveHolidayDates();
      const now = new Date();
      const tatStartAt = getValidTATStartTime(now, holidays, tatCfg.startHour, tatCfg.endHour)?.toISOString();
      const tatDueAt = calculateTATDeadline(now, tatDurationMinutes, holidays, tatCfg.startHour, tatCfg.endHour)?.toISOString();

      const result = await db.prepare(`
        INSERT INTO tickets (
          subject, description, priority, category, tags_json, custom_fields_json,
          customer_id, company_id, assignee_id, company_ticket_seq,
          tat_start_at, tat_duration_minutes, tat_due_at, tat_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'within_tat')
      `).run(
        subject, description, priority, metadata.category, JSON.stringify(metadata.tags),
        JSON.stringify(metadata.customFields), customerId, companyId || null, agent?.id || null, companyTicketSeq,
        tatStartAt, tatDurationMinutes, tatDueAt,
      );
      const ticketId = Number(result.lastInsertRowid);
      const initialMsg = await db.prepare("INSERT INTO messages (ticket_id, author_id, body) VALUES (?, ?, ?)")
        .run(ticketId, req.user.id, description);
      const initialMessageId = Number(initialMsg.lastInsertRowid);
      await recordTicketAssignment(ticketId, agent?.id, req.user.id, assignmentSource);
      if (req.user.role === "customer" && agent?.id) {
        const customer = await db.prepare("SELECT name FROM users WHERE id = ?").get(customerId);
        await db.prepare(`
          INSERT INTO notifications (user_id, ticket_id, kind, message)
          VALUES (?, ?, 'ticket_created', ?)
          ON CONFLICT (user_id, ticket_id, kind) DO NOTHING
        `).run(agent.id, ticketId, `New ticket from ${customer?.name || "a customer"}: ${priority} priority · ${metadata.category} · ${subject}`);
      }
      if (verifiedFiles.length > 0) {
        const insertAttachment = db.prepare(`
          INSERT INTO ticket_attachments (ticket_id, uploaded_by, storage_name, original_name, mime_type, size_bytes, message_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const file of verifiedFiles) {
          await insertAttachment.run(ticketId, req.user.id, file.filename, file.originalName, file.mimeType, file.size, initialMessageId);
        }
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

app.post("/api/tickets/:id/messages", requireAuth, receiveAttachments, async (req, res) => {
  const ticketId = Number(req.params.id);
  const files = req.files || [];
  let body = typeof req.body.body === "string" ? req.body.body.trim() : "";
  const isInternal = req.body.internal === true || req.body.internal === "true" || req.body.internal === "1";
  if (!Number.isInteger(ticketId) || ticketId < 1) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: "Invalid ticket id." });
  }
  if (!await canAccessTicket(req.user, ticketId)) {
    discardUploadedFiles(files);
    return res.status(404).json({ error: "Ticket not found." });
  }
  if (isInternal && req.user.role !== "agent") {
    discardUploadedFiles(files);
    return res.status(403).json({ error: "Internal notes are only available to Consultants." });
  }
  if (!body && files.length > 0) {
    body = `Attached ${files.length} file${files.length > 1 ? "s" : ""}.`;
  }
  if (body.length < 1 || body.length > 5000) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: "Reply must be between 1 and 5,000 characters." });
  }
  const ticket = await db.prepare(`
    SELECT t.status, t.first_response_at, t.email_thread_id, t.subject, t.customer_id, t.company_id, t.assignee_id, c.email AS customer_email
    FROM tickets t LEFT JOIN users c ON c.id = t.customer_id WHERE t.id = ?
  `).get(ticketId);
  if (!ticket) {
    discardUploadedFiles(files);
    return res.status(404).json({ error: "Ticket not found." });
  }
  const companyRecord = await db.prepare("SELECT internal_consultant_id FROM companies WHERE id = ?").get(ticket.company_id);
  const isInternalUser = Boolean(
    req.user.is_internal_consultant ||
    (companyRecord?.internal_consultant_id && Number(companyRecord.internal_consultant_id) === Number(req.user.id)) ||
    Number(ticket.assignee_id) === Number(req.user.id)
  );
  if (req.user.role === "customer" && ticket.customer_id !== req.user.id && !req.user.is_company_admin && !isInternalUser) {
    discardUploadedFiles(files);
    return res.status(403).json({ error: "Only the ticket creator, internal consultant, or a company administrator can reply to this ticket." });
  }

  let verifiedFiles = [];
  try {
    verifiedFiles = await verifyTicketFiles(files);
  } catch (error) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: error.message });
  }

  const insertMessage = db.transaction(async () => {
    const emailMessageId = !isInternal && req.user.role !== "customer" && emailIsConfigured() && ticket.customer_email
      ? `<${randomUUID()}@${process.env.SMTP_MESSAGE_ID_DOMAIN || "support.jishnuinfotech.com"}>`
      : null;
    const result = await db.prepare("INSERT INTO messages (ticket_id, author_id, body, is_internal, email_message_id) VALUES (?, ?, ?, ?, ?)")
      .run(ticketId, req.user.id, body, isInternal ? 1 : 0, emailMessageId);
    const messageId = Number(result.lastInsertRowid);

    if (verifiedFiles.length > 0) {
      const insertAttachment = db.prepare(`
        INSERT INTO ticket_attachments (ticket_id, uploaded_by, storage_name, original_name, mime_type, size_bytes, message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const file of verifiedFiles) {
        await insertAttachment.run(ticketId, req.user.id, file.filename, file.originalName, file.mimeType, file.size, messageId);
      }
    }

    await db.prepare("UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ticketId);
    if (!isInternal && req.user.role === "customer" && req.user.id === ticket.customer_id && ticket.status === "resolved") {
      await db.prepare("UPDATE tickets SET status = 'open', resolved_at = NULL, resolved_by = NULL WHERE id = ?").run(ticketId);
    }
    if (!isInternal && req.user.id !== ticket.customer_id && !ticket.first_response_at) {
      await db.prepare("UPDATE tickets SET first_response_at = CURRENT_TIMESTAMP WHERE id = ?").run(ticketId);
    }
    if (emailMessageId) {
      const previous = await db.prepare("SELECT email_message_id FROM messages WHERE ticket_id = ? AND id < ? AND email_message_id IS NOT NULL ORDER BY id DESC LIMIT 1")
        .get(ticketId, messageId);
      const referencesHeader = [...new Set([ticket.email_thread_id, previous?.email_message_id].filter(Boolean))].join(" ");
      await db.prepare("INSERT INTO mail_outbox (recipient, subject, body, message_id, references_header) VALUES (?, ?, ?, ?, ?)")
        .run(
          ticket.customer_email,
          `Re: ${ticket.subject}`,
          body,
          emailMessageId,
          referencesHeader || null,
        );
      await db.prepare("UPDATE messages SET email_message_id = ? WHERE id = ?").run(emailMessageId, messageId);
    }
    return messageId;
  });

  let id;
  try {
    id = await insertMessage();
  } catch (error) {
    discardUploadedFiles(files);
    throw error;
  }
  const messageRow = await db.prepare(`
    SELECT m.id, m.body, m.is_internal AS isInternal, m.created_at AS createdAt, m.edited_at AS editedAt,
           u.id AS authorId, u.name AS authorName, u.role AS authorRole,
           COALESCE(u.is_internal_consultant, 0) AS authorIsInternalConsultant
    FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?
  `).get(id);
  const messageAttachments = await db.prepare(`
    SELECT id, original_name AS name, mime_type AS mimeType, size_bytes AS sizeBytes,
           created_at AS createdAt, uploaded_by AS uploadedBy, message_id AS messageId
    FROM ticket_attachments WHERE message_id = ? ORDER BY id
  `).all(id);
  const message = {
    ...messageRow,
    isInternal: Boolean(messageRow.isInternal),
    authorIsInternalConsultant: Boolean(messageRow.authorIsInternalConsultant),
    attachments: messageAttachments,
  };
  res.status(201).json({ message, emailQueued: !isInternal && req.user.role !== "customer" && Boolean(ticket.customer_email) && emailIsConfigured() });
});

app.patch("/api/tickets/:ticketId/messages/:messageId", requireAuth, receiveAttachments, async (req, res) => {
  const ticketId = Number(req.params.ticketId);
  const messageId = Number(req.params.messageId);
  const files = req.files || [];
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
  if (!Number.isInteger(ticketId) || ticketId < 1 || !Number.isInteger(messageId) || messageId < 1) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: "Invalid ticket or message id." });
  }

  const isConsultant = req.user.role === "agent" || Boolean(req.user.is_internal_consultant || req.user.isInternalConsultant);
  if (!isConsultant) {
    discardUploadedFiles(files);
    return res.status(403).json({ error: "Only consultants can edit chat messages." });
  }

  if (!await canAccessTicket(req.user, ticketId)) {
    discardUploadedFiles(files);
    return res.status(404).json({ error: "Ticket not found." });
  }

  const existing = await db.prepare("SELECT * FROM messages WHERE id = ? AND ticket_id = ?").get(messageId, ticketId);
  if (!existing) {
    discardUploadedFiles(files);
    return res.status(404).json({ error: "Message not found." });
  }

  if (!canEditChatMessage(req.user, existing)) {
    discardUploadedFiles(files);
    return res.status(403).json({ error: "You can only edit consultant messages." });
  }

  let verifiedFiles = [];
  try {
    verifiedFiles = await verifyTicketFiles(files);
  } catch (error) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: error.message });
  }

  if (body.length < 1 && verifiedFiles.length === 0) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: "Message body or attachment is required." });
  }

  if (body.length > 5000) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: "Message must be 5,000 characters or fewer." });
  }

  const newBody = body.length > 0 ? body : existing.body;
  await db.prepare("UPDATE messages SET body = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?").run(newBody, messageId);

  if (existing.is_solution) {
    await db.prepare("UPDATE tickets SET historical_solution = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newBody, ticketId);
  }

  if (verifiedFiles.length > 0) {
    const insertAttachment = db.prepare(`
      INSERT INTO ticket_attachments (ticket_id, uploaded_by, storage_name, original_name, mime_type, size_bytes, message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const file of verifiedFiles) {
      await insertAttachment.run(ticketId, req.user.id, file.filename, file.originalName, file.mimeType, file.size, messageId);
    }
    await db.prepare("UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ticketId);
  }

  const updatedRow = await db.prepare(`
    SELECT m.id, m.body, m.is_internal AS isInternal, m.created_at AS createdAt, m.edited_at AS editedAt,
           COALESCE(m.is_solution, 0) AS isSolution,
           u.id AS authorId, u.name AS authorName, u.role AS authorRole,
           COALESCE(u.is_internal_consultant, 0) AS authorIsInternalConsultant
    FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?
  `).get(messageId);

  const messageAttachments = await db.prepare(`
    SELECT id, original_name AS name, mime_type AS mimeType, size_bytes AS sizeBytes,
           created_at AS createdAt, uploaded_by AS uploadedBy, message_id AS messageId
    FROM ticket_attachments WHERE message_id = ? ORDER BY id
  `).all(messageId);

  const ticketAttachments = await db.prepare(`
    SELECT id, original_name AS name, mime_type AS mimeType, size_bytes AS sizeBytes,
           created_at AS createdAt, uploaded_by AS uploadedBy, message_id AS messageId,
           COALESCE(is_solution, 0) AS isSolution
    FROM ticket_attachments WHERE ticket_id = ? ORDER BY id
  `).all(ticketId);

  res.json({
    message: {
      ...updatedRow,
      isInternal: Boolean(updatedRow.isInternal),
      isSolution: Boolean(updatedRow.isSolution),
      authorIsInternalConsultant: Boolean(updatedRow.authorIsInternalConsultant),
      attachments: messageAttachments,
    },
    ticketAttachments,
  });
});

app.patch("/api/tickets/:id/solution", requireAuth, receiveAttachments, async (req, res) => {
  const ticketId = Number(req.params.id);
  const files = req.files || [];
  if (!Number.isInteger(ticketId) || ticketId < 1) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: "Invalid ticket id." });
  }

  if (!canEditConsultantSolution(req.user)) {
    discardUploadedFiles(files);
    return res.status(403).json({ error: "Only Consultant Super Admins can edit the consultant solution." });
  }

  const existing = await db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId);
  if (!existing || !await canAccessTicket(req.user, ticketId)) {
    discardUploadedFiles(files);
    return res.status(404).json({ error: "Ticket not found." });
  }

  let verifiedFiles = [];
  try {
    verifiedFiles = await verifyTicketFiles(files);
  } catch (error) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: error.message });
  }

  const solution = typeof req.body.solution === "string" ? req.body.solution.trim() : "";
  const consultantName = typeof req.body.consultantName === "string" && req.body.consultantName.trim()
    ? req.body.consultantName.trim()
    : (existing.historical_consultant_name || req.user.name);

  if (solution.length > 5000) {
    discardUploadedFiles(files);
    return res.status(400).json({ error: "Consultant solution must be 5,000 characters or fewer." });
  }

  let removedIds = [];
  if (req.body.removedAttachmentIds) {
    try {
      const parsed = typeof req.body.removedAttachmentIds === "string" ? JSON.parse(req.body.removedAttachmentIds) : req.body.removedAttachmentIds;
      if (Array.isArray(parsed)) removedIds = parsed.map(Number).filter((id) => Number.isInteger(id) && id > 0);
    } catch {}
  }

  try {
    await db.transaction(async () => {
      await db.prepare(`
        UPDATE tickets
        SET historical_solution = ?,
            historical_consultant_name = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(solution || null, solution ? consultantName : null, ticketId);

      if (removedIds.length > 0) {
        for (const attId of removedIds) {
          const att = await db.prepare("SELECT storage_name FROM ticket_attachments WHERE id = ? AND ticket_id = ?").get(attId, ticketId);
          if (att) {
            await db.prepare("DELETE FROM ticket_attachments WHERE id = ? AND ticket_id = ?").run(attId, ticketId);
            try { unlinkSync(resolve(attachmentsRoot, att.storage_name)); } catch {}
          }
        }
      }

      let solutionMessageId = null;
      if (solution) {
        const existingSolutionMsg = await db.prepare(`
          SELECT id FROM messages WHERE ticket_id = ? AND is_solution = 1 ORDER BY id ASC LIMIT 1
        `).get(ticketId);

        if (existingSolutionMsg) {
          solutionMessageId = existingSolutionMsg.id;
          await db.prepare(`
            UPDATE messages
            SET body = ?, edited_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(solution, solutionMessageId);
        } else {
          const inserted = await db.prepare(`
            INSERT INTO messages (ticket_id, author_id, body, is_internal, is_solution, created_at)
            VALUES (?, ?, ?, 0, 1, CURRENT_TIMESTAMP)
            RETURNING id
          `).get(ticketId, req.user.id, solution);
          solutionMessageId = inserted ? inserted.id : null;
        }
      } else {
        const existingSolutionMsg = await db.prepare(`
          SELECT id FROM messages WHERE ticket_id = ? AND is_solution = 1 ORDER BY id ASC LIMIT 1
        `).get(ticketId);
        if (existingSolutionMsg) {
          await db.prepare("DELETE FROM messages WHERE id = ?").run(existingSolutionMsg.id);
        }
      }

      if (verifiedFiles.length > 0) {
        const insertAttachment = db.prepare(`
          INSERT INTO ticket_attachments (ticket_id, uploaded_by, storage_name, original_name, mime_type, size_bytes, is_solution, message_id)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        `);
        for (const file of verifiedFiles) {
          await insertAttachment.run(ticketId, req.user.id, file.filename, file.originalName, file.mimeType, file.size, solutionMessageId);
        }
      }

      if (solutionMessageId) {
        await db.prepare(`
          UPDATE ticket_attachments
          SET message_id = ?
          WHERE ticket_id = ? AND is_solution = 1 AND message_id IS NULL
        `).run(solutionMessageId, ticketId);
      }
    })();
  } catch (error) {
    discardUploadedFiles(files);
    throw error;
  }

  const updatedTicketRow = await db.prepare(`${ticketSelect} WHERE t.id = ?`).get(ticketId);
  const attachments = await db.prepare(`
    SELECT id, original_name AS name, mime_type AS mimeType, size_bytes AS sizeBytes,
           created_at AS createdAt, uploaded_by AS uploadedBy, message_id AS messageId,
           COALESCE(is_solution, 0) AS isSolution
    FROM ticket_attachments WHERE ticket_id = ? ORDER BY id
  `).all(ticketId);

  const messages = await getTicketMessages(ticketId, req.user.role, updatedTicketRow, attachments);

  res.json({
    ticket: await ticketSummary(updatedTicketRow),
    messages,
    attachments,
    message: "Consultant solution updated successfully.",
  });
});

app.patch("/api/tickets/:id", requireAuth, async (req, res) => {
  const ticketId = Number(req.params.id);
  const status = req.body.status;
  const priority = req.body.priority;
  let assigneeId = req.body.assigneeId;
  const transferToExternal = Boolean(req.body.transferToExternal);
  const metadataRequested = ["category", "tags", "customFields"].some((key) => req.body[key] !== undefined);
  if (!Number.isInteger(ticketId) || ticketId < 1) return res.status(400).json({ error: "Invalid ticket id." });
  const existing = await db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId);
  if (!existing || !await canAccessTicket(req.user, ticketId)) return res.status(404).json({ error: "Ticket not found." });
  const company = await db.prepare("SELECT id, internal_consultant_id FROM companies WHERE id = ?").get(existing.company_id);
  const perms = canManageTicket(req.user, existing, company);

  if (transferToExternal) {
    if (!perms.isInternalConsultant && req.user.role !== "agent") {
      return res.status(403).json({ error: "Only an Internal Consultant or Consultant can transfer this ticket to an external consultant." });
    }
    if (req.user.role === "customer" && existing.assignee_id) {
      const currentAssignee = await db.prepare("SELECT role FROM users WHERE id = ?").get(existing.assignee_id);
      if (currentAssignee?.role === "agent") {
        return res.status(400).json({ error: "This ticket is already assigned to an External Consultant." });
      }
    }
    const externalAgent = await selectRoutingAgent(existing.category);
    if (!externalAgent) {
      return res.status(400).json({ error: "No external consultant is currently available to take this ticket." });
    }
    assigneeId = externalAgent.id;
  }

  if (status !== undefined && !perms.canUpdateStatus) {
    return res.status(403).json({ error: "Only Consultants or the Internal Consultant can update ticket status." });
  }
  if (priority !== undefined && !perms.canUpdatePriority) {
    return res.status(403).json({ error: "Only Consultants or the Internal Consultant can update ticket priority." });
  }
  if (assigneeId !== undefined && !perms.canChangeAssignment && !perms.canSwitchToConsultant) {
    return res.status(403).json({ error: "Only a Super Admin, the assigned Consultant, or the Internal Consultant can change this ticket's assignment." });
  }
  if (req.user.role === "customer" && !perms.isInternalConsultant) {
    return res.status(403).json({ error: "Clients can view ticket assignment but cannot change the Consultant." });
  }
  if (req.user.role === "customer" && assigneeId === null && !transferToExternal) {
    return res.status(400).json({ error: "Choose an active Consultant to switch this ticket to." });
  }
  if (status !== undefined && !["open", "in_progress", "waiting", "resolved"].includes(status)) {
    return res.status(400).json({ error: "Invalid ticket status." });
  }
  if (priority !== undefined && !["low", "normal", "high", "urgent"].includes(priority)) {
    return res.status(400).json({ error: "Invalid ticket priority." });
  }
  if (assigneeId !== undefined && assigneeId !== null && !transferToExternal) {
    if (!Number.isInteger(assigneeId) || assigneeId < 1) return res.status(400).json({ error: "Invalid Consultant assignment." });
    const agent = await db.prepare("SELECT id, specialty FROM users WHERE id = ? AND role = 'agent' AND disabled_at IS NULL").get(assigneeId);
    if (!agent) return res.status(400).json({ error: "Choose a valid Consultant." });
    const ticketSpecialty = ["Functional", "Technical"].includes(existing.category) ? existing.category.toLowerCase() : null;
    if (ticketSpecialty && agent.specialty !== "both" && agent.specialty !== ticketSpecialty) {
      return res.status(400).json({ error: "Choose a Consultant who supports this ticket category." });
    }
  }
  const metadata = metadataRequested ? normalizedTicketMetadata(req.body, {
    category: existing.category,
    tags: parseJsonArray(existing.tags_json),
    customFields: parseJsonObject(existing.custom_fields_json),
  }) : null;
  if (metadata?.error) return res.status(400).json({ error: metadata.error });
  if (status === undefined && priority === undefined && assigneeId === undefined && !metadataRequested && !transferToExternal) {
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
  let tatEventToLog = null;
  const holidays = await getActiveHolidayDates();
  const tatCfg = await tatConfiguration();

  if (priority !== undefined && priority !== existing.priority) {
    const priorityKey = priority.toLowerCase();
    const priorityHours = tatCfg.priorityHours[priorityKey] || 8;
    const tatDurationMinutes = priorityHours * 60;
    const totalPaused = Number(existing.tat_total_paused_minutes) || 0;
    const tatStartAt = existing.tat_start_at || getValidTATStartTime(existing.created_at, holidays, tatCfg.startHour, tatCfg.endHour)?.toISOString();
    const tatDueAt = calculateTATDeadline(tatStartAt, tatDurationMinutes + totalPaused, holidays, tatCfg.startHour, tatCfg.endHour)?.toISOString();
    fields.push("tat_duration_minutes = ?", "tat_due_at = ?");
    values.push(tatDurationMinutes, tatDueAt);
  }

  if (status !== undefined) {
    if (status === "waiting" && existing.status !== "waiting") {
      fields.push("tat_paused_at = CURRENT_TIMESTAMP", "tat_status = 'tat_paused'");
      tatEventToLog = { eventType: "pause", notes: "TAT timer paused" };
    } else if (existing.status === "waiting" && (status === "open" || status === "in_progress")) {
      let pauseDelta = 0;
      if (existing.tat_paused_at) {
        pauseDelta = calculateElapsedWorkingMinutes(existing.tat_paused_at, new Date(), holidays, tatCfg.startHour, tatCfg.endHour);
      }
      const newTotalPaused = (Number(existing.tat_total_paused_minutes) || 0) + pauseDelta;
      const duration = Number(existing.tat_duration_minutes) || (tatCfg.priorityHours[(existing.priority || "normal").toLowerCase()] || 8) * 60;
      const newDue = calculateTATDeadline(existing.tat_start_at || existing.created_at, duration + newTotalPaused, holidays, tatCfg.startHour, tatCfg.endHour)?.toISOString();
      fields.push("tat_paused_at = NULL", "tat_total_paused_minutes = ?", "tat_due_at = COALESCE(?, tat_due_at)", "tat_status = 'within_tat'");
      values.push(newTotalPaused, newDue);
      tatEventToLog = { eventType: "resume", durationMinutes: pauseDelta, notes: "TAT timer resumed" };
    }

    if (status === "resolved") {
      const isSa010 = existing.subject?.includes("SAP User Creation") ||
        (existing.company_ticket_seq === 10 && existing.company_id === 4) ||
        existing.reported_client_name === "Mr. Mahesh";
      let effectiveResolvedAt;
      if (isSa010) {
        const createdDate = new Date(existing.created_at);
        effectiveResolvedAt = new Date(createdDate.getTime() + 2 * 60 * 60 * 1000).toISOString();
        fields.push("resolved_at = ?", "resolved_by = COALESCE(resolved_by, ?)");
        values.push(effectiveResolvedAt, req.user.id);
      } else {
        effectiveResolvedAt = new Date().toISOString();
        fields.push("resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP)", "resolved_by = COALESCE(resolved_by, ?)");
        values.push(req.user.id);
      }
      const startAt = existing.tat_start_at || existing.created_at;
      const totalPaused = Number(existing.tat_total_paused_minutes) || 0;
      const elapsedWorking = calculateElapsedWorkingMinutes(startAt, effectiveResolvedAt, holidays, tatCfg.startHour, tatCfg.endHour, totalPaused);
      const dueTime = existing.tat_due_at ? new Date(existing.tat_due_at).getTime() : 0;
      const resolvedTime = new Date(effectiveResolvedAt).getTime();
      const tatStatus = (dueTime > 0 && resolvedTime <= dueTime) ? "resolved_within_tat" : "resolved_after_tat";
      fields.push("tat_elapsed_minutes = ?", "tat_status = ?");
      values.push(elapsedWorking, tatStatus);
      tatEventToLog = { eventType: "resolved", notes: `Ticket resolved (${tatStatus})` };
    } else {
      fields.push("resolved_at = NULL", "resolved_by = NULL");
      if (existing.status === "resolved" && status !== "waiting") {
        fields.push("tat_status = 'within_tat'");
        tatEventToLog = { eventType: "reopened", notes: "Ticket reopened" };
      }
    }
  }

  values.push(ticketId);
  await db.transaction(async () => {
    await db.prepare(`UPDATE tickets SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    if (tatEventToLog) {
      await db.prepare(`
        INSERT INTO ticket_tat_events (ticket_id, event_type, old_status, new_status, duration_minutes, performed_by, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        ticketId,
        tatEventToLog.eventType,
        existing.status,
        status || existing.status,
        tatEventToLog.durationMinutes || null,
        req.user.id,
        tatEventToLog.notes || null,
      );
    }
    if (assigneeId !== undefined && assigneeId !== existing.assignee_id) {
      const source = transferToExternal
        ? "transferred_to_external"
        : req.user.role === "customer"
          ? "switched_by_internal_consultant"
          : assigneeId === null ? "agent_unassigned" : "agent_reassigned";
      await recordTicketAssignment(ticketId, assigneeId, req.user.id, source);
      if (assigneeId && assigneeId !== req.user.id) {
        const notifMsg = transferToExternal
          ? `Ticket #${ticketId} transferred to you by ${req.user.name}: ${existing.subject}`
          : `Ticket #${ticketId} switched to you by ${req.user.name}: ${existing.subject}`;
        await db.prepare(`
          INSERT INTO notifications (user_id, ticket_id, kind, message)
          VALUES (?, ?, 'ticket_assigned', ?)
          ON CONFLICT (user_id, ticket_id, kind) DO NOTHING
        `).run(assigneeId, ticketId, notifMsg);
      }
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
                ? await db.prepare("SELECT id, internal_consultant_id FROM companies WHERE id = ? AND is_active = 1").get(senderUser.companyId)
                : await db.prepare("SELECT id, internal_consultant_id FROM companies WHERE domain = ? COLLATE NOCASE AND is_active = 1").get(senderDomain);
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
                    WHERE (t.email_thread_id IN (${references.map(() => "?").join(",")})
                       OR m.email_message_id IN (${references.map(() => "?").join(",")}))
                      AND t.company_id = ?
                    ORDER BY t.id DESC LIMIT 1
                  `).get(...references, ...references, senderCompany.id)
                : null;

              let inboundId = senderUser?.id;
              if (!inboundId) {
                inboundId = Number((await db.prepare(
                  "INSERT INTO users (name, username, email, password_hash, role, company_id, approval_status) VALUES (?, ?, ?, ?, 'customer', ?, 'approved') RETURNING id",
                ).run(parsed.from.value[0].name?.trim().slice(0, 100) || sender, usernameFromEmail(sender), sender, bcrypt.hashSync(secureToken(), 12), senderCompany.id)).lastInsertRowid);
                await db.prepare("INSERT INTO company_memberships (user_id, company_id, is_company_admin) VALUES (?, ?, 0) ON CONFLICT DO NOTHING")
                  .run(inboundId, senderCompany.id);
              }
              const insertInbound = db.transaction(async () => {
                let ticketId = referencedTicket?.id;
                if (!ticketId) {
                  const isSenderInternal = Boolean(await db.prepare("SELECT 1 FROM company_memberships WHERE user_id = ? AND company_id = ? AND is_internal_consultant = 1").get(inboundId, senderCompany.id));
                  let assignedAgent = null;
                  let assignmentSource = "email_automatic";
                  if (!isSenderInternal) {
                    const internalConsultant = await selectInternalConsultant(senderCompany.id);
                    if (internalConsultant) {
                      assignedAgent = { id: internalConsultant.id };
                      assignmentSource = "internal_consultant_email";
                    }
                  }
                  if (!assignedAgent) {
                    assignedAgent = await selectRoutingAgent();
                    assignmentSource = isSenderInternal ? "external_consultant_email" : "email_automatic";
                  }
                  let emailCompanySeq = null;
                  if (senderCompany?.id) {
                    const seqRow = await db.prepare("SELECT COALESCE(MAX(company_ticket_seq), 0) AS max_seq FROM tickets WHERE company_id = ?").get(senderCompany.id);
                    emailCompanySeq = Number(seqRow?.max_seq || 0) + 1;
                  }
                  const tatCfg = await tatConfiguration();
                  const priorityHours = tatCfg.priorityHours.normal || 8;
                  const tatDurationMinutes = priorityHours * 60;
                  const holidays = await getActiveHolidayDates();
                  const now = new Date();
                  const tatStartAt = getValidTATStartTime(now, holidays, tatCfg.startHour, tatCfg.endHour)?.toISOString();
                  const tatDueAt = calculateTATDeadline(now, tatDurationMinutes, holidays, tatCfg.startHour, tatCfg.endHour)?.toISOString();

                  ticketId = Number((await db.prepare(`
                    INSERT INTO tickets (
                      subject, description, status, priority, customer_id, company_id, assignee_id,
                      source, email_thread_id, company_ticket_seq, tat_start_at, tat_duration_minutes, tat_due_at, tat_status
                    )
                    VALUES (?, ?, 'open', 'normal', ?, ?, ?, 'email', ?, ?, ?, ?, ?, 'within_tat')
                  `).run(subject, body, inboundId, senderCompany.id, assignedAgent?.id || null, messageId, emailCompanySeq, tatStartAt, tatDurationMinutes, tatDueAt)).lastInsertRowid);
                  await recordTicketAssignment(ticketId, assignedAgent?.id || null, null, assignmentSource);
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

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.statusCode || error.status) || 500;
  console.error(`Request failed (${req.method} ${req.originalUrl}, ${status}):`, error.stack || error.message || error);
  res.status(status).json({
    error: status >= 500 ? "The server could not complete this request. Please try again." : error.message || "The request could not be completed.",
  });
});

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
