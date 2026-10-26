// Guard against committing the real route: values from the local .dev.vars must
// not appear in any file git would publish. Skipped where .dev.vars is absent (CI).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import example from "../route-config.example.json";

const workerDir = join(import.meta.dirname, "..");
const repoRoot = join(workerDir, "..");
const devVars = join(workerDir, ".dev.vars");

function realTokens(): string[] {
  const m = /ROUTE_CONFIG='(.*)'/.exec(readFileSync(devVars, "utf8"));
  if (!m) throw new Error("ROUTE_CONFIG not found in .dev.vars");
  const generic = new Set(JSON.stringify(example).match(/"[^"]*"/g)?.map((s) => s.slice(1, -1).toLowerCase()));
  const found = new Set<string>();
  const collect = (v: unknown, key = ""): void => {
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) collect(x, k);
    else if (typeof v === "string" && ["code", "train", "label"].includes(key) && v.length > 3 && !generic.has(v.toLowerCase())) {
      found.add(v.toLowerCase());
    }
  };
  collect(JSON.parse(m[1]));
  return [...found];
}

function publishableFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\n").filter((f) => f && !/\.(png|ico)$/.test(f) && !f.endsWith("package-lock.json"));
}

describe.skipIf(!existsSync(devVars))("route leak guard", () => {
  it("no publishable file contains a real route value", () => {
    const tokens = realTokens();
    expect(tokens.length).toBeGreaterThan(0);
    const leaks: string[] = [];
    for (const f of publishableFiles()) {
      const p = join(repoRoot, f);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8").toLowerCase();
      for (const t of tokens) if (text.includes(t)) leaks.push(`${f}: ${t}`);
    }
    expect(leaks).toEqual([]);
  });
});
