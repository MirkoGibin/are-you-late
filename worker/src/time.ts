// Europe/Rome clock helpers. All schedule arithmetic uses wall-clock minutes
// (hours*60+minutes), never midnightMs + minutes, which breaks on DST days.

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

interface RomeParts {
  y: number;
  m: number;
  d: number;
  minutes: number;
  offsetMin: number;
}

function romeParts(ms: number): RomeParts {
  const p: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(ms)) p[type] = value;
  // timeZoneName looks like "GMT+01:00" (or "GMT" for +00:00).
  const off = /GMT([+-])(\d{2}):(\d{2})/.exec(p.timeZoneName ?? "");
  const offsetMin = off ? (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) : 0;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    minutes: Number(p.hour) * 60 + Number(p.minute),
    offsetMin,
  };
}

/** Rome wall-clock minutes of `nowMs` and the epoch ms of that day's Rome midnight. */
export function romeClock(nowMs: number): { minutes: number; midnightMs: number } {
  const now = romeParts(nowMs);
  const utcDate = Date.UTC(now.y, now.m - 1, now.d);
  // The offset at midnight can differ from the offset now (DST change days).
  const guess = utcDate - now.offsetMin * 60000;
  const midnightMs = utcDate - romeParts(guess).offsetMin * 60000;
  return { minutes: now.minutes, midnightMs };
}

export function romeMinutesOf(ms: number): number {
  return romeParts(ms).minutes;
}

export function minutesToHHMM(m: number): string {
  const w = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, "0")}:${String(w % 60).padStart(2, "0")}`;
}

export function formatHHMM(ms: number): string {
  return minutesToHHMM(romeMinutesOf(ms));
}

/** "HH:MM" (already validated) to minutes. */
export function parseHHMM(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}
