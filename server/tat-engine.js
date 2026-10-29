// TAT (Turnaround Time) Calculation Engine
// Based on configurable working hours, excluding overnight, Sundays, and public holidays.

export const IST_OFFSET_MINUTES = 330; // UTC+05:30 (Asia/Kolkata)
export const DEFAULT_WORKING_START_HOUR = 8;
export const DEFAULT_WORKING_START_MINUTE = 0;
export const DEFAULT_WORKING_END_HOUR = 19;
export const DEFAULT_WORKING_END_MINUTE = 0;
export const DEFAULT_DAILY_WORKING_MINUTES = (19 - 8) * 60; // 660 minutes (11 hours)

export const DEFAULT_PRIORITY_TAT_HOURS = {
  critical: 2,
  high: 4,
  medium: 8,
  low: 16,
};

/**
 * Safely parses Date or ISO/Postgres string as UTC Date
 */
export function parseDateSafe(dateOrIso) {
  if (!dateOrIso) return null;
  if (dateOrIso instanceof Date) return dateOrIso;
  if (typeof dateOrIso === "number") return new Date(dateOrIso);
  if (typeof dateOrIso === "string") {
    const s = dateOrIso.trim();
    if (!s) return null;
    if (!s.endsWith("Z") && !s.includes("+") && !/T.*[+-]\d\d:?\d\d/.test(s)) {
      const parsed = new Date(`${s.replace(" ", "T")}Z`);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    const fallback = new Date(s);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  return null;
}

/**
 * Converts a UTC Date or timestamp to IST Date components
 */
export function toISTDate(dateOrIso) {
  const date = parseDateSafe(dateOrIso);
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
}

/**
 * Converts an IST Date object back to a UTC Date
 */
export function fromISTDate(istDate) {
  if (!istDate || Number.isNaN(istDate.getTime())) return null;
  return new Date(istDate.getTime() - IST_OFFSET_MINUTES * 60 * 1000);
}

/**
 * Returns YYYY-MM-DD string in IST
 */
export function toISTDateString(dateOrIso) {
  const ist = toISTDate(dateOrIso);
  if (!ist) return "";
  const year = ist.getUTCFullYear();
  const month = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Checks whether a given date is a working day (Mon-Sat, not Sunday, and not in public holidays)
 */
export function isWorkingDay(dateOrIso, holidays = []) {
  const ist = toISTDate(dateOrIso);
  if (!ist) return false;
  const dayOfWeek = ist.getUTCDay(); // 0 is Sunday
  if (dayOfWeek === 0) return false;

  const dateStr = toISTDateString(dateOrIso);
  const holidaySet = holidays instanceof Set ? holidays : new Set(holidays);
  if (holidaySet.has(dateStr)) return false;

  return true;
}

/**
 * Finds the valid TAT start time.
 * If created within working hours (8 AM - 7 PM) on a working day -> starts immediately.
 * If created before 8 AM on a working day -> starts at 8 AM today.
 * If created after 7 PM or on Sunday/holiday -> starts at 8 AM on the next working day.
 */
export function getValidTATStartTime(createdAt, holidays = [], startHour = DEFAULT_WORKING_START_HOUR, endHour = DEFAULT_WORKING_END_HOUR) {
  let ist = toISTDate(createdAt);
  if (!ist) return null;

  while (true) {
    if (!isWorkingDay(ist, holidays)) {
      // Advance to 8:00 AM next day
      ist = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, startHour, 0, 0, 0));
      continue;
    }

    const currentMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const startMinutes = startHour * 60;
    const endMinutes = endHour * 60;

    if (currentMinutes < startMinutes) {
      ist = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), startHour, 0, 0, 0));
      return fromISTDate(ist);
    }

    if (currentMinutes >= endMinutes) {
      ist = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, startHour, 0, 0, 0));
      continue;
    }

    // Within working hours
    return fromISTDate(ist);
  }
}

/**
 * Calculates the exact TAT deadline given start time, duration in minutes, and holidays.
 */
export function calculateTATDeadline(
  createdAt,
  tatDurationMinutes = 480,
  holidays = [],
  startHour = DEFAULT_WORKING_START_HOUR,
  endHour = DEFAULT_WORKING_END_HOUR
) {
  const validStartUtc = getValidTATStartTime(createdAt, holidays, startHour, endHour);
  if (!validStartUtc) return null;

  let ist = toISTDate(validStartUtc);
  let remaining = tatDurationMinutes;

  while (remaining > 0) {
    if (!isWorkingDay(ist, holidays)) {
      ist = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, startHour, 0, 0, 0));
      continue;
    }

    const currentMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const startMinutes = startHour * 60;
    const endMinutes = endHour * 60;

    const effectiveMinutes = Math.max(currentMinutes, startMinutes);
    const availableToday = Math.max(0, endMinutes - effectiveMinutes);

    if (remaining <= availableToday) {
      const finalMinutes = effectiveMinutes + remaining;
      const finalHour = Math.floor(finalMinutes / 60);
      const finalMin = finalMinutes % 60;
      const finalSec = ist.getUTCSeconds();
      const finalDate = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), finalHour, finalMin, finalSec, 0));
      return fromISTDate(finalDate);
    }

    remaining -= availableToday;
    // Advance to next day at 8:00 AM
    ist = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, startHour, 0, 0, 0));
  }

  return fromISTDate(ist);
}

/**
 * Calculates total elapsed working minutes between two UTC dates, excluding overnight, Sundays, and holidays.
 * Optionally subtracts paused intervals.
 */
export function calculateElapsedWorkingMinutes(
  startUtc,
  endUtc = new Date(),
  holidays = [],
  startHour = DEFAULT_WORKING_START_HOUR,
  endHour = DEFAULT_WORKING_END_HOUR,
  totalPausedMinutes = 0
) {
  const startDate = parseDateSafe(startUtc);
  const endDate = parseDateSafe(endUtc) || new Date();
  if (!startDate || !endDate || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  if (endDate.getTime() <= startDate.getTime()) return 0;

  const validStart = getValidTATStartTime(startDate, holidays, startHour, endHour);
  if (!validStart || endDate.getTime() <= validStart.getTime()) return 0;

  let currentIst = toISTDate(validStart);
  const endIst = toISTDate(endDate);
  let totalWorkingMinutes = 0;

  while (currentIst.getTime() < endIst.getTime()) {
    if (isWorkingDay(currentIst, holidays)) {
      const dayStart = new Date(Date.UTC(currentIst.getUTCFullYear(), currentIst.getUTCMonth(), currentIst.getUTCDate(), startHour, 0, 0, 0));
      const dayEnd = new Date(Date.UTC(currentIst.getUTCFullYear(), currentIst.getUTCMonth(), currentIst.getUTCDate(), endHour, 0, 0, 0));

      const intervalStart = Math.max(currentIst.getTime(), dayStart.getTime());
      const intervalEnd = Math.min(endIst.getTime(), dayEnd.getTime());

      if (intervalEnd > intervalStart) {
        totalWorkingMinutes += Math.floor((intervalEnd - intervalStart) / (60 * 1000));
      }
    }

    // Move to 8:00 AM next day
    currentIst = new Date(Date.UTC(currentIst.getUTCFullYear(), currentIst.getUTCMonth(), currentIst.getUTCDate() + 1, startHour, 0, 0, 0));
  }

  const netMinutes = Math.max(0, totalWorkingMinutes - Math.max(0, totalPausedMinutes || 0));
  return netMinutes;
}

/**
 * Determines the TAT status of a ticket.
 */
export function determineTATStatus({
  status,
  createdAt,
  resolvedAt,
  tatDueAt,
  tatDurationMinutes,
  elapsedWorkingMinutes,
  warningPercent = 80,
}) {
  const isResolved = status === "resolved" && Boolean(resolvedAt);
  const duration = tatDurationMinutes || 480;

  if (isResolved) {
    const closedDate = new Date(resolvedAt);
    const dueDate = tatDueAt ? new Date(tatDueAt) : null;
    if (dueDate && closedDate.getTime() <= dueDate.getTime()) {
      return "Resolved Within TAT";
    }
    if (elapsedWorkingMinutes !== undefined && elapsedWorkingMinutes <= duration) {
      return "Resolved Within TAT";
    }
    return "Resolved After TAT";
  }

  if (status === "waiting") {
    if (elapsedWorkingMinutes >= duration) {
      return "TAT Breached";
    }
    return "Within TAT (Paused)";
  }

  const elapsed = elapsedWorkingMinutes || 0;
  if (elapsed >= duration || (tatDueAt && Date.now() > new Date(tatDueAt).getTime())) {
    return "TAT Breached";
  }

  const warnThreshold = duration * (warningPercent / 100);
  if (elapsed >= warnThreshold) {
    return "TAT Warning";
  }

  return "Within TAT";
}

/**
 * Formats a duration in minutes into e.g. "2h 30m"
 */
export function formatTATDuration(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return "—";
  const mins = Math.max(0, Math.round(minutes));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * Formats a date into IST readable string e.g. "23/10/2026, 05:00 PM"
 */
export function formatISTDateTime(dateOrIso) {
  if (!dateOrIso) return "—";
  const ist = toISTDate(dateOrIso);
  if (!ist) return "—";

  const day = String(ist.getUTCDate()).padStart(2, "0");
  const month = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const year = ist.getUTCFullYear();

  let hours = ist.getUTCHours();
  const minutes = String(ist.getUTCMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12;
  const hourStr = String(hours).padStart(2, "0");

  return `${day}/${month}/${year}, ${hourStr}:${minutes} ${ampm}`;
}
