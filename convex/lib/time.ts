/**
 * Event times are ms timestamps; `events.date` and `events.endDate` are the
 * organizer's calendar days as "YYYY-MM-DD". The two are only consistent in
 * ONE time zone -- the one the organizer was in when they typed the times --
 * so the client sends its IANA zone and the server checks the start lands on
 * `date` and the end lands on `endDate` there.
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
 * Validates a date range. Returns nothing; throws a message the UI shows
 * verbatim. `endDate` absent means single-day. Both times must be finite, the
 * end must be after the start, `endDate` must not precede `date`, and in
 * `timeZone` the start must fall on `date` and the end on `endDate`.
 */
export function assertEventTimes(args: {
  date: string;
  endDate?: string;
  startTime: number;
  endTime: number;
  timeZone: string;
}): void {
  const { date, startTime, endTime, timeZone } = args;
  const endDate = args.endDate ?? date;
  if (!DATE_RE.test(date)) throw new Error("Start date must be in YYYY-MM-DD form.");
  if (!DATE_RE.test(endDate)) throw new Error("End date must be in YYYY-MM-DD form.");
  // "YYYY-MM-DD" compares correctly as text.
  if (endDate < date) throw new Error("The end date cannot be before the start date.");
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new Error("Start and end times are required.");
  }
  if (endTime <= startTime) throw new Error("The end time must be after the start time.");
  assertTimeZone(timeZone);
  if (calendarDay(startTime, timeZone) !== date) {
    throw new Error("The start time must fall on the start date.");
  }
  if (calendarDay(endTime, timeZone) !== endDate) {
    throw new Error("The end time must fall on the end date.");
  }
}
