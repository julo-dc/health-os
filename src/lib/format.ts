/**
 * Deterministic, locale-independent date formatting.
 *
 * `toLocaleDateString` resolves against the runtime's locale, which differs
 * between the Node server and the browser ("Jul 6" vs "6 Jul") and causes React
 * hydration mismatches. Dates here are plain calendar days with no timezone
 * meaning, so they are parsed and rendered in UTC.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const parse = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);

/** "6 Jul" */
export function fmtDay(iso: string): string {
  const d = parse(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "6 Jul 2026" */
export function fmtDayLong(iso: string): string {
  const d = parse(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "Sat 6 Jul" */
export function fmtWeekday(iso: string): string {
  const d = parse(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "6 Jul 2026, 14:32" — for real timestamps, rendered in UTC for stability. */
export function fmtStamp(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return isoTimestamp;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}
