import { formatHHMM, minutesToHHMM, parseHHMM, romeClock, romeMinutesOf } from "./time";
import type { Color, Leg, RouteConfig, StatusResponse, StopRecord, StopView, Train } from "./types";

// User-facing strings (Italian).
const T = {
  notDeparted: "Non ancora partito",
  notDepartedFrom: (o: string) => `Non ancora partito da ${o}`,
  scheduled: (hhmm: string) => `previsto ${hhmm}`,
  leftOrigin: (o: string) => `Partito da ${o}`,
  goNow: "esci adesso",
  leftCheckpoint: (c: string) => `Lasciato ${c}`,
  run: "corri",
  passedAt: (hhmm: string) => `Treno passato alle ${hhmm}`,
  arrivingAround: (hhmm: string) => `In arrivo verso le ${hhmm}`,
  lateAround: (hhmm: string) => `In ritardo, verso le ${hhmm}`,
  estimateFrom: (o: string) => `stima dal ritardo a ${o}`,
  probablyPassed: "Probabilmente passato",
  notRunning: "Oggi questo treno non circola",
  cancelled: "Treno soppresso",
  unavailable: "Dati non disponibili al momento",
};

// Before this Rome time an empty upstream answer usually means "day not loaded yet".
const DAY_LOADED_MIN = 5 * 60;

const light = (color: Color, title: string, subtitle = "") => ({ color, title, subtitle });

export function errorStatus(nowMs: number): StatusResponse {
  return { ok: false, light: light("grey", T.unavailable), updated_at: new Date(nowMs).toISOString() };
}

export function selectLeg(nowMs: number, cfg: RouteConfig): Leg {
  return romeClock(nowMs).minutes < parseHHMM(cfg.switchTime) ? "outbound" : "return";
}

const find = (t: Train, code: string): StopRecord | undefined => t.stops.find((s) => s.code === code);

/** A stop as shown on the route line, before `state` is assigned. */
function view(name: string, s: StopRecord, departed: boolean, delay: number): Omit<StopView, "state"> {
  if (s.actualMs !== null) return { name, time: formatHHMM(s.actualMs), kind: "detected" };
  if (departed) return { name, time: minutesToHHMM(romeMinutesOf(s.scheduledMs) + delay), kind: "estimate" };
  return { name, time: formatHHMM(s.scheduledMs), kind: "scheduled" };
}

function outbound(t: Train, nowMs: number, cfg: RouteConfig, base: StatusResponse): StatusResponse {
  const c = cfg.outbound;
  const o = find(t, c.origin.code);
  const cp = find(t, c.checkpoint.code);
  if (!o || !cp) return errorStatus(nowMs);
  // A cancelled origin only means the train starts further down the line: not a cancellation for the user.
  if (t.cancelled || cp.cancelled) return { ...base, light: light("red", T.cancelled) };

  const delay = t.delayMin;
  const atCp = cp.actualMs !== null;
  const departed = atCp || o.actualMs !== null;
  const userSched = parseHHMM(c.userStop.scheduled);
  const userEst = atCp ? romeMinutesOf(cp.actualMs as number) + c.userStop.offsetMin : userSched + (departed ? delay : 0);
  const now = romeClock(nowMs).minutes;
  const passed = departed && now > userEst + cfg.thresholds.passedGraceMin;

  const lt = passed
    ? light("green", T.passedAt(minutesToHHMM(userEst)))
    : atCp
      ? light("red", T.leftCheckpoint(c.checkpoint.label), T.run)
      : departed
        ? light("yellow", T.leftOrigin(c.origin.label), T.goNow)
        : light("grey", T.notDeparted, T.scheduled(c.userStop.scheduled));

  const oState = departed ? "passed" : "next";
  const cpState = atCp ? "passed" : departed ? "next" : "pending";
  const stops: StopView[] = [
    { ...view(c.origin.label, o, departed, delay), state: oState },
    { ...view(c.checkpoint.label, cp, departed, delay), state: cpState },
    {
      name: c.userStop.label,
      time: minutesToHHMM(userEst),
      kind: departed ? "estimate" : "scheduled",
      state: "target",
      scheduled: c.userStop.scheduled,
    },
  ];
  const movingAfter = passed ? null : atCp ? c.checkpoint.label : departed ? c.origin.label : null;
  // Show the delay that matters to the user (at their stop), not the train's latest one.
  const userDelay = departed ? userEst - userSched : delay;
  return { ...base, delay_min: userDelay, light: lt, stops, moving_after: movingAfter };
}

function returnLeg(t: Train, nowMs: number, cfg: RouteConfig, base: StatusResponse): StatusResponse {
  const c = cfg.return;
  const o = find(t, c.origin.code);
  const u = find(t, c.userStop.code);
  if (!o || !u) return errorStatus(nowMs);
  if (t.cancelled || u.cancelled) return { ...base, light: light("red", T.cancelled) };

  const departed = o.actualMs !== null;
  // The spec estimates from the delay measured at the origin; the train's current
  // delay changes later (e.g. on arrival at its terminus).
  const delay = departed ? Math.round(((o.actualMs as number) - o.scheduledMs) / 60000) : t.delayMin;
  // Only the origin is detected on this leg: the user's stop is always an estimate.
  const userEst = parseHHMM(c.userStop.scheduled) + (departed ? delay : 0);
  const passed = departed && romeClock(nowMs).minutes > userEst + cfg.thresholds.passedGraceMin;
  const hhmm = minutesToHHMM(userEst);

  const lt = passed
    ? light("grey", T.probablyPassed)
    : !departed
      ? light("grey", T.notDepartedFrom(c.origin.label), T.scheduled(c.userStop.scheduled))
      : delay > cfg.thresholds.returnYellowDelayMin
        ? light("yellow", T.lateAround(hhmm), T.estimateFrom(c.origin.label))
        : light("green", T.arrivingAround(hhmm), T.estimateFrom(c.origin.label));

  const stops: StopView[] = [
    { ...view(c.origin.label, o, departed, delay), state: departed ? "passed" : "next" },
    {
      name: c.userStop.label,
      time: hhmm,
      kind: departed ? "estimate" : "scheduled",
      state: "target",
      scheduled: c.userStop.scheduled,
    },
  ];
  const movingAfter = departed && !passed ? c.origin.label : null;
  return { ...base, delay_min: delay, light: lt, stops, moving_after: movingAfter };
}

/** Pure: validated train data + clock + config → the JSON the page renders. */
export function computeStatus(leg: Leg, train: Train | "not_running", nowMs: number, cfg: RouteConfig): StatusResponse {
  const base: StatusResponse = {
    ok: true,
    direction: leg,
    light: light("grey", ""),
    updated_at: new Date(nowMs).toISOString(),
  };
  if (train === "not_running") {
    if (romeClock(nowMs).minutes < DAY_LOADED_MIN) {
      const sched = leg === "outbound" ? cfg.outbound.userStop.scheduled : cfg.return.userStop.scheduled;
      const title = leg === "outbound" ? T.notDeparted : T.notDepartedFrom(cfg.return.origin.label);
      return { ...base, light: light("grey", title, T.scheduled(sched)) };
    }
    return { ...base, light: light("grey", T.notRunning) };
  }
  return leg === "outbound" ? outbound(train, nowMs, cfg, base) : returnLeg(train, nowMs, cfg, base);
}
