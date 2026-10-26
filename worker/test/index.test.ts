import { describe, expect, it, vi } from "vitest";
import example from "../route-config.example.json";
import { handle, type Deps, type Env } from "../src/index";
import type { StatusResponse } from "../src/types";
import { at, makeRaw } from "./helpers";

const json = (r: Response) => r.json() as Promise<StatusResponse>;

const ORIGIN = "https://pages.example";
const outboundBody = makeRaw({
  ritardo: 23,
  fermate: [
    { id: "S00000", programmata: at("07:31"), effettiva: at("07:54"), stazione: "SECRET TOWN" },
    { id: "S00001", programmata: at("07:45"), stazione: "SECRET VILLAGE" },
  ],
});

function setup(o: { body?: string; fetchFn?: typeof fetch; limited?: boolean; config?: string | null; now?: number } = {}) {
  const fetchFn = vi.fn(o.fetchFn ?? (async () => new Response(o.body ?? outboundBody)));
  const limit = vi.fn(async () => ({ success: !o.limited }));
  let now = o.now ?? at("07:55");
  const env: Env = {
    ALLOWED_ORIGIN: ORIGIN,
    ROUTE_CONFIG: o.config === null ? undefined : (o.config ?? JSON.stringify(example)),
    RATE_LIMITER: { limit },
  };
  const deps: Deps = { fetchFn: fetchFn as unknown as typeof fetch, now: () => now, cache: new Map(), timeoutMs: 50 };
  const call = (path: string, init?: RequestInit) =>
    handle(new Request(`https://worker.example${path}`, { headers: { "cf-connecting-ip": "203.0.113.7" }, ...init }), env, deps);
  return { call, fetchFn, limit, advance: (ms: number) => (now += ms) };
}

describe("routing", () => {
  it("POST /status â†’ 405", async () => {
    expect((await setup().call("/status", { method: "POST", body: "x" })).status).toBe(405);
  });

  it.each(["/", "/status/x", "/statusx"])("GET %s â†’ 404", async (p) => {
    expect((await setup().call(p)).status).toBe(404);
  });

  it.each(["sideways", "", "OUTBOUND"])("GET /status?dir=%s â†’ 400", async (d) => {
    expect((await setup().call(`/status?dir=${d}`)).status).toBe(400);
  });

  it("repeated dir â†’ 400", async () => {
    expect((await setup().call("/status?dir=outbound&dir=return")).status).toBe(400);
  });

  it("the request body is never read", async () => {
    const body = new ReadableStream({
      pull() {
        throw new Error("body was read");
      },
    });
    const r = await setup().call("/status", { method: "POST", body, duplex: "half" } as RequestInit);
    expect(r.status).toBe(405);
  });
});

describe("GET /status", () => {
  it("returns the status with CORS and security headers", async () => {
    const r = await setup().call("/status?dir=outbound");
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(r.headers.get("vary")).toBe("Origin");
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("public, max-age=30");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const j = await json(r);
    expect(j.ok).toBe(true);
    expect(j.direction).toBe("outbound");
    expect(j.light.color).toBe("yellow");
  });

  it("calls upstream with a URL built from the config only", async () => {
    const s = setup();
    await s.call("/status?dir=outbound&evil=../../x");
    expect(s.fetchFn.mock.calls[0][0]).toBe(
      `https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/andamentoTreno/S00000/00000/${Date.parse("2026-10-26T23:00:00Z")}`,
    );
  });

  it("picks the leg by Rome time without dir", async () => {
    const body = makeRaw({
      fermate: [
        { id: "S00002", programmata: at("12:11") },
        { id: "S00003", programmata: at("13:00") },
      ],
    });
    const s = setup({ now: at("12:30"), body });
    const j = await json(await s.call("/status"));
    expect(j.direction).toBe("return");
    expect(j.ok).toBe(true);
    expect(s.fetchFn.mock.calls[0][0]).toContain("/andamentoTreno/S00002/00001/");
  });

  it("does not leak upstream station names or the train number", async () => {
    const text = await (await setup().call("/status?dir=outbound")).text();
    expect(text).not.toContain("SECRET");
    expect(JSON.parse(text)).not.toHaveProperty("train");
  });

  it("OPTIONS /status â†’ 204 with CORS headers", async () => {
    const r = await setup().call("/status", { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(r.headers.get("access-control-allow-methods")).toBe("GET");
    expect(r.headers.get("access-control-max-age")).toBe("86400");
  });
});

describe("abuse and failure handling", () => {
  it("rate limited â†’ 429, keyed by client IP", async () => {
    const s = setup({ limited: true });
    expect((await s.call("/status")).status).toBe(429);
    expect(s.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
    expect(s.fetchFn).not.toHaveBeenCalled();
  });

  it("caches per leg for 30 s", async () => {
    const s = setup();
    await s.call("/status?dir=outbound");
    s.advance(29_000);
    await s.call("/status?dir=outbound");
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
    s.advance(2_000);
    await s.call("/status?dir=outbound");
    expect(s.fetchFn).toHaveBeenCalledTimes(2);
  });

  it("upstream hang â†’ ok:false, not cached", async () => {
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    const s = setup({ fetchFn: hang });
    const r = await s.call("/status?dir=outbound");
    expect(r.status).toBe(200);
    expect((await json(r)).ok).toBe(false);
    await s.call("/status?dir=outbound");
    expect(s.fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["invalid", "{bad"],
    ["missing", null],
  ])("%s ROUTE_CONFIG â†’ ok:false without calling upstream", async (_n, config) => {
    const s = setup({ config });
    const r = await s.call("/status");
    expect((await json(r)).ok).toBe(false);
    expect(s.fetchFn).not.toHaveBeenCalled();
  });
});
