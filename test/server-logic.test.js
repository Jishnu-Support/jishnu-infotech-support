import test from "node:test";
import assert from "node:assert/strict";
import { reportAccess, ticketAccessFilter, isInternalConsultant, canManageTicket, canEditChatMessage, canEditConsultantSolution } from "../server/authz.js";
import { normalizedTicketMetadata, isAllowedAttachment, sanitizeAttachmentName } from "../server/validation.js";
import {
  priorityLabel,
  sortInternalConsultants,
  pickInternalConsultant,
  determineTicketRouting,
  isTicketSolvedByInternal,
} from "../server/internal-routing.js";
import { deriveCompanyPrefix, formatCompanyTicketNumber } from "../server/ticket-numbering.js";
import { calculateReportDateRange, aggregateCompanyReport, formatTicketStatusDisplay } from "../server/company-reports.js";
import {
  calculateTATDeadline,
  calculateElapsedWorkingMinutes,
  determineTATStatus,
  formatTATDuration,
  formatISTDateTime,
  fromISTDate,
} from "../server/tat-engine.js";

test("agents can inspect a ticket by its id", () => {
  assert.deepEqual(ticketAccessFilter({ role: "agent", id: 7 }, 42), {
    sql: "id = ?",
    params: [42],
  });
});

test("company administrators are scoped to their company", () => {
  assert.deepEqual(ticketAccessFilter({ role: "customer", id: 7, company_id: 12, is_company_admin: 1 }, 42), {
    sql: "id = ? AND company_id = ?",
    params: [42, 12],
  });
});

test("regular customers can view tickets across their company", () => {
  assert.deepEqual(ticketAccessFilter({ role: "customer", id: 7, company_id: 12, is_company_admin: 0 }, 42), {
    sql: "id = ? AND company_id = ?",
    params: [42, 12],
  });
});

test("unknown and unassigned users have no ticket access", () => {
  assert.deepEqual(ticketAccessFilter({ role: "customer", id: 7 }, 42), { sql: "FALSE", params: [] });
  assert.deepEqual(ticketAccessFilter({ role: "other", id: 7 }, 42), { sql: "FALSE", params: [] });
});

test("only the Super Admin can access workspace-wide reports", () => {
  assert.deepEqual(reportAccess({ role: "agent", is_admin: 1 }), {
    allowed: true,
    workspaceWide: true,
    companyId: null,
  });
  assert.equal(reportAccess({ role: "agent", is_admin: 0 }).allowed, false);
  assert.equal(reportAccess({ role: "customer", is_company_admin: 0, company_id: 12 }).allowed, false);
});

test("Company Admin reports are limited to their company", () => {
  assert.deepEqual(reportAccess({ role: "customer", is_company_admin: 1, company_id: 12 }), {
    allowed: true,
    workspaceWide: false,
    companyId: 12,
  });
  assert.equal(reportAccess({ role: "customer", is_company_admin: 1 }).allowed, false);
});

test("ticket metadata validates category and normalizes tags and fields", () => {
  assert.deepEqual(normalizedTicketMetadata({
    category: "Billing",
    tags: "Urgent, urgent, Follow up",
    customFields: { " Order ": "  123  ", Empty: " " },
  }), {
    category: "Billing",
    tags: ["urgent", "follow up"],
    customFields: { Order: "123" },
  });
});

test("ticket metadata rejects unknown categories and excessive tags", () => {
  assert.match(normalizedTicketMetadata({ category: "Unknown" }).error, /valid ticket category/);
  assert.match(normalizedTicketMetadata({ tags: Array(11).fill("tag") }).error, /up to 10 tags/);
});

test("ticket metadata rejects malformed or oversized custom fields", () => {
  assert.match(normalizedTicketMetadata({ customFields: "{" }).error, /valid JSON/);
  assert.match(normalizedTicketMetadata({ customFields: { key: 1 } }).error, /names must/);
  assert.match(normalizedTicketMetadata({ customFields: { ["x".repeat(41)]: "value" } }).error, /names must/);
});

test("isInternalConsultant correctly identifies assigned internal consultant", () => {
  const company = { id: 10, internal_consultant_id: 5 };
  assert.equal(isInternalConsultant({ id: 5 }, company), true);
  assert.equal(isInternalConsultant({ id: 6 }, company), false);
  assert.equal(isInternalConsultant({ id: 5 }, { id: 10, internal_consultant_id: null }), false);
  assert.equal(isInternalConsultant(null, company), false);
});

test("canManageTicket grants Internal Consultant client permissions to update status and switch consultant", () => {
  const company = { id: 10, internal_consultant_id: 5 };
  const ticket = { id: 100, company_id: 10, assignee_id: 5, customer_id: 8 };
  const internalUser = { id: 5, role: "customer", company_id: 10 };
  const regularUser = { id: 8, role: "customer", company_id: 10 };

  const internalPerms = canManageTicket(internalUser, ticket, company);
  assert.equal(internalPerms.canUpdateStatus, true);
  assert.equal(internalPerms.canSwitchToConsultant, true);
  assert.equal(internalPerms.isInternalConsultant, true);

  const regularPerms = canManageTicket(regularUser, ticket, company);
  assert.equal(regularPerms.canUpdateStatus, false);
  assert.equal(regularPerms.canSwitchToConsultant, false);
  assert.equal(regularPerms.isInternalConsultant, false);
});

test("canManageTicket grants Consultant permissions appropriately", () => {
  const company = { id: 10, internal_consultant_id: 5 };
  const ticket = { id: 100, company_id: 10, assignee_id: 20, customer_id: 8 };

  const superAdmin = { id: 1, role: "agent", is_admin: 1 };
  const assignedAgent = { id: 20, role: "agent", is_admin: 0 };
  const otherAgent = { id: 21, role: "agent", is_admin: 0 };

  assert.equal(canManageTicket(superAdmin, ticket, company).canChangeAssignment, true);
  assert.equal(canManageTicket(assignedAgent, ticket, company).canChangeAssignment, true);
  assert.equal(canManageTicket(otherAgent, ticket, company).canChangeAssignment, false);
});

test("internal consultant resolution attribution correctly identifies when solved by internal consultant", () => {
  function isResolvedByInternal(resolvedBy, resolvedByRole, companyInternalConsultantId) {
    return Boolean(
      resolvedBy && (
        (companyInternalConsultantId && Number(resolvedBy) === Number(companyInternalConsultantId)) ||
        resolvedByRole === "customer"
      )
    );
  }

  // Solved by client who is internal consultant
  assert.equal(isResolvedByInternal(5, "customer", 5), true);
  // Solved by consultant who was assigned as internal consultant
  assert.equal(isResolvedByInternal(15, "agent", 15), true);
  // Solved by external consultant when ticket was switched to them
  assert.equal(isResolvedByInternal(16, "agent", 15), false);
  // Solved by external consultant when company has client internal consultant
  assert.equal(isResolvedByInternal(16, "agent", 5), false);
});

test("priorityLabel produces correct human-readable titles", () => {
  assert.equal(priorityLabel(1), "Primary");
  assert.equal(priorityLabel(2), "Secondary");
  assert.equal(priorityLabel(3), "Tertiary");
  assert.equal(priorityLabel(4), "#4");
  assert.equal(priorityLabel(0), "Unset");
});

test("sortInternalConsultants orders strictly by priority then active workload then id", () => {
  const consultants = [
    { id: 10, internalRoutingPriority: 2, activeTicketCount: 0 },
    { id: 11, internalRoutingPriority: 1, activeTicketCount: 3 },
    { id: 12, internalRoutingPriority: 1, activeTicketCount: 1 },
    { id: 13, internalRoutingPriority: 3, activeTicketCount: 0 },
  ];
  const sorted = sortInternalConsultants(consultants);
  // Priority 1 (active=1) -> id 12
  // Priority 1 (active=3) -> id 11
  // Priority 2 (active=0) -> id 10
  // Priority 3 (active=0) -> id 13
  assert.deepEqual(sorted.map((c) => c.id), [12, 11, 10, 13]);
});

test("pickInternalConsultant excludes the ticket creator if they are an internal consultant", () => {
  const consultants = [
    { id: 101, internalRoutingPriority: 1, activeTicketCount: 0, approvalStatus: "approved" },
    { id: 102, internalRoutingPriority: 2, activeTicketCount: 0, approvalStatus: "approved" },
  ];
  // If creator is user 101, the next internal consultant (102) is selected
  const picked = pickInternalConsultant(consultants, 101);
  assert.equal(picked?.id, 102);
});

test("determineTicketRouting correctly directs ticket assignment", () => {
  // Case 1: Creator is an internal consultant -> must route to external consultant
  assert.deepEqual(
    determineTicketRouting({
      isCreatorInternalConsultant: true,
      companyHasInternalConsultants: true,
      routingPreference: "internal",
    }),
    { target: "external", reason: "creator_is_internal_consultant" }
  );

  // Case 2: Company has no internal consultant -> routes external
  assert.deepEqual(
    determineTicketRouting({
      isCreatorInternalConsultant: false,
      companyHasInternalConsultants: false,
      routingPreference: "internal",
    }),
    { target: "external", reason: "no_internal_consultants" }
  );

  // Case 3: Client selects External Consultant
  assert.deepEqual(
    determineTicketRouting({
      isCreatorInternalConsultant: false,
      companyHasInternalConsultants: true,
      routingPreference: "external",
    }),
    { target: "external", reason: "preference_external" }
  );

  // Case 4: Client selects Internal Consultant
  assert.deepEqual(
    determineTicketRouting({
      isCreatorInternalConsultant: false,
      companyHasInternalConsultants: true,
      routingPreference: "internal",
    }),
    { target: "internal", reason: "preference_internal" }
  );
});

test("isTicketSolvedByInternal correctly attributes resolutions", () => {
  // Solved by user with internal consultant flag in company
  assert.equal(isTicketSolvedByInternal({
    status: "resolved",
    resolvedBy: 22,
    resolvedByRole: "customer",
    resolvedByIsInternalConsultant: 1,
  }), true);

  // Solved by external consultant agent
  assert.equal(isTicketSolvedByInternal({
    status: "resolved",
    resolvedBy: 3,
    resolvedByRole: "agent",
    resolvedByIsInternalConsultant: 0,
  }), false);

  // Ticket not yet resolved
  assert.equal(isTicketSolvedByInternal({
    status: "in_progress",
    resolvedBy: 22,
    resolvedByRole: "customer",
    resolvedByIsInternalConsultant: 1,
  }), false);
});

test("isAllowedAttachment permits all non-executable file formats", () => {
  // Documents and spreadsheets
  assert.equal(isAllowedAttachment("report.pdf"), true);
  assert.equal(isAllowedAttachment("budget.xlsx"), true);
  assert.equal(isAllowedAttachment("legacy.doc"), true);
  assert.equal(isAllowedAttachment("contract.docx"), true);
  assert.equal(isAllowedAttachment("data.csv"), true);
  assert.equal(isAllowedAttachment("notes.txt"), true);
  assert.equal(isAllowedAttachment("slides.pptx"), true);

  // Images, media, archives
  assert.equal(isAllowedAttachment("screenshot.png"), true);
  assert.equal(isAllowedAttachment("photo.jpg"), true);
  assert.equal(isAllowedAttachment("recording.mp3"), true);
  assert.equal(isAllowedAttachment("screencast.mp4"), true);
  assert.equal(isAllowedAttachment("bundle.zip"), true);
  assert.equal(isAllowedAttachment("archive.7z"), true);

  // Blocked dangerous executables
  assert.equal(isAllowedAttachment("installer.exe"), false);
  assert.equal(isAllowedAttachment("script.bat"), false);
  assert.equal(isAllowedAttachment("command.cmd"), false);
  assert.equal(isAllowedAttachment("deploy.sh"), false);
  assert.equal(isAllowedAttachment("macro.vbs"), false);
  assert.equal(isAllowedAttachment("exploit.scr"), false);
});

test("sanitizeAttachmentName sanitizes dangerous characters while preserving extensions", () => {
  assert.equal(sanitizeAttachmentName("my report (final).pdf"), "my report (final).pdf");
  assert.equal(sanitizeAttachmentName("illegal<file>:name?.xlsx"), "illegal_file__name_.xlsx");
  assert.equal(sanitizeAttachmentName("../../etc/passwd.txt"), "passwd.txt");
  assert.equal(sanitizeAttachmentName(""), "attachment");
});

test("canEditChatMessage allows only consultants to edit messages", () => {
  const agentUser = { id: 10, role: "agent" };
  const otherAgentUser = { id: 20, role: "agent" };
  const customerUser = { id: 10, role: "customer" };
  const internalConsultantUser = { id: 10, role: "customer", is_internal_consultant: 1 };
  const adminUser = { id: 99, role: "agent", is_admin: 1 };

  const ownMessage = { id: 1, author_id: 10, body: "Hello" };
  const otherMessage = { id: 2, author_id: 20, body: "Hi" };
  const agentMessage = { id: 3, author_id: 20, authorRole: "agent", body: "Agent response" };

  // Consultant editing own message -> allowed
  assert.equal(canEditChatMessage(agentUser, ownMessage), true);

  // Internal Consultant editing own message -> allowed
  assert.equal(canEditChatMessage(internalConsultantUser, ownMessage), true);

  // Agent editing another agent message -> allowed
  assert.equal(canEditChatMessage(agentUser, agentMessage), true);

  // Super Admin editing any message -> allowed
  assert.equal(canEditChatMessage(adminUser, ownMessage), true);

  // Consultant editing another customer message -> disallowed
  assert.equal(canEditChatMessage(agentUser, otherMessage), false);

  // Regular customer editing message -> disallowed
  assert.equal(canEditChatMessage(customerUser, ownMessage), false);

  // Edge cases
  assert.equal(canEditChatMessage(null, ownMessage), false);
  assert.equal(canEditChatMessage(agentUser, null), false);
});

test("canEditConsultantSolution allows Consultants and Super Admins", () => {
  assert.equal(canEditConsultantSolution({ role: "agent", is_admin: 1 }), true);
  assert.equal(canEditConsultantSolution({ role: "agent", is_admin: 0 }), true);
  assert.equal(canEditConsultantSolution({ role: "customer", is_admin: 1 }), false);
  assert.equal(canEditConsultantSolution({ role: "customer", is_company_admin: 1 }), false);
  assert.equal(canEditConsultantSolution(null), false);
});

test("deriveCompanyPrefix extracts first two alphabetic characters from admin username or company name", () => {
  // Balar Marketing with admin username ba_admin -> BA
  assert.equal(deriveCompanyPrefix("ba_admin", "Balar Marketing"), "BA");
  // Metcraft with admin username me_admin -> ME
  assert.equal(deriveCompanyPrefix("me_admin", "Metcraft"), "ME");
  // Metcraft with admin username metcraft -> ME
  assert.equal(deriveCompanyPrefix("metcraft", "Metcraft"), "ME");
  // Company admin with symbols or uppercase: Ba-Admin -> BA
  assert.equal(deriveCompanyPrefix("Ba-Admin", "Balar"), "BA");
  // Fallback to company name if admin username has no letters
  assert.equal(deriveCompanyPrefix("123", "Metcraft"), "ME");
  assert.equal(deriveCompanyPrefix(null, "Metcraft"), "ME");
  assert.equal(deriveCompanyPrefix(null, "Balar Marketing"), "BA");
  // Single letter fallback
  assert.equal(deriveCompanyPrefix(null, "A"), "AX");
  // Empty fallback
  assert.equal(deriveCompanyPrefix(null, null), "TK");
});

test("formatCompanyTicketNumber generates company-prefixed sequential ticket numbers", () => {
  // Balar Marketing ticket 1 -> #BA001
  assert.equal(
    formatCompanyTicketNumber({
      companyId: 1,
      companyName: "Balar Marketing",
      adminUsername: "ba_admin",
      companyTicketSeq: 1,
      ticketId: 72,
    }),
    "#BA001"
  );

  // Metcraft ticket 1 -> #ME001
  assert.equal(
    formatCompanyTicketNumber({
      companyId: 2,
      companyName: "Metcraft",
      adminUsername: "me_admin",
      companyTicketSeq: 1,
      ticketId: 85,
    }),
    "#ME001"
  );

  // Metcraft ticket 42 -> #ME042
  assert.equal(
    formatCompanyTicketNumber({
      companyId: 2,
      companyName: "Metcraft",
      adminUsername: "me_admin",
      companyTicketSeq: 42,
      ticketId: 105,
    }),
    "#ME042"
  );

  // Global / unassigned ticket without company_id falls back to #0072
  assert.equal(
    formatCompanyTicketNumber({
      companyId: null,
      companyName: null,
      ticketId: 72,
    }),
    "#0072"
  );
});

test("calculateReportDateRange generates accurate ISO dates for periods", () => {
  const refDate = new Date("2026-10-28T12:00:00Z");

  const weekly = calculateReportDateRange("weekly", null, null, refDate);
  assert.equal(weekly.period, "weekly");
  assert.equal(weekly.startDate, "2026-10-22");
  assert.equal(weekly.endDate, "2026-10-28");
  assert.equal(weekly.startAt, "2026-10-22 00:00:00");
  assert.equal(weekly.endAt, "2026-10-28 23:59:59");

  const monthly = calculateReportDateRange("monthly", null, null, refDate);
  assert.equal(monthly.period, "monthly");
  assert.equal(monthly.startDate, "2026-09-29");
  assert.equal(monthly.endDate, "2026-10-28");

  const custom = calculateReportDateRange("custom", "2026-10-01", "2026-10-15", refDate);
  assert.equal(custom.period, "custom");
  assert.equal(custom.startDate, "2026-10-01");
  assert.equal(custom.endDate, "2026-10-15");
});

test("aggregateCompanyReport summarizes counts and client breakdown strictly for tickets in period", () => {
  const company = { id: 1, name: "Balar Marketing" };
  const adminUsername = "ba_admin";

  const tickets = [
    { id: 10, subject: "Login Issue", description: "Cannot login", status: "resolved", client_name: "Alice", company_ticket_seq: 1 },
    { id: 11, subject: "Invoice Query", description: "Need GST invoice", status: "in_progress", client_name: "Alice", company_ticket_seq: 2 },
    { id: 12, subject: "Printer Support", description: "Offline", status: "open", client_name: "Bob", company_ticket_seq: 3 },
    { id: 13, subject: "VPN Connectivity", description: "Timeout", status: "waiting", client_name: "Charlie", company_ticket_seq: 4 },
  ];

  const report = aggregateCompanyReport({
    company,
    adminUsername,
    tickets,
    period: "weekly",
    startDate: "2026-10-22",
    endDate: "2026-10-28",
  });

  assert.equal(report.company.name, "Balar Marketing");
  assert.equal(report.summary.raised, 4);
  assert.equal(report.summary.solved, 1);
  assert.equal(report.summary.inProgress, 1);
  assert.equal(report.summary.active, 1);
  assert.equal(report.summary.waiting, 1);

  // Verify client summary table
  assert.equal(report.clientSummary.length, 3);
  const alice = report.clientSummary.find((c) => c.clientName === "Alice");
  assert.deepEqual(alice, {
    clientName: "Alice",
    raised: 2,
    resolved: 1,
    active: 0,
    waiting: 0,
    inProgress: 1,
  });

  // Verify ticket details table format
  assert.equal(report.ticketRecords.length, 4);
  assert.equal(report.ticketRecords[0].sNo, 1);
  assert.equal(report.ticketRecords[0].ticketNo, "#BA001");
  assert.equal(report.ticketRecords[0].clientRaisedBy, "Alice");
  assert.equal(report.ticketRecords[0].status, "Solved");
  assert.ok(report.ticketRecords[0].ticketRaisedDate);
  assert.ok(report.ticketRecords[0].ticketClosedDate !== undefined);
  assert.ok(report.ticketRecords[0].tat);

  assert.equal(report.ticketRecords[1].ticketNo, "#BA002");
  assert.equal(report.ticketRecords[1].status, "In Progress");

  assert.equal(report.ticketRecords[2].ticketNo, "#BA003");
  assert.equal(report.ticketRecords[2].status, "Active");

  assert.equal(report.ticketRecords[3].ticketNo, "#BA004");
  assert.equal(report.ticketRecords[3].status, "Waiting");
});

test("canEditConsultantSolution restricts solution creation and editing to Consultants and Super Admins", () => {
  assert.equal(canEditConsultantSolution({ role: "agent", is_admin: 1 }), true);
  assert.equal(canEditConsultantSolution({ role: "agent", is_admin: 0 }), true);
  assert.equal(canEditConsultantSolution({ role: "customer", is_admin: 1 }), false);
  assert.equal(canEditConsultantSolution({ role: "customer", is_company_admin: 1 }), false);
  assert.equal(canEditConsultantSolution(null), false);
});

test("TAT Engine correctly pauses overnight (Thursday 6 PM + 4h -> Friday 11 AM)", () => {
  // Thursday 2026-10-22 18:00 IST
  const thursday6pmUtc = fromISTDate(new Date(Date.UTC(2026, 9, 22, 18, 0, 0)));
  const deadlineUtc = calculateTATDeadline(thursday6pmUtc, 4 * 60);
  assert.equal(formatISTDateTime(deadlineUtc), "23/10/2026, 11:00 AM");
});

test("TAT Engine skips Sundays (Saturday 6 PM + 4h -> Monday 11 AM)", () => {
  // Saturday 2026-10-24 18:00 IST
  const saturday6pmUtc = fromISTDate(new Date(Date.UTC(2026, 9, 24, 18, 0, 0)));
  const deadlineUtc = calculateTATDeadline(saturday6pmUtc, 4 * 60);
  assert.equal(formatISTDateTime(deadlineUtc), "26/10/2026, 11:00 AM");
});

test("TAT Engine handles tickets created after 7 PM (Monday 9 PM + 8h -> Tuesday 4 PM)", () => {
  // Monday 2026-10-26 21:00 IST
  const monday9pmUtc = fromISTDate(new Date(Date.UTC(2026, 9, 26, 21, 0, 0)));
  const deadlineUtc = calculateTATDeadline(monday9pmUtc, 8 * 60);
  assert.equal(formatISTDateTime(deadlineUtc), "27/10/2026, 04:00 PM");
});

test("TAT Engine excludes configured public holidays", () => {
  // Saturday 2026-10-24 18:00 IST, with Monday 2026-10-26 as a public holiday
  const saturday6pmUtc = fromISTDate(new Date(Date.UTC(2026, 9, 24, 18, 0, 0)));
  const holidays = ["2026-10-26"]; // Monday holiday
  const deadlineUtc = calculateTATDeadline(saturday6pmUtc, 4 * 60, holidays);
  // Sunday skipped, Monday holiday skipped -> Tuesday 11:00 AM
  assert.equal(formatISTDateTime(deadlineUtc), "27/10/2026, 11:00 AM");
});

test("calculateElapsedWorkingMinutes computes exact working time between dates", () => {
  // Thursday 17:00 IST to Friday 14:00 IST = 2h Thursday + 6h Friday = 8h (480 min)
  const thursday5pmUtc = fromISTDate(new Date(Date.UTC(2026, 9, 22, 17, 0, 0)));
  const friday2pmUtc = fromISTDate(new Date(Date.UTC(2026, 9, 23, 14, 0, 0)));
  const elapsed = calculateElapsedWorkingMinutes(thursday5pmUtc, friday2pmUtc);
  assert.equal(elapsed, 480);
  assert.equal(formatTATDuration(elapsed), "8h");
});

test("determineTATStatus assigns correct resolution and active statuses", () => {
  assert.equal(determineTATStatus({
    status: "resolved",
    createdAt: "2026-10-23T10:00:00Z",
    resolvedAt: "2026-10-23T12:00:00Z",
    tatDueAt: "2026-10-23T18:00:00Z",
    tatDurationMinutes: 480,
    elapsedWorkingMinutes: 120,
  }), "Resolved Within TAT");

  assert.equal(determineTATStatus({
    status: "resolved",
    createdAt: "2026-10-23T10:00:00Z",
    resolvedAt: "2026-10-24T18:00:00Z",
    tatDueAt: "2026-10-23T18:00:00Z",
    tatDurationMinutes: 480,
    elapsedWorkingMinutes: 600,
  }), "Resolved After TAT");

  assert.equal(determineTATStatus({
    status: "in_progress",
    tatDurationMinutes: 480,
    elapsedWorkingMinutes: 400, // 83% > 80%
  }), "TAT Warning");

  assert.equal(determineTATStatus({
    status: "in_progress",
    tatDurationMinutes: 480,
    elapsedWorkingMinutes: 500, // > 100%
  }), "TAT Breached");
});
