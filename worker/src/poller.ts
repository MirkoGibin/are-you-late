import { parseConfig } from "./config";
import { computeStatus, errorStatus, selectLeg } from "./status";
import { romeClock } from "./time";
import { fetchTrain, upstreamUrl } from "./viaggiatreno";

export interface PollerEnv {
  ROUTE_CONFIG?: string;
  PUSH_URL?: string;
  PUSH_TOKEN?: string;
}

export interface PollerDeps {
  fetchFn: typeof fetch;
  now: () => number;
  log?: (line: string) => void;
}

const PUSH_TIMEOUT_MS = 10_000;

/**
 * One poll: reads the train for the current leg and pushes the computed status.
 * Log lines carry no secrets, no route data and no error messages, which may hold URLs.
 */
export async function runOnce(env: PollerEnv, deps: PollerDeps): Promise<boolean> {
  const log = deps.log ?? (() => {});
  const cfg = parseConfig(env.ROUTE_CONFIG);
  if (!cfg || !env.PUSH_URL || !env.PUSH_TOKEN) {
    log("config error");
    return false;
  }

  const now = deps.now();
  const leg = selectLeg(now, cfg);
  const url = upstreamUrl(cfg[leg].origin.code, cfg[leg].train, romeClock(now).midnightMs);
  const train = await fetchTrain(url, deps.fetchFn);
  const status = train === null ? errorStatus(now) : computeStatus(leg, train, now, cfg);

  try {
    const res = await deps.fetchFn(env.PUSH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.PUSH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ leg, status }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (res.status !== 204) {
      log(`push failed status=${res.status}`);
      return false;
    }
  } catch {
    log("push failed network");
    return false;
  }
  log(`push ok leg=${leg} color=${status.light.color}`);
  return true;
}
