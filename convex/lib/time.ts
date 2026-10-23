/**
 * Event times are ms timestamps; `events.date` is the organizer's calendar day
 * as "YYYY-MM-DD". The two are only consistent in ONE time zone -- the one the
 * organizer was in when they typed the times -- so the client sends its IANA
 * zone and the server checks both timestamps land on `date` there.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Throws unless `timeZone` is an IANA zone this runtime can format in. */
export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`Unknown time zone: ${timeZone}`);
  }
}

/** The calendar day of `ms` in `timeZone`, as "YYYY-MM-DD". */
export function calendarDay(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Validates a date + start/end pair. Returns nothing; throws a message the UI
 * shows verbatim. Both times must be finite, end must be after start, and both
 * must fall on `date` in `timeZone`.
 */
export function assertEventTimes(args: {
  date: string;
  startTime: number;
  endTime: number;
  timeZone: string;
}): void {
  const { date, startTime, endTime, timeZone } = args;
  if (!DATE_RE.test(date)) throw new Error("Date must be in YYYY-MM-DD form.");
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new Error("Start and end times are required.");
  }
  if (endTime <= startTime) throw new Error("The end time must be after the start time.");
  assertTimeZone(timeZone);
  if (calendarDay(startTime, timeZone) !== date) {
    throw new Error("The start time must fall on the event date.");
  }
  if (calendarDay(endTime, timeZone) !== date) {
    throw new Error("The end time must fall on the event date.");
  }
}
