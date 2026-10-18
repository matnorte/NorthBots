/** Wall-clock parts of `at` in `timeZone`. */
export function zonedParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Offset of `timeZone` from UTC at instant `at`, in milliseconds (positive east of UTC). */
export function tzOffsetMs(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant local midnight began for `at` in `timeZone` (DST-safe for whole-hour shifts). */
export function startOfDayIn(at: Date, timeZone: string): Date {
  const p = zonedParts(at, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day) - tzOffsetMs(at, timeZone);
  // Re-evaluate the offset at the guessed midnight in case a DST change happened since.
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - tzOffsetMs(new Date(guess), timeZone));
}
