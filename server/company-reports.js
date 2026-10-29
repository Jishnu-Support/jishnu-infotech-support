import { formatCompanyTicketNumber } from "./ticket-numbering.js";
import {
  calculateElapsedWorkingMinutes,
  calculateTATDeadline,
  determineTATStatus,
  formatTATDuration,
  formatISTDateTime,
  DEFAULT_PRIORITY_TAT_HOURS,
} from "./tat-engine.js";

export function calculateReportDateRange(period = "weekly", dateFrom = null, dateTo = null, referenceDate = new Date()) {
  const ref = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate()));
  const validDate = (val) => typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val) && !Number.isNaN(Date.parse(`${val}T00:00:00Z`));

  let startIsoDate;
  let endIsoDate;

  if (period === "custom" && validDate(dateFrom) && validDate(dateTo)) {
    if (dateFrom <= dateTo) {
      startIsoDate = dateFrom;
      endIsoDate = dateTo;
    } else {
      startIsoDate = dateTo;
      endIsoDate = dateFrom;
    }
  } else if (period === "monthly") {
    const startMs = ref.getTime() - 29 * 24 * 60 * 60 * 1000;
    startIsoDate = new Date(startMs).toISOString().slice(0, 10);
    endIsoDate = ref.toISOString().slice(0, 10);
  } else if (period === "yearly") {
    const startMs = ref.getTime() - 364 * 24 * 60 * 60 * 1000;
    startIsoDate = new Date(startMs).toISOString().slice(0, 10);
    endIsoDate = ref.toISOString().slice(0, 10);
  } else {
    // Default weekly: 7 days
    const startMs = ref.getTime() - 6 * 24 * 60 * 60 * 1000;
    startIsoDate = new Date(startMs).toISOString().slice(0, 10);
    endIsoDate = ref.toISOString().slice(0, 10);
  }

  return {
    period: period || "weekly",
    startDate: startIsoDate,
    endDate: endIsoDate,
    startAt: `${startIsoDate} 00:00:00`,
    endAt: `${endIsoDate} 23:59:59`,
  };
}

export function formatTicketStatusDisplay(status) {
  if (status === "resolved") return "Solved";
  if (status === "in_progress") return "In Progress";
  if (status === "waiting") return "Waiting";
  return "Active";
}

export function aggregateCompanyReport({ company, adminUsername = null, tickets = [], period = "weekly", startDate, endDate, holidays = [] }) {
  const companyId = company?.id ? Number(company.id) : null;
  const companyName = company?.name || "Company";

  let totalRaised = 0;
  let totalSolved = 0;
  let totalActive = 0;
  let totalWaiting = 0;
  let totalInProgress = 0;

  const clientMap = new Map();

  const ticketRecords = [];

  for (let index = 0; index < tickets.length; index++) {
    const t = tickets[index];
    totalRaised += 1;

    const status = t.status || "open";
    if (status === "resolved") {
      totalSolved += 1;
    } else if (status === "in_progress") {
      totalInProgress += 1;
    } else if (status === "waiting") {
      totalWaiting += 1;
    } else {
      totalActive += 1;
    }

    const clientName = (t.client_name || t.clientName || t.customer_name || t.customerName || "Unknown Client").trim();
    if (!clientMap.has(clientName)) {
      clientMap.set(clientName, {
        clientName,
        raised: 0,
        resolved: 0,
        active: 0,
        waiting: 0,
        inProgress: 0,
      });
    }

    const clientStats = clientMap.get(clientName);
    clientStats.raised += 1;
    if (status === "resolved") {
      clientStats.resolved += 1;
    } else if (status === "in_progress") {
      clientStats.inProgress += 1;
    } else if (status === "waiting") {
      clientStats.waiting += 1;
    } else {
      clientStats.active += 1;
    }

    const ticketNo = formatCompanyTicketNumber({
      companyId,
      companyName,
      adminUsername: t.company_admin_username || adminUsername,
      companyTicketSeq: t.company_ticket_seq ?? (index + 1),
      ticketId: t.id,
    });

    const description = t.subject
      ? (t.subject + (t.description ? ` - ${t.description.replace(/\r?\n+/g, " ").trim()}` : ""))
      : (t.description || "No description");

    const createdAt = t.created_at || t.createdAt;
    const resolvedAt = status === "resolved" ? (t.resolved_at || t.resolvedAt || null) : null;
    const priority = (t.priority || "medium").toLowerCase();
    const tatDurationMinutes = t.tat_duration_minutes || (DEFAULT_PRIORITY_TAT_HOURS[priority] || 8) * 60;
    const holidaysList = holidays || [];
    const tatDueAt = t.tat_due_at || calculateTATDeadline(createdAt, tatDurationMinutes, holidaysList);
    const elapsedMinutes = t.tat_elapsed_minutes !== null && t.tat_elapsed_minutes !== undefined
      ? t.tat_elapsed_minutes
      : calculateElapsedWorkingMinutes(createdAt, resolvedAt || new Date(), holidaysList, 8, 19, t.tat_total_paused_minutes || 0);

    const tatStatus = t.tat_status || determineTATStatus({
      status,
      createdAt,
      resolvedAt,
      tatDueAt,
      tatDurationMinutes,
      elapsedWorkingMinutes: elapsedMinutes,
    });

    const formattedTatDuration = formatTATDuration(elapsedMinutes);
    const formattedRaisedDate = formatISTDateTime(createdAt);
    const formattedClosedDate = resolvedAt ? formatISTDateTime(resolvedAt) : "—";

    let tatDisplay = formattedTatDuration;
    if (tatStatus === "Resolved Within TAT") {
      tatDisplay = `${formattedTatDuration} (Within TAT)`;
    } else if (tatStatus === "Resolved After TAT") {
      tatDisplay = `${formattedTatDuration} (Breached)`;
    } else if (tatStatus === "TAT Breached") {
      tatDisplay = `${formattedTatDuration} (Breached)`;
    } else if (tatStatus === "TAT Warning") {
      tatDisplay = `${formattedTatDuration} (Warning)`;
    } else if (tatStatus === "Within TAT (Paused)") {
      tatDisplay = `${formattedTatDuration} (Paused)`;
    } else if (tatStatus === "Within TAT") {
      tatDisplay = `${formattedTatDuration} (Within TAT)`;
    }

    ticketRecords.push({
      sNo: index + 1,
      id: t.id,
      ticketNo,
      ticketDescription: description,
      clientRaisedBy: clientName,
      ticketRaisedDate: formattedRaisedDate,
      ticketClosedDate: formattedClosedDate,
      tat: tatDisplay,
      tatStatus,
      tatElapsedMinutes: elapsedMinutes,
      status: formatTicketStatusDisplay(status),
      createdAt,
      resolvedAt,
    });
  }

  const clientSummary = Array.from(clientMap.values()).sort((a, b) =>
    a.clientName.localeCompare(b.clientName)
  );

  return {
    company: {
      id: companyId,
      name: companyName,
    },
    period,
    startDate,
    endDate,
    summary: {
      raised: totalRaised,
      solved: totalSolved,
      active: totalActive,
      waiting: totalWaiting,
      inProgress: totalInProgress,
    },
    clientSummary,
    ticketRecords,
  };
}
