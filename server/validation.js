export const ticketCategories = ["Functional", "Technical", "Account access", "Billing", "Technical support", "Feature request", "Other"];

export const blockedAttachmentExtensions = new Set([
  ".exe", ".bat", ".cmd", ".sh", ".vbs", ".js", ".scr", ".msi", ".com", ".ps1", ".jar"
]);

export function isAllowedAttachment(filename) {
  if (typeof filename !== "string" || !filename.trim()) return false;
  const lastDot = filename.lastIndexOf(".");
  const ext = lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : "";
  return !blockedAttachmentExtensions.has(ext);
}

export function sanitizeAttachmentName(originalName) {
  if (typeof originalName !== "string") return "attachment";
  const name = originalName.split(/[/\\]/).pop() || "";
  const lastDot = name.lastIndexOf(".");
  const ext = lastDot >= 0 ? name.slice(lastDot).slice(0, 20) : "";
  const rawBase = (lastDot >= 0 ? name.slice(0, lastDot) : name)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 150);
  const cleanBase = rawBase || "attachment";
  return `${cleanBase}${ext}`;
}

export function normalizedTicketMetadata(body, defaults = {}) {
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
      return { error: "Custom field names must be 1 to 40 characters and values 500 characters or fewer." };
    }
    if (value.trim()) normalizedFields[label] = value.trim();
  }
  return { category, tags, customFields: normalizedFields };
}
