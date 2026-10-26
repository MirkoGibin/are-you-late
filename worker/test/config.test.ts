import { describe, expect, it } from "vitest";
import example from "../route-config.example.json";
import { parseConfig } from "../src/config";

const raw = () => JSON.parse(JSON.stringify(example));
const parse = (obj: unknown) => parseConfig(JSON.stringify(obj));

describe("parseConfig", () => {
  it("parses the example config", () => {
    expect(parse(example)).toEqual(example);
  });

  it("rejects bad station code", () => {
    const c = raw();
    c.outbound.origin.code = "X1";
    expect(parse(c)).toBeNull();
  });

  it("rejects bad train number", () => {
    const c = raw();
    c.return.train = "12a";
    expect(parse(c)).toBeNull();
  });

  it.each(["7:00", "24:00", "12:60"])("rejects bad time %s", (t) => {
    const c = raw();
    c.outbound.userStop.scheduled = t;
    expect(parse(c)).toBeNull();
  });

  it("rejects label longer than 40 chars", () => {
    const c = raw();
    c.outbound.checkpoint.label = "x".repeat(41);
    expect(parse(c)).toBeNull();
  });

  it("rejects empty label", () => {
    const c = raw();
    c.return.origin.label = "";
    expect(parse(c)).toBeNull();
  });

  it.each([-1, 31, 2.5])("rejects offsetMin %s", (v) => {
    const c = raw();
    c.outbound.userStop.offsetMin = v;
    expect(parse(c)).toBeNull();
  });

  it("rejects missing thresholds", () => {
    const c = raw();
    delete c.thresholds;
    expect(parse(c)).toBeNull();
  });

  it("rejects non-JSON and undefined", () => {
    expect(parseConfig("not json")).toBeNull();
    expect(parseConfig(undefined)).toBeNull();
  });

  it("drops unknown fields", () => {
    const c = raw();
    c.extra = "x";
    c.outbound.origin.extra = "y";
    expect(parse(c)).toEqual(example);
  });
});
