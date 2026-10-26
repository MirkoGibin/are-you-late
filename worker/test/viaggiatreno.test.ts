import { describe, expect, it } from "vitest";
import { fetchTrain, parseTrain, upstreamUrl } from "../src/viaggiatreno";
import { at, makeRaw } from "./helpers";

const two = () => [
  { id: "S00000", programmata: at("07:31"), effettiva: at("07:54") },
  { id: "S00001", programmata: at("07:45") },
];

describe("upstreamUrl", () => {
  it("builds the andamentoTreno URL", () => {
    expect(upstreamUrl("S00000", "00000", 1761433200000)).toBe(
      "https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/andamentoTreno/S00000/00000/1761433200000",
    );
  });
});

describe("parseTrain", () => {
  it("parses stops and delay", () => {
    expect(parseTrain(makeRaw({ ritardo: 23, fermate: two() }))).toEqual({
      delayMin: 23,
      cancelled: false,
      stops: [
        { code: "S00000", scheduledMs: at("07:31"), actualMs: at("07:54"), cancelled: false },
        { code: "S00001", scheduledMs: at("07:45"), actualMs: null, cancelled: false },
      ],
    });
  });

  it.each(["", "  "])("empty body %j means not running", (b) => {
    expect(parseTrain(b)).toBe("not_running");
  });

  it("effettiva 0 is treated as not detected", () => {
    const t = parseTrain(makeRaw({ fermate: [{ id: "S00000", programmata: at("07:31"), effettiva: 0 }] }));
    expect(t !== null && t !== "not_running" && t.stops[0].actualMs).toBeNull();
  });

  it.each([
    ["HTML", "<html><body>error</body></html>"],
    ["JSON array", "[1,2]"],
    ["fermate not an array", JSON.stringify({ ritardo: 0, fermate: {} })],
    ["empty fermate", JSON.stringify({ ritardo: 0, fermate: [] })],
    ["programmata as string", JSON.stringify({ ritardo: 0, fermate: [{ id: "S00000", programmata: "x" }] })],
    ["ritardo as string", JSON.stringify({ ritardo: "5", fermate: [{ id: "S00000", programmata: 1 }] })],
    ["id too long", makeRaw({ fermate: [{ id: "S".repeat(11), programmata: at("07:31") }] })],
    [
      "timestamps far apart",
      makeRaw({ fermate: [{ id: "S00000", programmata: at("07:31") }, { id: "S00001", programmata: at("07:31") + 3 * 86400000 }] }),
    ],
  ])("rejects %s", (_name, body) => {
    expect(parseTrain(body)).toBeNull();
  });

  it("clamps absurd delays", () => {
    const t = parseTrain(makeRaw({ ritardo: 99999, fermate: two() }));
    expect(t !== null && t !== "not_running" && t.delayMin).toBe(600);
  });

  it.each([
    ["tipoTreno ST", { tipoTreno: "ST" }],
    ["provvedimento 1", { provvedimento: 1 }],
  ])("flags a cancelled train (%s)", (_n, flags) => {
    const t = parseTrain(makeRaw({ ...flags, fermate: two() }));
    expect(t !== null && t !== "not_running" && t.cancelled).toBe(true);
  });

  it("flags a cancelled stop", () => {
    const t = parseTrain(makeRaw({ fermate: [{ id: "S00000", programmata: at("07:31"), actualFermataType: 3 }] }));
    expect(t !== null && t !== "not_running" && t.stops[0].cancelled).toBe(true);
  });
});

describe("fetchTrain", () => {
  const ok = (body: string, status = 200) => async () => new Response(status === 204 ? null : body, { status });

  it("returns the parsed train", async () => {
    const t = await fetchTrain("u", ok(makeRaw({ fermate: two() })) as typeof fetch);
    expect(t !== null && t !== "not_running" && t.stops.length).toBe(2);
  });

  it("times out on a hanging upstream", async () => {
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    expect(await fetchTrain("u", hang, 50)).toBeNull();
  });

  it("HTTP 500 gives null", async () => {
    expect(await fetchTrain("u", ok("x", 500) as typeof fetch)).toBeNull();
  });

  it("HTTP 204 means not running", async () => {
    expect(await fetchTrain("u", ok("", 204) as typeof fetch)).toBe("not_running");
  });

  it("a body over 1 MB gives null", async () => {
    expect(await fetchTrain("u", ok("x".repeat(2 * 1024 * 1024)) as typeof fetch)).toBeNull();
  });

  it("a network error gives null", async () => {
    const boom = (async () => {
      throw new Error("net");
    }) as typeof fetch;
    expect(await fetchTrain("u", boom)).toBeNull();
  });
});
