import type { Color, Leg, StatusResponse, StopView } from "./types";

const MAX_TEXT = 80;
const MAX_STOPS = 5;
const COLORS: readonly string[] = ["grey", "yellow", "red", "green"];
const LEGS: readonly string[] = ["outbound", "return"];
const KINDS: readonly string[] = ["detected", "estimate", "scheduled"];
const STATES: readonly string[] = ["passed", "next", "target", "pending"];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("invalid");
  return v as Obj;
}

function text(v: unknown): string {
  if (typeof v !== "string" || v.length > MAX_TEXT) throw new Error("invalid");
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly string[]): T {
  if (typeof v !== "string" || !allowed.includes(v)) throw new Error("invalid");
  return v as T;
}

function delay(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < -60 || v > 600) throw new Error("invalid");
  return v;
}

function isoTime(v: unknown): string {
  if (typeof v !== "string" || !ISO_UTC.test(v) || Number.isNaN(Date.parse(v))) throw new Error("invalid");
  return v;
}

function stop(v: unknown): StopView {
  const o = obj(v);
  const s: StopView = {
    name: text(o.name),
    time: text(o.time),
    kind: oneOf<StopView["kind"]>(o.kind, KINDS),
    state: oneOf<StopView["state"]>(o.state, STATES),
  };
  if (o.scheduled !== undefined) s.scheduled = text(o.scheduled);
  return s;
}

/** Validates a pushed status. Returns a freshly built object with known fields only, or null if anything is invalid. */
export function parseStatus(v: unknown): StatusResponse | null {
  try {
    const o = obj(v);
    if (typeof o.ok !== "boolean") return null;
    const l = obj(o.light);
    const s: StatusResponse = {
      ok: o.ok,
      light: { color: oneOf<Color>(l.color, COLORS), title: text(l.title), subtitle: text(l.subtitle) },
      updated_at: isoTime(o.updated_at),
    };
    if (o.direction !== undefined) s.direction = oneOf<Leg>(o.direction, LEGS);
    if (o.delay_min !== undefined) s.delay_min = delay(o.delay_min);
    if (o.stops !== undefined) {
      if (!Array.isArray(o.stops) || o.stops.length > MAX_STOPS) return null;
      s.stops = o.stops.map(stop);
    }
    if (o.moving_after !== undefined) s.moving_after = o.moving_after === null ? null : text(o.moving_after);
    return s;
  } catch {
    return null;
  }
}
