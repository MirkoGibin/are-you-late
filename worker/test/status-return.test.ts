import { describe, expect, it } from "vitest";
import example from "../route-config.example.json";
import { parseConfig } from "../src/config";
import { computeStatus } from "../src/status";
import type { RouteConfig, Train } from "../src/types";
import { at } from "./helpers";

const cfg = parseConfig(JSON.stringify(example)) as RouteConfig;

// Fictional schedule: return origin S00002 12:11, return stop S00003 13:00.
function train(o: { left?: number | null; delay?: number } = {}): Train {
  return {
    delayMin: o.delay ?? 0,
    cancelled: false,
    stops: [
      { code: "S00002", scheduledMs: at("12:11"), actualMs: o.left ?? null, cancelled: false },
      { code: "S00003", scheduledMs: at("13:00"), actualMs: null, cancelled: false },
    ],
  };
}

const run = (t: Train | "not_running", now: string) => computeStatus("return", t, at(now), cfg);
const est = "stima dal ritardo a Partenza ritorno";

describe("return", () => {
  it("not departed", () => {
    const r = run(train(), "12:05");
    expect(r.direction).toBe("return");
    expect(r.light).toEqual({ color: "grey", title: "Non ancora partito da Partenza ritorno", subtitle: "previsto 13:00" });
    expect(r.stops).toEqual([
      { name: "Partenza ritorno", time: "12:11", kind: "scheduled", state: "next" },
      { name: "Fermata ritorno", time: "13:00", kind: "scheduled", state: "target", scheduled: "13:00" },
    ]);
    expect(r.moving_after).toBeNull();
  });

  it("left, small delay", () => {
    const r = run(train({ left: at("12:13"), delay: 2 }), "12:14");
    expect(r.light).toEqual({ color: "green", title: "In arrivo verso le 13:02", subtitle: est });
    expect(r.stops).toEqual([
      { name: "Partenza ritorno", time: "12:13", kind: "detected", state: "passed" },
      { name: "Fermata ritorno", time: "13:02", kind: "estimate", state: "target", scheduled: "13:00" },
    ]);
    expect(r.moving_after).toBe("Partenza ritorno");
    expect(r.delay_min).toBe(2);
  });

  it("uses the delay measured at the origin, not the train's current delay", () => {
    const r = run(train({ left: at("12:13"), delay: 0 }), "12:14");
    expect(r.light.title).toBe("In arrivo verso le 13:02");
    expect(r.delay_min).toBe(2);
  });

  it("left, delay over threshold", () => {
    const r = run(train({ left: at("12:17"), delay: 6 }), "12:18");
    expect(r.light).toEqual({ color: "yellow", title: "In ritardo, verso le 13:06", subtitle: est });
  });

  it("delay exactly at threshold stays green", () => {
    expect(run(train({ left: at("12:16"), delay: 5 }), "12:17").light.color).toBe("green");
  });

  it("probably passed", () => {
    const r = run(train({ left: at("12:13"), delay: 2 }), "13:06");
    expect(r.light).toEqual({ color: "grey", title: "Probabilmente passato", subtitle: "" });
    expect(r.moving_after).toBeNull();
  });

  it("cancelled return stop", () => {
    const t = train();
    t.stops[1].cancelled = true;
    expect(run(t, "12:05").light).toEqual({ color: "red", title: "Treno soppresso", subtitle: "" });
  });

  it("origin-only cancellation is not a cancellation", () => {
    const t = train();
    t.stops[0].cancelled = true;
    expect(run(t, "12:05").light.title).not.toBe("Treno soppresso");
  });

  it("not running", () => {
    expect(run("not_running", "12:05").light.title).toBe("Oggi questo treno non circola");
  });

  it("missing return stop gives an error status", () => {
    const t = train();
    t.stops.pop();
    expect(run(t, "12:05").ok).toBe(false);
  });
});
