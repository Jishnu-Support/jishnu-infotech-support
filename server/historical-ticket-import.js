import { inflateRawSync } from "node:zlib";

const MAX_UNCOMPRESSED_BYTES = 24 * 1024 * 1024;
const MAX_WORKSHEET_ROWS = 2000;
const MAX_ARCHIVE_ENTRIES = 1000;

function decodeXml(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity) => {
    if (entity[0] === "#") {
      const codePoint = entity[1].toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity.toLowerCase()];
  });
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:.-]+)="([^"]*)"/g)].map((match) => [match[1], decodeXml(match[2])]));
}

function unzipXlsx(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("The file is not a valid .xlsx workbook.");
  }
  let endRecord = -1;
  const searchStart = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { endRecord = offset; break; }
  }
  if (endRecord < 0) throw new Error("The workbook archive is incomplete.");
  const entryCount = buffer.readUInt16LE(endRecord + 10);
  if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error("The workbook contains too many archive entries.");
  let offset = buffer.readUInt32LE(endRecord + 16);
  const files = new Map();
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("The workbook archive is malformed.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\\", "/");
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name || name.startsWith("/") || name.split("/").includes("..")) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("The workbook archive is malformed.");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    if (dataOffset + compressedSize > buffer.length) throw new Error("The workbook archive is incomplete.");
    const contents = method === 0 ? Buffer.from(compressed)
      : method === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES - expandedBytes })
        : null;
    if (!contents) throw new Error("This workbook uses an unsupported compression format.");
    expandedBytes += contents.length;
    if (expandedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("The workbook expands beyond the allowed size.");
    files.set(name, contents.toString("utf8"));
  }
  return files;
}

function entryText(files, name) {
  const text = files.get(name);
  if (!text) throw new Error("The workbook is missing required Excel data.");
  return text;
}

function sharedStrings(files) {
  const xml = files.get("xl/sharedStrings.xml");
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join("")
  );
}

function columnIndex(reference) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) return -1;
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function worksheetRows(xml, strings) {
  return [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)].map((rowMatch) => {
    const rowNumber = Number(attributes(`<row ${rowMatch[1]}>`).r);
    const cells = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attr = attributes(`<c ${cellMatch[1]}>`);
      const index = columnIndex(attr.r || "");
      if (index < 0) continue;
      const body = cellMatch[2] || "";
      const valueTag = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
      let value = valueTag ? decodeXml(valueTag[1]) : "";
      if (attr.t === "s" && value !== "") value = strings[Number(value)] ?? "";
      else if (attr.t === "inlineStr") value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join("");
      if (attr.t === "e") value = "";
      cells[index] = value;
    }
    return { rowNumber: Number.isInteger(rowNumber) ? rowNumber : 0, cells };
  }).filter((row) => row.rowNumber > 0 && row.cells.some((cell) => String(cell ?? "").trim()));
}

function workbookSheets(files) {
  const workbook = entryText(files, "xl/workbook.xml");
  const relationships = entryText(files, "xl/_rels/workbook.xml.rels");
  const targets = new Map([...relationships.matchAll(/<Relationship\b[^>]*\/?\s*>/g)].map((match) => {
    const attr = attributes(match[0]);
    return [attr.Id, attr.Target];
  }));
  return [...workbook.matchAll(/<sheet\b[^>]*\/?\s*>/g)].map((match) => {
    const attr = attributes(match[0]);
    const target = targets.get(attr["r:id"]);
    if (!target) return null;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    return { name: attr.name || "", path };
  }).filter(Boolean);
}

function headerKey(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const headerAliases = {
  reporter: ["name", "client", "consultant", "clientname", "consultantname", "clientconsultantname", "consultantclient", "raisedby", "reportedby", "customername", "nameofclient", "nameofconsultant"],
  contact: ["mobile", "mobileno", "mobilenumber", "contact", "contactno", "contactnumber", "phone", "phonenumber"],
  issue: ["ticketsraised", "ticketraised", "ticket", "ticketdetails", "issue", "problem", "description"],
  opened: ["raiseddate", "ticketraiseddate", "dateraised", "ticketdate", "openingdate", "openeddate", "raisingdate", "date"],
  solution: ["solution", "resolution", "solutionprovided", "providedsolution", "solutiongiven", "actiontaken"],
  closed: ["closeddate", "dateclosed", "closedon", "resolveddate", "closed", "closedate"],
};

function findHeader(rows) {
  for (const row of rows.slice(0, 30)) {
    const keys = row.cells.map(headerKey);
    const columns = Object.fromEntries(Object.entries(headerAliases).map(([field, aliases]) => [
      field, keys.findIndex((key) => aliases.includes(key)
        || (field === "reporter" && /^(client|consultant|customer)name/.test(key))
        || (field === "contact" && /(mobile|contact|phone)/.test(key))
        || (field === "issue" && /(ticket|issue|problem|description)/.test(key))
        || (field === "opened" && /date/.test(key) && /(raised|ticket|open|start)/.test(key))
        || (field === "solution" && /(solution|resolution)/.test(key))
        || (field === "closed" && /(closed|resolved)/.test(key))),
    ]));
    if (columns.reporter >= 0 && columns.contact >= 0 && columns.issue >= 0
      && columns.opened >= 0 && columns.solution >= 0 && columns.closed >= 0) {
      return { rowNumber: row.rowNumber, columns };
    }
  }
  throw new Error("Could not identify the ticket columns. Expected reporter, mobile, tickets raised, raised date, solution, and closed date headers.");
}

function excelDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial < 1 || serial > 2958465) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
  }
  let match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    let day = Number(match[1]); let month = Number(match[2]); const year = Number(match[3]);
    if (day > 12 && month <= 12) { /* day first */ }
    else if (month > 12 && day <= 12) [day, month] = [month, day];
    return validDateParts(year, month, day);
  }
  match = text.match(/^(\d{1,2})[-/.](\d{2})(\d{4})$/);
  if (match) return validDateParts(Number(match[3]), Number(match[2]), Number(match[1]));
  match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) return validDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function sourceType(sheetName) {
  const name = headerKey(sheetName);
  if (name.includes("consultant")) return "consultant";
  if (name.includes("client")) return "client";
  return null;
}

export function parseHistoricalTicketWorkbook(buffer) {
  const files = unzipXlsx(buffer);
  const strings = sharedStrings(files);
  const sheets = workbookSheets(files);
  const tickets = [];
  const errors = [];
  let skippedRows = 0;
  for (const sheet of sheets) {
    const kind = sourceType(sheet.name);
    if (!kind) continue;
    const rows = worksheetRows(entryText(files, sheet.path), strings);
    const header = findHeader(rows);
    for (const row of rows) {
      if (row.rowNumber <= header.rowNumber) continue;
      const value = (key) => String(row.cells[header.columns[key]] ?? "").trim();
      const reporter = value("reporter");
      const contact = value("contact");
      const issue = value("issue");
      const openedAt = excelDate(value("opened"));
      const solution = value("solution");
      const rawClosedAt = value("closed");
      if (![reporter, contact, issue, value("opened"), solution, rawClosedAt].some(Boolean)) { skippedRows += 1; continue; }
      if (!reporter || !issue || !openedAt) {
        errors.push(`${sheet.name}, row ${row.rowNumber}: reporter, ticket description, or a valid opening date is missing.`);
        continue;
      }
      const closedAt = rawClosedAt ? excelDate(rawClosedAt) : openedAt;
      if (!closedAt) {
        errors.push(`${sheet.name}, row ${row.rowNumber}: the close date is invalid.`);
        continue;
      }
      if (closedAt < openedAt) {
        errors.push(`${sheet.name}, row ${row.rowNumber}: the close date is before the opening date.`);
        continue;
      }
      tickets.push({
        importKey: `steel-history:v1:${headerKey(sheet.name)}:${row.rowNumber}`,
        sourceSheet: sheet.name,
        sourceRow: row.rowNumber,
        reporterType: kind,
        reporterName: reporter,
        reporterContact: contact,
        issue,
        openedAt,
        closedAt,
        solution,
      });
    }
  }
  if (!tickets.length && !errors.length) throw new Error("No ticket rows were found. Use the workbook with the client and consultant ticket sheets.");
  if (errors.length) {
    const preview = errors.slice(0, 8).join(" ");
    throw new Error(`${errors.length} ticket row(s) need correction before import. ${preview}${errors.length > 8 ? " More rows also need correction." : ""}`);
  }
  if (tickets.length > MAX_WORKSHEET_ROWS) throw new Error(`The workbook exceeds the ${MAX_WORKSHEET_ROWS}-ticket import limit.`);
  return { tickets, skippedRows };
}
