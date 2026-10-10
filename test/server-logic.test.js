import test from "node:test";
import assert from "node:assert/strict";
import { reportAccess, ticketAccessFilter } from "../server/authz.js";
import { normalizedTicketMetadata } from "../server/validation.js";

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

test("regular customers are scoped to their own tickets and company", () => {
  assert.deepEqual(ticketAccessFilter({ role: "customer", id: 7, company_id: 12, is_company_admin: 0 }, 42), {
    sql: "id = ? AND customer_id = ? AND company_id = ?",
    params: [42, 7, 12],
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
