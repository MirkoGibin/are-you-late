import { describe, expect, it, vi } from "vitest";
import { handle, safeEqual, type Env, type KVLike } from "../src/index";
import { errorStatus } from "../src/status";
import type { StatusResponse } from "../src/types";
import { at } from "./helpers";

const ORIGIN = "https://pages.example";
const TOKEN = "a".repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}` };

const status = (direction: "outbound" | "return", hhmm: string): StatusResponse => ({
  ok: true,
  direction,
  delay_min: 3,
  light: { color: "yellow", title: "Titolo", subtitle: "" },
  stops: [{ name: "Partenza", time: "07:50", kind: "detected", state: "passed" }],
  moving_after: "Partenza",
  updated_at: new Date(at(hhmm)).toISOString(),
});

function memoryKV(initial: Record<string, string> = {}, failing: { get?: boolean; put?: boolean } = {}) {
  const data = new Map(Object.entries(initial));
  const kv: KVLike = {
    async get(k) {
      if (failing.get) throw new Error("kv get failed");
      return data.get(k) ?? null;
    },
    async put(k, v) {
      if (failing.put) throw new Error("kv put failed");
      data.set(k, v);
    },
  };
  return { kv, data };
}

function setup(o: { stored?: Record<string, string>; failing?: { get?: boolean; put?: boolean }; limited?: boolean; token?: string | null } = {}) {
  const { kv, data } = memoryKV(o.stored, o.failing);
  const limit = vi.fn(async () => ({ success: !o.limited }));
  const env: Env = {
    ALLOWED_ORIGIN: ORIGIN,
    PUSH_TOKEN: o.token === null ? undefined : (o.token ?? TOKEN),
    STATUS: kv,
    RATE_LIMITER: { limit },
  };
  const deps = { now: () => at("07:55") };
  const call = (path: string, init?: RequestInit) => {
    const headers = { "cf-connecting-ip": "203.0.113.7", ...init?.headers };
    return handle(new Request(`https://worker.example${path}`, { ...init, headers }), env, deps);
  };
  const push = (body: BodyInit, headers: Record<string, string> = AUTH) => call("/push", { method: "POST", headers, body });
  return { call, push, data, limit };
}

const throwingBody = () =>
  new ReadableStream({
    pull() {
      throw new Error("body was read");
    },
  });

const streamOf = (bytes: number) =>
  new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(bytes).fill(32));
      c.close();
    },
  });

const validPush = () => JSON.stringify({ leg: "outbound", status: status("outbound", "07:54") });

describe("routing", () => {
  it("POST /status → 405", async () => {
    expect((await setup().call("/status", { method: "POST", body: "x" })).status).toBe(405);
  });

  it.each(["/", "/status/x", "/statusx", "/push/x"])("GET %s → 404", async (p) => {
    expect((await setup().call(p)).status).toBe(404);
  });

  it.each(["sideways", "", "OUTBOUND"])("GET /status?dir=%s → 400", async (d) => {
    expect((await setup().call(`/status?dir=${d}`)).status).toBe(400);
  });

  it("repeated dir → 400", async () => {
    expect((await setup().call("/status?dir=outbound&dir=return")).status).toBe(400);
  });

  it("the body of a rejected POST /status is never read", async () => {
    const r = await setup().call("/status", { method: "POST", body: throwingBody(), duplex: "half" } as RequestInit);
    expect(r.status).toBe(405);
  });

  it.each(["GET", "OPTIONS", "PUT", "DELETE"])("%s /push → 405 without CORS", async (method) => {
    const r = await setup().call("/push", { method });
    expect(r.status).toBe(405);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("GET /status", () => {
  it("no stored keys → 200 ok:false", async () => {
    const r = await setup().call("/status");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(errorStatus(at("07:55")));
  });

  it("returns CORS and security headers", async () => {
    const r = await setup().call("/status");
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(r.headers.get("vary")).toBe("Origin");
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("public, max-age=30");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("both stored → the one with the newer updated_at", async () => {
    const newer = JSON.stringify(status("return", "12:30"));
    const older = JSON.stringify(status("outbound", "08:59"));
    const r = await setup({ stored: { "status:outbound": older, "status:return": newer } }).call("/status");
    expect(await r.text()).toBe(newer);
  });

  it("only one stored → that one", async () => {
    const only = JSON.stringify(status("outbound", "07:50"));
    const r = await setup({ stored: { "status:outbound": only } }).call("/status");
    expect(await r.text()).toBe(only);
  });

  it("dir selects that key even when the other is newer", async () => {
    const older = JSON.stringify(status("outbound", "08:59"));
    const newer = JSON.stringify(status("return", "12:30"));
    const r = await setup({ stored: { "status:outbound": older, "status:return": newer } }).call("/status?dir=outbound");
    expect(await r.text()).toBe(older);
  });

  it("dir with a missing key → ok:false", async () => {
    const other = JSON.stringify(status("outbound", "07:50"));
    const r = await setup({ stored: { "status:outbound": other } }).call("/status?dir=return");
    expect(((await r.json()) as StatusResponse).ok).toBe(false);
  });

  it("returns updated_at as stored, so an old status stays visibly old", async () => {
    const old = status("outbound", "06:00");
    const r = await setup({ stored: { "status:outbound": JSON.stringify(old) } }).call("/status");
    expect(((await r.json()) as StatusResponse).updated_at).toBe(old.updated_at);
  });

  it("a corrupt stored value counts as missing", async () => {
    const good = JSON.stringify(status("return", "12:30"));
    const r = await setup({ stored: { "status:outbound": "{bad", "status:return": good } }).call("/status");
    expect(await r.text()).toBe(good);
  });

  it("KV read failure → 200 ok:false", async () => {
    const r = await setup({ failing: { get: true } }).call("/status");
    expect(r.status).toBe(200);
    expect(((await r.json()) as StatusResponse).ok).toBe(false);
  });

  it("OPTIONS /status → 204 with CORS headers", async () => {
    const r = await setup().call("/status", { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(r.headers.get("access-control-allow-methods")).toBe("GET");
    expect(r.headers.get("access-control-max-age")).toBe("86400");
  });
});

describe("POST /push authentication", () => {
  it.each<[string, Record<string, string>]>([
    ["no header", {}],
    ["wrong token, same length", { Authorization: `Bearer ${"b".repeat(64)}` }],
    ["wrong token, shorter", { Authorization: "Bearer x" }],
    ["wrong token, longer", { Authorization: `Bearer ${TOKEN}x` }],
    ["wrong scheme", { Authorization: `Basic ${TOKEN}` }],
  ])("%s → 401 and the body is never read", async (_n, headers) => {
    const s = setup();
    const r = await s.call("/push", { method: "POST", headers, body: throwingBody(), duplex: "half" } as RequestInit);
    expect(r.status).toBe(401);
    expect(s.data.size).toBe(0);
  });

  it.each<[string, string | null]>([
    ["unset", null],
    ["empty", ""],
  ])("PUSH_TOKEN %s → 401 even for an empty bearer", async (_n, token) => {
    const s = setup({ token });
    expect((await s.push(validPush(), { Authorization: "Bearer " })).status).toBe(401);
    expect((await s.push(validPush(), { Authorization: "Bearer undefined" })).status).toBe(401);
  });
});

describe("POST /push body", () => {
  it("valid → 204 and KV holds the re-serialised clean status", async () => {
    const s = setup();
    const dirty = { ...status("outbound", "07:54"), train: "00000", extra: { a: 1 } };
    const r = await s.push(JSON.stringify({ leg: "outbound", status: dirty }));
    expect(r.status).toBe(204);
    expect(JSON.parse(s.data.get("status:outbound") as string)).toEqual(status("outbound", "07:54"));
    expect(s.data.has("status:return")).toBe(false);
  });

  it("the return leg goes to its own key", async () => {
    const s = setup();
    const r = await s.push(JSON.stringify({ leg: "return", status: status("return", "12:30") }));
    expect(r.status).toBe(204);
    expect(s.data.has("status:return")).toBe(true);
  });

  it("accepts an error status", async () => {
    const s = setup();
    expect((await s.push(JSON.stringify({ leg: "outbound", status: errorStatus(at("07:55")) }))).status).toBe(204);
  });

  it("a declared length over 8 KB → 413 and the body is never read", async () => {
    const s = setup();
    const r = await s.call("/push", {
      method: "POST",
      headers: { ...AUTH, "Content-Length": "9000" },
      body: throwingBody(),
      duplex: "half",
    } as RequestInit);
    expect(r.status).toBe(413);
  });

  it("9000 streamed bytes without a length → 413", async () => {
    const r = await setup().call("/push", { method: "POST", headers: AUTH, body: streamOf(9000), duplex: "half" } as RequestInit);
    expect(r.status).toBe(413);
  });

  it("exactly 8192 bytes is read, not rejected as too large", async () => {
    const body = validPush().padEnd(8192, " ");
    const s = setup();
    expect((await s.push(body)).status).toBe(204);
  });

  it.each<[string, string]>([
    ["invalid JSON", "{bad"],
    ["empty", ""],
    ["not an object", "[]"],
    ["unknown leg", JSON.stringify({ leg: "sideways", status: status("outbound", "07:54") })],
    ["missing status", JSON.stringify({ leg: "outbound" })],
    ["invalid status", JSON.stringify({ leg: "outbound", status: { ok: "yes" } })],
  ])("%s → 400 and nothing stored", async (_n, body) => {
    const s = setup();
    expect((await s.push(body)).status).toBe(400);
    expect(s.data.size).toBe(0);
  });

  it("KV write failure → 503", async () => {
    expect((await setup({ failing: { put: true } }).push(validPush())).status).toBe(503);
  });

  it("no CORS header on any /push response", async () => {
    const s = setup();
    for (const r of [await s.push(validPush()), await s.push("{bad"), await s.push(validPush(), {})]) {
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("no response caching on /push", async () => {
    expect((await setup().push("{bad")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("safeEqual", () => {
  it.each<[string, string, boolean]>([
    ["abc", "abc", true],
    ["", "", true],
    ["abc", "abd", false],
    ["abc", "abcd", false],
    ["abcd", "abc", false],
    ["abc", "", false],
  ])("%j vs %j → %s", (a, b, expected) => {
    expect(safeEqual(a, b)).toBe(expected);
  });
});

describe("rate limit", () => {
  it("GET limited → 429, keyed by client IP", async () => {
    const s = setup({ limited: true });
    expect((await s.call("/status")).status).toBe(429);
    expect(s.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
  });

  it("POST /push limited → 429 before auth and nothing stored", async () => {
    const s = setup({ limited: true });
    const r = await s.call("/push", { method: "POST", body: throwingBody(), duplex: "half" } as RequestInit);
    expect(r.status).toBe(429);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(s.data.size).toBe(0);
  });
});

describe("no upstream", () => {
  it("never calls fetch and never reads ROUTE_CONFIG", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const s = setup();
    await s.call("/status");
    await s.push(validPush());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
