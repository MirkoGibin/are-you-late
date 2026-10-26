import { describe, expect, it } from "vitest";
import { formatHHMM, minutesToHHMM, parseHHMM, romeClock, romeMinutesOf } from "../src/time";

describe("romeClock", () => {
  it("winter time (CET)", () => {
    expect(romeClock(Date.parse("2026-10-26T06:00:00Z"))).toEqual({
      minutes: 420,
      midnightMs: Date.parse("2026-10-25T23:00:00Z"),
    });
  });

  it("summer time (CEST)", () => {
    expect(romeClock(Date.parse("2026-07-01T06:00:00Z"))).toEqual({
      minutes: 480,
      midnightMs: Date.parse("2026-06-30T22:00:00Z"),
    });
  });

  it("DST end day uses wall-clock minutes and the CEST midnight", () => {
    expect(romeClock(Date.parse("2026-10-25T12:00:00Z"))).toEqual({
      minutes: 780,
      midnightMs: Date.parse("2026-10-24T22:00:00Z"),
    });
  });

  it("just after Rome midnight belongs to the new day", () => {
    expect(romeClock(Date.parse("2026-10-25T23:30:00Z"))).toEqual({
      minutes: 30,
      midnightMs: Date.parse("2026-10-25T23:00:00Z"),
    });
  });
});

describe("helpers", () => {
  it("romeMinutesOf on DST end day", () => {
    expect(romeMinutesOf(Date.parse("2026-10-25T06:54:00Z"))).toBe(474);
  });

  it("formatHHMM", () => {
    expect(formatHHMM(Date.parse("2026-10-26T07:08:00Z"))).toBe("08:08");
  });

  it("parseHHMM", () => {
    expect(parseHHMM("13:00")).toBe(780);
  });

  it("minutesToHHMM wraps around the day", () => {
    expect(minutesToHHMM(1017)).toBe("16:57");
    expect(minutesToHHMM(-1)).toBe("23:59");
    expect(minutesToHHMM(1440)).toBe("00:00");
  });
});
