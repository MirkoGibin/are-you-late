import { parseConfig } from "./config";
import { computeStatus, errorStatus, selectLeg } from "./status";
import { romeClock } from "./time";
import type { Leg, StatusResponse } from "./types";
import { fetchTrain, upstreamUrl } from "./viaggiatreno";

export interface Env {
  ROUTE_CONFIG?: string;
  ALLOWED_ORIGIN: string;
  RATE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

export interface Deps {
  fetchFn: typeof fetch;
  now: () => number;
  cache: Map<Leg, { at: number; body: string }>;
  timeoutMs?: number;
}

const CACHE_MS = 30_000;
const LEGS: readonly string[] = ["outbound", "return"];

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
const status = (env: Env, s: StatusResponse) => respond(env, 200, JSON.stringify(s));

/** The only entry point. Never reads the request body; only `dir` is taken from the request. */
export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const now = deps.now();
  try {
    if (req.method !== "GET" && req.method !== "OPTIONS") return fail(env, 405, "method_not_allowed");
    const url = new URL(req.url);
    if (url.pathname !== "/status") return fail(env, 404, "not_found");
    if (req.method === "OPTIONS") {
      return respond(env, 204, null, { "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" });
    }

    const dirs = url.searchParams.getAll("dir");
    if (dirs.length > 1 || (dirs.length === 1 && !LEGS.includes(dirs[0]))) return fail(env, 400, "bad_dir");

    if (env.RATE_LIMITER) {
      const key = req.headers.get("cf-connecting-ip") ?? "unknown";
      if (!(await env.RATE_LIMITER.limit({ key })).success) return fail(env, 429, "rate_limited");
    }

    const cfg = parseConfig(env.ROUTE_CONFIG);
    if (!cfg) return status(env, errorStatus(now));
    const leg = (dirs[0] as Leg | undefined) ?? selectLeg(now, cfg);

    const hit = deps.cache.get(leg);
    if (hit && now - hit.at < CACHE_MS) return respond(env, 200, hit.body);

    const leg_ = cfg[leg];
    const url_ = upstreamUrl(leg_.origin.code, leg_.train, romeClock(now).midnightMs);
    const train = await fetchTrain(url_, deps.fetchFn, deps.timeoutMs);
    if (train === null) return status(env, errorStatus(now));

    const body = JSON.stringify(computeStatus(leg, train, now, cfg));
    deps.cache.set(leg, { at: now, body });
    return respond(env, 200, body);
  } catch {
    return status(env, errorStatus(now));
  }
}

const cache: Deps["cache"] = new Map();

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, { fetchFn: (u, i) => fetch(u, i), now: Date.now, cache });
  },
};
