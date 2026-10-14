// Return parameterized SQL conditions so ticket access rules can be exercised
// independently and cannot interpolate user-controlled data into a query.
export function ticketAccessFilter(user, ticketId) {
  if (user.role === "agent") {
    return { sql: "id = ?", params: [ticketId] };
  }
  if (user.role === "customer" && user.company_id) {
    return { sql: "id = ? AND company_id = ?", params: [ticketId, user.company_id] };
  }
  return { sql: "FALSE", params: [] };
}

export function reportAccess(user) {
  if (user.role === "agent" && user.is_admin) {
    return { allowed: true, workspaceWide: true, companyId: null };
  }
  if (user.role === "customer" && user.is_company_admin && user.company_id) {
    return { allowed: true, workspaceWide: false, companyId: user.company_id };
  }
  return { allowed: false, workspaceWide: false, companyId: null };
}
