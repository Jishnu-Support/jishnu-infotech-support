// Helper functions for internal consultant priority ordering, routing decisions,
// and resolution attribution.

export function priorityLabel(priority) {
  const num = Number(priority);
  if (num === 1) return "Primary";
  if (num === 2) return "Secondary";
  if (num === 3) return "Tertiary";
  if (num > 3) return `#${num}`;
  return "Unset";
}

export function sortInternalConsultants(consultants) {
  if (!Array.isArray(consultants)) return [];
  return [...consultants].sort((a, b) => {
    const priA = Number(a.internalRoutingPriority || a.internal_routing_priority || 0);
    const priB = Number(b.internalRoutingPriority || b.internal_routing_priority || 0);
    const safePriA = priA > 0 ? priA : 999999;
    const safePriB = priB > 0 ? priB : 999999;
    if (safePriA !== safePriB) return safePriA - safePriB;

    const activeA = Number(a.activeTicketCount ?? a.active_tickets ?? 0);
    const activeB = Number(b.activeTicketCount ?? b.active_tickets ?? 0);
    if (activeA !== activeB) return activeA - activeB;

    return Number(a.id) - Number(b.id);
  });
}

export function pickInternalConsultant(consultants, excludeUserId = null) {
  const eligible = (consultants || []).filter((c) => {
    if (excludeUserId !== null && Number(c.id) === Number(excludeUserId)) return false;
    if (c.disabledAt || c.disabled_at) return false;
    if (c.approvalStatus && c.approvalStatus !== "approved") return false;
    if (c.approval_status && c.approval_status !== "approved") return false;
    return true;
  });
  const sorted = sortInternalConsultants(eligible);
  return sorted[0] || null;
}

export function determineTicketRouting({ isCreatorInternalConsultant, companyHasInternalConsultants, routingPreference }) {
  if (isCreatorInternalConsultant) {
    return { target: "external", reason: "creator_is_internal_consultant" };
  }
  if (!companyHasInternalConsultants) {
    return { target: "external", reason: "no_internal_consultants" };
  }
  if (routingPreference === "external") {
    return { target: "external", reason: "preference_external" };
  }
  return { target: "internal", reason: "preference_internal" };
}

export function isTicketSolvedByInternal({
  status,
  resolvedBy,
  resolvedByRole,
  resolvedByIsInternalConsultant,
  companyInternalConsultantId,
}) {
  if (status !== "resolved" || !resolvedBy) return false;
  if (resolvedByIsInternalConsultant) return true;
  if (companyInternalConsultantId && Number(resolvedBy) === Number(companyInternalConsultantId)) {
    return true;
  }
  if (resolvedByRole === "customer") return true;
  return false;
}
