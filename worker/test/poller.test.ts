import { describe, expect, it, vi } from "vitest";
import example from "../route-config.example.json";
import { parseConfig } from "../src/config";
import { runOnce } from "../src/poller";
import { computeStatus, errorStatus } from "../src/status";
import type { RouteConfig } from "../src/types";
import { parseTrain, upstreamUrl } from "../src/viaggiatreno";
import { at, makeRaw } from "./helpers";

const cfg = parseConfig(JSON.stringify(example)) as RouteConfig;
const PUSH_URL = "https://worker.example/push";
const NOW = at("07:55");
const MIDNIGHT = Date.parse("2026-10-26T23:00:00Z");
const upstreamBody = makeRaw({
  ritardo: 23,
  fermate: [
    { id: "S00000", programmata: at("07:31"), effettiva: at("07:54") },
    { id: "S00001", programmata: at("07:45") },
  ],
});
const env = { ROUTE_CONFIG: JSON.stringify(example), PUSH_URL, PUSH_TOKEN: "secret-token" };

function fetchStub(o: { upstream?: () => Response | Promise<Response>; push?: () => Response | Promise<Response> } = {}) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    if (String(url) === PUSH_URL) return (o.push ?? (() => new Response(null, { status: 204 })))();
    return (o.upstream ?? (() => new Response(upstreamBody)))();
  });
}

const run = (e: Parameters<typeof runOnce>[0], f: ReturnType<typeof fetchStub>, now = NOW) =>
  runOnce(e, { fetchFn: f as unknown as typeof fetch, now: () => now });

describe("runOnce", () => {
  it("makes one upstream call for the current leg, then one push", async () => {
    const f = fetchStub();
    expect(await run(env, f)).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[0][0]).toBe(upstreamUrl(cfg.outbound.origin.code, cfg.outbound.train, MIDNIGHT));

    const [url, init] = f.mock.calls[1];
    expect(url).toBe(PUSH_URL);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer secret-token", "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({
      leg: "outbound",
      status: computeStatus("outbound", parseTrain(upstreamBody) as never, NOW, cfg),
    });
  });

  it("selects the return leg after the switch time", async () => {
    const f = fetchStub();
    await run(env, f, at("12:30"));
    expect(f.mock.calls[0][0]).toBe(upstreamUrl(cfg.return.origin.code, cfg.return.train, MIDNIGHT));
    expect(JSON.parse(f.mock.calls[1][1]?.body as string).leg).toBe("return");
  });

  it.each<[string, () => Response | Promise<Response>]>([
    ["HTTP error", () => new Response("denied", { status: 403 })],
    ["network failure", () => Promise.reject(new Error("down"))],
  ])("upstream %s → pushes errorStatus for the leg", async (_n, upstream) => {
    const f = fetchStub({ upstream });
    expect(await run(env, f)).toBe(true);
    expect(JSON.parse(f.mock.calls[1][1]?.body as string)).toEqual({ leg: "outbound", status: errorStatus(NOW) });
  });

  it("a train that does not run is pushed as a normal status", async () => {
    const f = fetchStub({ upstream: () => new Response(null, { status: 204 }) });
    expect(await run(env, f)).toBe(true);
    expect(JSON.parse(f.mock.calls[1][1]?.body as string).status).toEqual(computeStatus("outbound", "not_running", NOW, cfg));
  });

  it.each<[string, Parameters<typeof runOnce>[0]]>([
    ["invalid config", { ...env, ROUTE_CONFIG: "{bad" }],
    ["missing config", { ...env, ROUTE_CONFIG: undefined }],
    ["missing push URL", { ...env, PUSH_URL: undefined }],
    ["missing token", { ...env, PUSH_TOKEN: undefined }],
    ["empty token", { ...env, PUSH_TOKEN: "" }],
  ])("%s → no network calls, false", async (_n, e) => {
    const f = fetchStub();
    expect(await run(e, f)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it.each<[string, () => Response | Promise<Response>]>([
    ["answers 401", () => new Response(null, { status: 401 })],
    ["answers 503", () => new Response(null, { status: 503 })],
    ["throws", () => Promise.reject(new Error("down"))],
  ])("push %s → false", async (_n, push) => {
    expect(await run(env, fetchStub({ push }))).toBe(false);
  });

  it("never writes the token, route values or upstream data to its logs", async () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    const f = fetchStub({ push: () => new Response(null, { status: 401 }) });
    await runOnce(env, { fetchFn: f as unknown as typeof fetch, now: () => NOW, log });
    await runOnce(env, { fetchFn: fetchStub() as unknown as typeof fetch, now: () => NOW, log });
    expect(lines).toEqual(["push failed status=401", "push ok leg=outbound color=yellow"]);
  });

  it("logs a config error without any value", async () => {
    const lines: string[] = [];
    await runOnce({ ...env, ROUTE_CONFIG: "{bad" }, { fetchFn: fetchStub() as unknown as typeof fetch, now: () => NOW, log: (l) => lines.push(l) });
    expect(lines).toEqual(["config error"]);
  });

  it("logs a network failure without its message, which may hold the URL", async () => {
    const lines: string[] = [];
    const f = fetchStub({ push: () => Promise.reject(new Error(`failed ${PUSH_URL}`)) });
    await runOnce(env, { fetchFn: f as unknown as typeof fetch, now: () => NOW, log: (l) => lines.push(l) });
    expect(lines).toEqual(["push failed network"]);
  });
});
