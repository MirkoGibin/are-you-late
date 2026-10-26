import type { RouteConfig, Station } from "./types";

const CODE = /^S\d{5}$/;
const TRAIN = /^\d{1,6}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, re: RegExp): string {
  if (typeof v !== "string" || !re.test(v)) throw new Error("invalid");
  return v;
}

function label(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "" || v.length > 40) throw new Error("invalid");
  return v;
}

function int(v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error("invalid");
  return v;
}

function obj(v: unknown): Obj {
  if (!isObj(v)) throw new Error("invalid");
  return v;
}

function station(v: unknown): Station {
  const o = obj(v);
  return { code: str(o.code, CODE), label: label(o.label) };
}

/** Parses and validates ROUTE_CONFIG. Returns a freshly built object, or null if anything is invalid. */
export function parseConfig(raw: string | undefined): RouteConfig | null {
  if (raw === undefined) return null;
  try {
    const c = obj(JSON.parse(raw));
    const out = obj(c.outbound);
    const outStop = obj(out.userStop);
    const ret = obj(c.return);
    const retStop = obj(ret.userStop);
    const th = obj(c.thresholds);
    return {
      switchTime: str(c.switchTime, TIME),
      outbound: {
        train: str(out.train, TRAIN),
        origin: station(out.origin),
        checkpoint: station(out.checkpoint),
        userStop: {
          label: label(outStop.label),
          offsetMin: int(outStop.offsetMin, 0, 30),
          scheduled: str(outStop.scheduled, TIME),
        },
      },
      return: {
        train: str(ret.train, TRAIN),
        origin: station(ret.origin),
        userStop: { ...station(retStop), scheduled: str(retStop.scheduled, TIME) },
      },
      thresholds: {
        passedGraceMin: int(th.passedGraceMin, 0, 60),
        returnYellowDelayMin: int(th.returnYellowDelayMin, 0, 60),
      },
    };
  } catch {
    return null;
  }
}
