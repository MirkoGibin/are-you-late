export interface RawStop {
  id: string;
  programmata: number;
  effettiva?: number | null;
  actualFermataType?: number;
  stazione?: string;
}

/** Builds upstream-shaped (andamentoTreno) JSON text with only the fields we read, plus some noise. */
export function makeRaw(opts: {
  ritardo?: number;
  tipoTreno?: string;
  provvedimento?: number;
  fermate: RawStop[];
}): string {
  return JSON.stringify({
    numeroTreno: 0,
    origine: "STAZIONE A",
    destinazione: "STAZIONE Z",
    ritardo: opts.ritardo ?? 0,
    tipoTreno: opts.tipoTreno ?? "PG",
    provvedimento: opts.provvedimento ?? 0,
    fermate: opts.fermate.map((f) => ({
      stazione: f.stazione ?? `STAZIONE ${f.id}`,
      id: f.id,
      programmata: f.programmata,
      effettiva: f.effettiva ?? null,
      actualFermataType: f.actualFermataType ?? 0,
    })),
  });
}

/** Epoch ms for a Rome wall-clock time on 2026-10-27 (CET, UTC+1). */
export const at = (hhmm: string, day = "2026-10-27", offset = "+01:00") =>
  Date.parse(`${day}T${hhmm}:00${offset}`);
