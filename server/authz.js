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

export function isInternalConsultant(user, company) {
  if (!user) return false;
  if (user.is_internal_consultant || user.isInternalConsultant) return true;
  if (company && company.internal_consultant_id && Number(company.internal_consultant_id) === Number(user.id)) {
    return true;
  }
  return false;
}

export function canManageTicket(user, ticket, company) {
  if (!user || !ticket) {
    return {
      canUpdateStatus: false,
      canUpdatePriority: false,
      canChangeAssignment: false,
      canSwitchToConsultant: false,
      isInternalConsultant: false,
    };
  }
  const isInternal = isInternalConsultant(user, company);
  if (user.role === "agent") {
    const isSuperAdmin = Boolean(user.is_admin);
    const isAssignee = Number(ticket.assignee_id) === Number(user.id);
    return {
      canUpdateStatus: true,
      canUpdatePriority: true,
      canChangeAssignment: isSuperAdmin || isAssignee,
      canSwitchToConsultant: isSuperAdmin || isAssignee,
      isInternalConsultant: isInternal,
    };
  }
  if (user.role === "customer" && user.company_id && Number(ticket.company_id) === Number(user.company_id)) {
    const isAssigned = Number(ticket.assignee_id) === Number(user.id);
    if (isInternal || isAssigned) {
      return {
        canUpdateStatus: true,
        canUpdatePriority: true,
        canChangeAssignment: true,
        canSwitchToConsultant: true,
        isInternalConsultant: true,
      };
    }
  }
  return {
    canUpdateStatus: false,
    canUpdatePriority: false,
    canChangeAssignment: false,
    canSwitchToConsultant: false,
    isInternalConsultant: false,
  };
}

export function canEditChatMessage(user, message) {
  if (!user || !message) return false;
  const isConsultant = user.role === "agent" || Boolean(user.is_internal_consultant || user.isInternalConsultant);
  if (!isConsultant) return false;

  const authorId = Number(message.author_id ?? message.authorId);
  const userId = Number(user.id);

  if (userId === authorId) return true;
  if (Boolean(user.is_admin)) return true;

  if (user.role === "agent" && (message.is_internal || message.isInternal || message.authorRole === "agent")) {
    return true;
  }

  return false;
}

export function canEditConsultantSolution(user) {
  if (!user) return false;
  return user.role === "agent" && Boolean(user.is_admin);
}
