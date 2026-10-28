export function deriveCompanyPrefix(adminUsername, companyName) {
  if (adminUsername && typeof adminUsername === "string") {
    const letters = adminUsername.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase();
    if (letters.length === 2) return letters;
  }
  if (companyName && typeof companyName === "string") {
    const letters = companyName.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase();
    if (letters.length === 2) return letters;
    if (letters.length === 1) return (letters + "X").toUpperCase();
  }
  return "TK";
}

export function formatCompanyTicketNumber({ companyId, companyName, adminUsername, companyTicketSeq, ticketId }) {
  if (!companyId) {
    return `#${String(ticketId).padStart(4, "0")}`;
  }
  const prefix = deriveCompanyPrefix(adminUsername, companyName);
  const seq = companyTicketSeq ? Number(companyTicketSeq) : Number(ticketId);
  return `#${prefix}${String(seq).padStart(3, "0")}`;
}
