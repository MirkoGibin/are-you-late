import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import example from "../route-config.example.json";
import { parseConfig } from "../src/config";
import { computeStatus } from "../src/status";
import type { RouteConfig, Train } from "../src/types";
import { parseTrain } from "../src/viaggiatreno";

// An invented response with the real andamentoTreno shape: origin S00000, checkpoint S00001.
const body = readFileSync(join(import.meta.dirname, "fixtures", "andamento-anon.json"), "utf8");
const cfg = parseConfig(JSON.stringify(example)) as RouteConfig;

describe("fixture hygiene", () => {
  it("contains only invented data in the fields the parser reads, plus fixed noise", () => {
    const j = JSON.parse(body);
    expect(Object.keys(j).sort()).toEqual(["categoria", "destinazione", "fermate", "numeroTreno", "origine", "provvedimento", "ritardo", "tipoTreno"]);
    for (const f of j.fermate) expect(Object.keys(f).sort()).toEqual(["actualFermataType", "effettiva", "id", "programmata", "stazione"]);
    // Invented service day, far from any real capture.
    for (const f of j.fermate) expect(new Date(f.programmata).toISOString().slice(0, 10)).toBe("2030-01-15");
  });
});

describe("real-shaped upstream → status", () => {
  it("parses the anonymised fixture and renders config labels only", () => {
    const train = parseTrain(body) as Train;
    expect(train.stops).toHaveLength(3);
    const cp = train.stops[1];
    expect(cp.actualMs).not.toBeNull();

    const s = computeStatus("outbound", train, (cp.actualMs as number) + 60_000, cfg);
    expect(s.ok).toBe(true);
    expect(s.light.color).toBe("red");
    expect(s.stops?.map((x) => x.name)).toEqual(["Partenza", "Checkpoint", "La tua fermata"]);
    expect(JSON.stringify(s)).not.toContain("STAZIONE");
  });
});
