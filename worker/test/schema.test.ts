import { describe, expect, it } from "vitest";
import example from "../route-config.example.json";
import { parseConfig } from "../src/config";
import { parseStatus } from "../src/schema";
import { computeStatus, errorStatus } from "../src/status";
import type { RouteConfig, StatusResponse, Train } from "../src/types";
import { at } from "./helpers";

const cfg = parseConfig(JSON.stringify(example)) as RouteConfig;

const outboundTrain: Train = {
  delayMin: 23,
  cancelled: false,
  stops: [
    { code: "S00000", scheduledMs: at("07:31"), actualMs: at("07:54"), cancelled: false },
    { code: "S00001", scheduledMs: at("07:45"), actualMs: null, cancelled: false },
  ],
};

const returnTrain: Train = {
  delayMin: 2,
  cancelled: false,
  stops: [
    { code: "S00002", scheduledMs: at("12:11"), actualMs: at("12:13"), cancelled: false },
    { code: "S00003", scheduledMs: at("13:00"), actualMs: null, cancelled: false },
  ],
};

const valid = (): StatusResponse => computeStatus("outbound", outboundTrain, at("07:55"), cfg);

describe("parseStatus round trips", () => {
  it.each([
    ["outbound", () => valid()],
    ["return", () => computeStatus("return", returnTrain, at("12:14"), cfg)],
    ["not running", () => computeStatus("outbound", "not_running", at("07:55"), cfg)],
    ["error", () => errorStatus(at("07:55"))],
  ])("keeps a %s status unchanged", (_n, make) => {
    const s = make();
    expect(parseStatus(s)).toEqual(s);
  });

  it("returns a new object", () => {
    const s = valid();
    expect(parseStatus(s)).not.toBe(s);
  });
});

describe("parseStatus rejects", () => {
  const mutated = (f: (s: Record<string, any>) => void) => {
    const s = JSON.parse(JSON.stringify(valid()));
    f(s);
    return s;
  };

  it.each<[string, unknown]>([
    ["array input", []],
    ["null input", null],
    ["string input", "ok"],
    ["ok not boolean", mutated((s) => (s.ok = "true"))],
    ["missing light", mutated((s) => delete s.light)],
    ["unknown colour", mutated((s) => (s.light.color = "blue"))],
    ["long title", mutated((s) => (s.light.title = "x".repeat(81)))],
    ["long subtitle", mutated((s) => (s.light.subtitle = "x".repeat(81)))],
    ["unknown direction", mutated((s) => (s.direction = "sideways"))],
    ["unknown kind", mutated((s) => (s.stops[0].kind = "guess"))],
    ["unknown state", mutated((s) => (s.stops[0].state = "gone"))],
    ["long stop name", mutated((s) => (s.stops[0].name = "x".repeat(81)))],
    ["stop not an object", mutated((s) => (s.stops[0] = "x"))],
    ["stops not an array", mutated((s) => (s.stops = {}))],
    ["six stops", mutated((s) => (s.stops = Array(6).fill(s.stops[0])))],
    ["fractional delay", mutated((s) => (s.delay_min = 2.5))],
    ["delay too high", mutated((s) => (s.delay_min = 601))],
    ["delay too low", mutated((s) => (s.delay_min = -61))],
    ["updated_at not ISO", mutated((s) => (s.updated_at = "yesterday"))],
    ["updated_at impossible date", mutated((s) => (s.updated_at = "2026-13-45T25:00:00.000Z"))],
    ["moving_after not a string", mutated((s) => (s.moving_after = 3))],
    ["long moving_after", mutated((s) => (s.moving_after = "x".repeat(81)))],
  ])("%s", (_n, input) => {
    expect(parseStatus(input)).toBeNull();
  });
});

describe("parseStatus cleans", () => {
  it("drops unknown fields at every level", () => {
    const s = JSON.parse(JSON.stringify(valid()));
    s.train = "00000";
    s.extra = { a: 1 };
    s.light.extra = "x";
    s.stops[0].extra = "x";
    expect(parseStatus(s)).toEqual(valid());
  });

  it("does not invent absent optional fields", () => {
    const parsed = parseStatus(errorStatus(at("07:55")));
    expect(Object.keys(parsed as object).sort()).toEqual(["light", "ok", "updated_at"]);
  });

  it("keeps moving_after null distinct from absent", () => {
    const parsed = parseStatus({ ...valid(), moving_after: null });
    expect(parsed?.moving_after).toBeNull();
  });
});
