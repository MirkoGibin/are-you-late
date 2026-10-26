import type { StopRecord, Train } from "./types";

const BASE = "https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno";
const MAX_BODY = 1024 * 1024;
const MAX_SPAN_MS = 2 * 86400000;

export type TrainResult = Train | "not_running" | null;

/** Arguments come only from the validated route config. */
export function upstreamUrl(originCode: string, train: string, midnightMs: number): string {
  return `${BASE}/andamentoTreno/${originCode}/${train}/${midnightMs}`;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

class Invalid extends Error {}

function stop(v: unknown): StopRecord {
  if (typeof v !== "object" || v === null) throw new Invalid();
  const f = v as Record<string, unknown>;
  if (typeof f.id !== "string" || f.id.length < 1 || f.id.length > 10) throw new Invalid();
  if (!isNum(f.programmata)) throw new Invalid();
  if (f.effettiva != null && !isNum(f.effettiva)) throw new Invalid();
  if (f.actualFermataType != null && !isNum(f.actualFermataType)) throw new Invalid();
  return {
    code: f.id,
    scheduledMs: f.programmata,
    // ViaggiaTreno uses 0 or null for "not detected".
    actualMs: isNum(f.effettiva) && f.effettiva > 0 ? f.effettiva : null,
    cancelled: f.actualFermataType === 3,
  };
}

/** Validates an andamentoTreno body. Empty body → not running; anything malformed → null. */
export function parseTrain(body: string): TrainResult {
  if (body.trim() === "") return "not_running";
  try {
    const raw: unknown = JSON.parse(body);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const t = raw as Record<string, unknown>;
    if (!Array.isArray(t.fermate) || t.fermate.length === 0 || t.fermate.length > 100) return null;
    if (t.ritardo != null && !isNum(t.ritardo)) return null;
    const stops = t.fermate.map(stop);

    const times = stops.flatMap((s) => (s.actualMs === null ? [s.scheduledMs] : [s.scheduledMs, s.actualMs]));
    if (Math.max(...times) - Math.min(...times) > MAX_SPAN_MS) return null;

    const delay = isNum(t.ritardo) ? Math.round(t.ritardo) : 0;
    return {
      delayMin: Math.min(600, Math.max(-60, delay)),
      cancelled: t.tipoTreno === "ST" || t.provvedimento === 1,
      stops,
    };
  } catch {
    return null;
  }
}

async function readCapped(res: Response): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function fetchTrain(url: string, fetchFn: typeof fetch, timeoutMs = 5000): Promise<TrainResult> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 204) return "not_running";
    if (!res.ok) return null;
    const body = await readCapped(res);
    return body === null ? null : parseTrain(body);
  } catch {
    return null;
  }
}
