import test from "node:test";
import assert from "node:assert/strict";
import { reportAccess, ticketAccessFilter, isInternalConsultant, canManageTicket } from "../server/authz.js";
import { normalizedTicketMetadata } from "../server/validation.js";
import {
  priorityLabel,
  sortInternalConsultants,
  pickInternalConsultant,
  determineTicketRouting,
  isTicketSolvedByInternal,
} from "../server/internal-routing.js";

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
