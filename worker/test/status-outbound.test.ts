import { describe, expect, it } from "vitest";
import example from "../route-config.example.json";
import { parseConfig } from "../src/config";
import { computeStatus, errorStatus, selectLeg } from "../src/status";
import type { RouteConfig, StopRecord, Train } from "../src/types";
import { at } from "./helpers";

const cfg = parseConfig(JSON.stringify(example)) as RouteConfig;

// Fictional schedule: origin S00000 07:31, checkpoint S00001 07:45, user's stop 07:50 (checkpoint + 5).
function train(o: { origin?: number | null; checkpoint?: number | null; delay?: number; day?: string; offset?: string } = {}): Train {
  const day = o.day ?? "2026-10-27";
  const off = o.offset ?? "+01:00";
  const s = (code: string, hhmm: string, actual: number | null | undefined): StopRecord => ({
    code,
    scheduledMs: at(hhmm, day, off),
    actualMs: actual ?? null,
    cancelled: false,
  });
  return {
    delayMin: o.delay ?? 0,
    cancelled: false,
    stops: [s("S00000", "07:31", o.origin), s("S00001", "07:45", o.checkpoint), s("S00099", "08:40", null)],
  };
}

const run = (t: Train | "not_running", now: string) => computeStatus("outbound", t, at(now), cfg);

describe("outbound", () => {
  it("not departed", () => {
    const r = run(train(), "07:36");
    expect(r.ok).toBe(true);
    expect(r.direction).toBe("outbound");
    expect(r.light).toEqual({ color: "grey", title: "Non ancora partito", subtitle: "previsto 07:50" });
    expect(r.stops?.map((s) => s.kind)).toEqual(["scheduled", "scheduled", "scheduled"]);
    expect(r.stops?.map((s) => s.time)).toEqual(["07:31", "07:45", "07:50"]);
    expect(r.moving_after).toBeNull();
  });

  it("left origin", () => {
    const r = run(train({ origin: at("07:54"), delay: 23 }), "07:55");
    expect(r.light).toEqual({ color: "yellow", title: "Partito da Partenza", subtitle: "esci adesso" });
    expect(r.delay_min).toBe(23);
    expect(r.stops).toEqual([
      { name: "Partenza", time: "07:54", kind: "detected", state: "passed" },
      { name: "Checkpoint", time: "08:08", kind: "estimate", state: "next" },
      { name: "La tua fermata", time: "08:13", kind: "estimate", state: "target", scheduled: "07:50" },
    ]);
    expect(r.moving_after).toBe("Partenza");
  });

  it("left checkpoint", () => {
    const r = run(train({ origin: at("07:54"), checkpoint: at("08:08"), delay: 23 }), "08:09");
    expect(r.light).toEqual({ color: "red", title: "Lasciato Checkpoint", subtitle: "corri" });
    expect(r.stops?.[2].time).toBe("08:13");
    expect(r.stops?.map((s) => s.state)).toEqual(["passed", "passed", "target"]);
    expect(r.moving_after).toBe("Checkpoint");
  });

  it("delay_min is the delay at the user's stop, not the train's current delay", () => {
    const r = run(train({ origin: at("07:54"), checkpoint: at("08:08"), delay: 30 }), "08:09");
    expect(r.stops?.[2].time).toBe("08:13");
    expect(r.delay_min).toBe(23);
  });

  it("checkpoint detected, origin not", () => {
    const r = run(train({ checkpoint: at("08:08"), delay: 23 }), "08:09");
    expect(r.light.color).toBe("red");
    expect(r.light.title).toBe("Lasciato Checkpoint");
    expect(r.stops?.[0].state).toBe("passed");
  });

  it("passed", () => {
    const r = run(train({ origin: at("07:54"), checkpoint: at("08:08"), delay: 23 }), "08:17");
    expect(r.light).toEqual({ color: "green", title: "Treno passato alle 08:13", subtitle: "" });
    expect(r.moving_after).toBeNull();
  });

  it("still red within the grace period", () => {
    const r = run(train({ origin: at("07:54"), checkpoint: at("08:08"), delay: 23 }), "08:16");
    expect(r.light.color).toBe("red");
  });

  it("early train", () => {
    const r = run(train({ origin: at("07:30"), delay: -1 }), "07:31");
    expect(r.stops?.[2].time).toBe("07:49");
    expect(r.delay_min).toBe(-1);
  });

  it("DST change day", () => {
    const t = train({ origin: Date.parse("2026-10-25T06:54:00Z"), delay: 23, day: "2026-10-25" });
    const r = computeStatus("outbound", t, Date.parse("2026-10-25T06:55:00Z"), cfg);
    expect(r.stops?.[0].time).toBe("07:54");
    expect(r.stops?.[2].time).toBe("08:13");
  });

  it("not running", () => {
    const r = run("not_running", "07:15");
    expect(r.ok).toBe(true);
    expect(r.light).toEqual({ color: "grey", title: "Oggi questo treno non circola", subtitle: "" });
    expect(r.stops).toBeUndefined();
  });

  it("empty response before 05:00 is treated as not yet loaded", () => {
    const r = run("not_running", "04:30");
    expect(r.light).toEqual({ color: "grey", title: "Non ancora partito", subtitle: "previsto 07:50" });
  });

  it("whole train cancelled", () => {
    const t = { ...train(), cancelled: true };
    expect(run(t, "07:36").light).toEqual({ color: "red", title: "Treno soppresso", subtitle: "" });
  });

  it("a configured stop cancelled", () => {
    const t = train();
    t.stops[1].cancelled = true;
    expect(run(t, "07:36").light.title).toBe("Treno soppresso");
  });

  it("origin-only cancellation is not a cancellation (train starts later)", () => {
    const t = train({ checkpoint: at("08:08"), delay: 23 });
    t.stops[0].cancelled = true;
    const r = run(t, "08:09");
    expect(r.light.color).toBe("red");
    expect(r.light.title).toBe("Lasciato Checkpoint");
  });

  it("an unrelated stop cancelled does not matter", () => {
    const t = train();
    t.stops[2].cancelled = true;
    expect(run(t, "07:36").light.color).toBe("grey");
  });

  it("missing configured stop gives an error status", () => {
    const t = train();
    t.stops = t.stops.filter((s) => s.code !== "S00001");
    expect(run(t, "07:36").ok).toBe(false);
  });
});

describe("selectLeg", () => {
  it("switches at 12:00 Rome time", () => {
    expect(selectLeg(at("11:59"), cfg)).toBe("outbound");
    expect(selectLeg(at("12:00"), cfg)).toBe("return");
  });
});

describe("errorStatus", () => {
  it("is the fixed error object", () => {
    expect(errorStatus(Date.parse("2026-10-27T06:00:00Z"))).toEqual({
      ok: false,
      light: { color: "grey", title: "Dati non disponibili al momento", subtitle: "" },
      updated_at: "2026-10-27T06:00:00.000Z",
    });
  });
});
