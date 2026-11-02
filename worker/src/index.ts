import { parseStatus } from "./schema";
import { errorStatus } from "./status";
import type { Leg, StatusResponse } from "./types";

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface Env {
  ALLOWED_ORIGIN: string;
  PUSH_TOKEN?: string;
  STATUS: KVLike;
  RATE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

export interface Deps {
  now: () => number;
}

const LEGS: readonly string[] = ["outbound", "return"];
const MAX_PUSH_BYTES = 8192;
const keyOf = (leg: Leg) => `status:${leg}`;

function respond(env: Env, status: number, body: string | null, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
      Vary: "Origin",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=30",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

const fail = (env: Env, status: number, error: string) => respond(env, status, JSON.stringify({ error }));

/** Server-to-server answer: no CORS, never cached. */
function pushAnswer(status: number, error?: string): Response {
  return new Response(error === undefined ? null : JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Compares every byte up to the longer input, so the time does not reveal where or whether they differ. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function allowed(req: Request, env: Env): Promise<boolean> {
  if (!env.RATE_LIMITER) return true;
  const key = req.headers.get("cf-connecting-ip") ?? "unknown";
  return (await env.RATE_LIMITER.limit({ key })).success;
}

/** Reads at most MAX_PUSH_BYTES. Returns null when the body is larger. */
async function readLimited(req: Request): Promise<Uint8Array | null> {
  const out = new Uint8Array(MAX_PUSH_BYTES);
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > MAX_PUSH_BYTES) {
        await reader.cancel();
        return null;
      }
      out.set(value, size);
      size += value.length;
    }
  }
  return out.subarray(0, size);
}

function parsePush(bytes: Uint8Array): { leg: Leg; status: StatusResponse } | null {
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as { leg?: unknown; status?: unknown } | null;
    if (typeof v?.leg !== "string" || !LEGS.includes(v.leg)) return null;
    const status = parseStatus(v.status);
    return status && { leg: v.leg as Leg, status };
  } catch {
    return null;
  }
}

async function handlePush(req: Request, env: Env): Promise<Response> {
  try {
    if (req.method !== "POST") return pushAnswer(405, "method_not_allowed");
    if (!(await allowed(req, env))) return pushAnswer(429, "rate_limited");
    // Everything above and including this check runs before the body is touched.
    const token = env.PUSH_TOKEN;
    const given = req.headers.get("authorization") ?? "";
    if (!token || !safeEqual(given, `Bearer ${token}`)) return pushAnswer(401, "unauthorized");

    if (Number(req.headers.get("content-length") ?? 0) > MAX_PUSH_BYTES) return pushAnswer(413, "too_large");
    const bytes = await readLimited(req);
    if (bytes === null) return pushAnswer(413, "too_large");
    const push = parsePush(bytes);
    if (!push) return pushAnswer(400, "invalid");

    await env.STATUS.put(keyOf(push.leg), JSON.stringify(push.status));
    return pushAnswer(204);
  } catch {
    return pushAnswer(503, "unavailable");
  }
}

/** Stored JSON for a leg, with its time. A corrupt value counts as missing. */
async function readLeg(env: Env, leg: Leg): Promise<{ body: string; at: number } | null> {
  const body = await env.STATUS.get(keyOf(leg));
  if (body === null) return null;
  try {
    const parsed = parseStatus(JSON.parse(body));
    return parsed && { body, at: Date.parse(parsed.updated_at) };
  } catch {
    return null;
  }
}

async function handleStatus(req: Request, url: URL, env: Env, now: number): Promise<Response> {
  const unavailable = () => respond(env, 200, JSON.stringify(errorStatus(now)));
  try {
    if (req.method === "OPTIONS") {
      return respond(env, 204, null, { "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" });
    }
    const dirs = url.searchParams.getAll("dir");
    if (dirs.length > 1 || (dirs.length === 1 && !LEGS.includes(dirs[0]))) return fail(env, 400, "bad_dir");
    if (!(await allowed(req, env))) return fail(env, 429, "rate_limited");

    const legs = dirs.length === 1 ? [dirs[0] as Leg] : (["outbound", "return"] as const);
    const found = (await Promise.all(legs.map((l) => readLeg(env, l)))).filter((f) => f !== null);
    if (found.length === 0) return unavailable();
    const newest = found.reduce((a, b) => (b.at > a.at ? b : a));
    return respond(env, 200, newest.body);
  } catch {
    return unavailable();
  }
}

/** The only entry point: GET /status for the page, POST /push for the home poller. */
export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/push") return handlePush(req, env);
  if (req.method !== "GET" && req.method !== "OPTIONS") return fail(env, 405, "method_not_allowed");
  if (url.pathname !== "/status") return fail(env, 404, "not_found");
  return handleStatus(req, url, env, deps.now());
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, { now: Date.now });
  },
};
