# are-you-late Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker computes a ready-to-render train status from ViaggiaTreno. A dumb static page on GitHub Pages shows it as a route line plus a traffic light.

**Architecture:** `worker/` is a TypeScript Worker. It holds pure modules (config parsing, Rome clock, upstream parsing, state logic) and a thin handler with injected dependencies, so everything is testable in plain Node with Vitest. `web/` is plain HTML/CSS/JS that fetches `/status` and renders with `textContent`. The route lives only in the `ROUTE_CONFIG` secret and in the gitignored `worker/.dev.vars`.

**Tech Stack:** Node.js LTS, TypeScript, Wrangler 4, Vitest. Plain HTML/CSS/JS. GitHub Actions (`actions/upload-pages-artifact`, `actions/deploy-pages`).

**Spec:** `docs/superpowers/specs/2026-10-26-are-you-late-design.md`

## Global Constraints

- Privacy: no real station names, station codes, train numbers or timetables in tracked files, fixtures, commit messages, issues or PRs. Real values only in `CLAUDE.local.md`, `worker/.dev.vars` and the Cloudflare secret `ROUTE_CONFIG`. Fictional values look like `S00000`, train `00000`, labels "Partenza" / "Checkpoint".
- Language: code, comments, docs and commit messages in English. User-facing strings in Italian, exactly as in spec §6.
- Times: all logic in Europe/Rome. ViaggiaTreno `andamentoTreno` takes the Rome-midnight epoch ms of the service day.
- Worker surface: only `GET /status` and `OPTIONS`. Other methods → 405, other paths → 404. Body never read. `dir` ∈ `outbound|return`, anything else → 400.
- Upstream: base `https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno`. URLs built only from validated config. 5 s timeout. Body capped at 1 MB. Response cached in memory for 30 s per leg.
- Rate limit: 30 requests / 60 s per client IP (`cf-connecting-ip`), over the limit → 429.
- CORS: `Access-Control-Allow-Origin` = `env.ALLOWED_ORIGIN` only (prod `https://mirkogibin.github.io`, local `http://localhost:8080`).
- Errors: any upstream, data or config failure → HTTP 200 `{ ok: false, light: { color: "grey", title: "Dati non disponibili al momento", subtitle: "" }, updated_at }`.
- Client: no `innerHTML`, no third-party scripts, strict CSP, `noindex`, no cookies or storage. Refresh every 60 s and on `visibilitychange`.
- Dependencies: devDependencies only (`wrangler`, `typescript`, `vitest`, `@cloudflare/workers-types`), exact versions locked by `package-lock.json`.

## Review Focus

- **DST / timezone**: the Worker runs in UTC. Leg selection, `HH:MM` strings and the service-day midnight must follow Europe/Rome, including on DST change days. Pinned in Task 2.
- **Upstream hangs or is slow**: the page must show "Dati non disponibili", not spin. 5 s timeout → `ok: false`. Pinned in Task 6.
- **Upstream returns 200 with HTML, an empty body or a huge body**: empty → "non circola", non-JSON or oversized → `ok: false`, never a crash. Pinned in Task 3.
- **Checkpoint detected but origin not detected** (a missed detection): the user must still see red "Lasciato …". Pinned in Task 4.
- **Train early (negative delay)**: estimates move earlier and `delay_min` is negative, and no "+-1" text appears. Pinned in Task 4 (Worker) and Task 7 (page shows "in anticipo di 1 min").

---

## File structure

```
worker/
  package.json · tsconfig.json · vitest.config.ts · wrangler.toml
  route-config.example.json          fictional config (tracked)
  .dev.vars                          real ROUTE_CONFIG + ALLOWED_ORIGIN (gitignored)
  src/types.ts         shared types (RouteConfig, Train, StopRecord, StatusResponse, Leg)
  src/config.ts        parseConfig
  src/time.ts          romeClock, formatHHMM, parseHHMM
  src/viaggiatreno.ts  upstreamUrl, parseTrain, fetchTrain
  src/status.ts        computeStatus, errorStatus, selectLeg
  src/index.ts         handle(request, env, deps) + default export
  test/*.test.ts       one test file per src module + leak.test.ts
  test/helpers.ts      makeRaw() builder for upstream-shaped JSON
  test/fixtures/andamento-anon.json  one full real response, anonymised
web/
  index.html · style.css · app.js · manifest.webmanifest · icon.png
.github/workflows/pages.yml
```

## Shared types (defined in Task 1, `worker/src/types.ts`)

```ts
export type Leg = "outbound" | "return";
export interface Station { code: string; label: string }
export interface RouteConfig {
  switchTime: string; // "HH:MM"
  outbound: { train: string; origin: Station; checkpoint: Station;
              userStop: { label: string; offsetMin: number; scheduled: string } };
  return: { train: string; origin: Station; userStop: Station & { scheduled: string } };
  thresholds: { passedGraceMin: number; returnYellowDelayMin: number };
}
export interface StopRecord { code: string; scheduledMs: number; actualMs: number | null; cancelled: boolean }
export interface Train { delayMin: number; cancelled: boolean; stops: StopRecord[] }
export type Color = "grey" | "yellow" | "red" | "green";
export interface StopView { name: string; time: string; kind: "detected" | "estimate" | "scheduled";
  state: "passed" | "next" | "target" | "pending"; scheduled?: string }
export interface StatusResponse { ok: boolean; direction?: Leg; delay_min?: number;
  light: { color: Color; title: string; subtitle: string };
  stops?: StopView[]; moving_after?: string | null; updated_at: string /* ISO UTC */ }
```

---

### Task 0: Prerequisites (user)

- [ ] **Step 1:** The user installs Node.js LTS on the workstation.
- [ ] **Step 2:** Verify with `node -v` (expected `v22.x` or newer) and `npm -v`.

### Task 1: Worker scaffold + config parsing

**Files:** create `worker/package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.toml`, `route-config.example.json`, `.dev.vars`, `src/types.ts`, `src/config.ts`, `test/config.test.ts`

**Interfaces:**
- Produces: all types above. `parseConfig(raw: string | undefined): RouteConfig | null`

- [ ] **Step 1: Scaffold.** `npm init -y` in `worker/`, then `npm i -D wrangler typescript vitest @cloudflare/workers-types`. Add scripts `"test": "vitest run"`, `"dev": "wrangler dev"`, `"deploy": "wrangler deploy"`, `"typecheck": "tsc --noEmit"`. tsconfig: `strict`, `target ES2022`, `module ESNext`, `moduleResolution Bundler`, `types ["@cloudflare/workers-types"]`. `wrangler.toml`:

```toml
name = "are-you-late"
main = "src/index.ts"
compatibility_date = "2026-10-01"

[vars]
ALLOWED_ORIGIN = "https://mirkogibin.github.io"

[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 30, period = 60 }
```

- [ ] **Step 2: Example and real config.** `route-config.example.json` holds the fictional JSON from spec §3, with `outbound.userStop.scheduled = "07:50"` and `return.userStop.scheduled = "13:00"`. `worker/.dev.vars` holds `ALLOWED_ORIGIN="http://localhost:8080"` and `ROUTE_CONFIG='<single-line real JSON from CLAUDE.local.md>'`. Confirm `git status` does not list `.dev.vars`.
- [ ] **Step 3: Write failing tests** in `test/config.test.ts`, loading the example file:
  - `parses the example config` → result deep-equals the parsed example JSON.
  - `rejects bad station code` (`origin.code = "X1"`) → `null`.
  - `rejects bad train` (`"12a"`), `bad time` (`"7:00"`, `"24:00"`), `label longer than 40 chars`, `offsetMin` outside 0–30, missing `thresholds` → each `null`.
  - `rejects non-JSON and undefined` → `null`.
- [ ] **Step 4:** Run `npm test` → FAIL (module missing).
- [ ] **Step 5: Implement `parseConfig`** with hand-written guards (no validation library): codes `^S\d{5}$`, trains `^\d{1,6}$`, times `^([01]\d|2[0-3]):[0-5]\d$`, labels non-empty and ≤ 40 chars, integer thresholds in 0–60. It returns a freshly built object, never the parsed input.
- [ ] **Step 6:** `npm test` → PASS. `npm run typecheck` → no errors.
- [ ] **Step 7: Commit** `chore: scaffold worker and add route config parsing`.

### Task 2: Rome clock

**Files:** create `src/time.ts`, `test/time.test.ts`

**Interfaces:**
- Produces: `romeClock(nowMs: number): { minutes: number; midnightMs: number }` (`minutes` = Rome **wall-clock** hours×60+minutes, not elapsed time; `midnightMs` = epoch ms of Rome midnight, for the upstream URL only). `romeMinutesOf(ms: number): number` (wall-clock minutes of any instant). `minutesToHHMM(m: number): string`. `formatHHMM(ms: number): string` (Rome `HH:MM`). `parseHHMM(s: string): number` (minutes).
- Rule for later tasks: all time arithmetic (estimates, "passed" checks, leg switch) is done in Rome wall-clock minutes, never as `midnightMs + minutes`, which is off by one hour on DST change days.

- [ ] **Step 1: Failing tests:**
  - `romeMinutesOf(Date.parse("2026-10-25T06:54:00Z"))` → `474`.
  - `romeClock(Date.parse("2026-10-26T06:00:00Z"))` → `minutes 420`, `midnightMs Date.parse("2026-10-25T23:00:00Z")`.
  - `romeClock(Date.parse("2026-07-01T06:00:00Z"))` → `minutes 480`, `midnightMs Date.parse("2026-06-30T22:00:00Z")`.
  - DST end day: `romeClock(Date.parse("2026-10-25T12:00:00Z"))` → `midnightMs Date.parse("2026-10-24T22:00:00Z")`, `minutes 780` (wall clock 13:00, although 14 h have elapsed).
  - `formatHHMM(Date.parse("2026-10-26T07:08:00Z"))` → `"08:08"`. `parseHHMM("13:00")` → `780`. `minutesToHHMM(1017)` → `"16:57"`. `minutesToHHMM(-1)` → `"23:59"` (wraps).
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3: Implement** with `Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", ... , timeZoneName: "longOffset" })` to read the Rome date, wall-clock hour/minute and offset. `midnightMs = Date.UTC(y, m-1, d) - offsetAtMidnight`. Compute the offset at midnight itself (format the candidate midnight again), not the offset at `now`, so DST days are right. `minutes` comes from the formatted hour and minute.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: add Europe/Rome clock helpers`.

### Task 3: Upstream URL + parsing

**Files:** create `src/viaggiatreno.ts`, `test/helpers.ts`, `test/viaggiatreno.test.ts`

**Interfaces:**
- Consumes: `Train`, `StopRecord`.
- Produces: `upstreamUrl(originCode: string, train: string, midnightMs: number): string`. `parseTrain(body: string): Train | "not_running" | null`. `fetchTrain(url: string, fetchFn: typeof fetch, timeoutMs = 5000): Promise<Train | "not_running" | null>` (`AbortSignal.timeout(timeoutMs)`, reads at most 1 MB, `null` on any network/HTTP error except an empty 200/204 body → `"not_running"`).
- `test/helpers.ts`: `makeRaw(opts: { ritardo?: number; tipoTreno?: string; provvedimento?: number; fermate: Array<{ id: string; programmata: number; effettiva?: number | null; actualFermataType?: number }> }): string` returns upstream-shaped JSON text.

- [ ] **Step 1: Failing tests:**
  - `upstreamUrl("S00000","00000",1761433200000)` → `".../andamentoTreno/S00000/00000/1761433200000"`.
  - `parses stops and delay`: `makeRaw` with 2 fermate, `ritardo 17` → `delayMin 23`, stops mapped `{code: id, scheduledMs: programmata, actualMs: effettiva ?? null, cancelled: false}`, `cancelled false`.
  - `empty body` (`""`, `"  "`) → `"not_running"`.
  - `HTML body` (`"<html>…"`), `JSON array`, `fermate not an array`, `programmata as string`, `id longer than 10 chars` → `null`.
  - `effettiva 0 is treated as not detected` → `actualMs null`.
  - `cancelled flags`: `tipoTreno "ST"` or `provvedimento 1` → `cancelled true`. A fermata with `actualFermataType 3` → that stop `cancelled true`.
  - `fetchTrain` with a stub `fetchFn` that never resolves (but honours `init.signal`) and `timeoutMs 50` → `null`. Status 500 → `null`. Status 204 → `"not_running"`. A 2 MB body → `null`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3: Implement.** Validate every field read; ignore all others. `delayMin` is a finite integer clamped to −60…600. Timestamps must be finite numbers within ±2 days of each other.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Verify cancellation flags on real data.** Using the real codes in `CLAUDE.local.md`, run `curl` against `andamentoTreno` for today's trains of the line and record which fields (`tipoTreno`, `provvedimento`, `fermate[].actualFermataType`, `subTitle`) mark a cancellation. If any real cancelled train is visible, note the observed values in `CLAUDE.local.md` and adjust the rule and its test. Otherwise keep the rule above and leave the spec §11 open point.
- [ ] **Step 6: Commit** `feat: parse and validate ViaggiaTreno train data`.

### Task 4: Outbound state logic

**Files:** create `src/status.ts`, `test/status-outbound.test.ts`

**Interfaces:**
- Consumes: `RouteConfig`, `Train`, `formatHHMM`, `parseHHMM`, `romeClock`.
- Produces: `computeStatus(leg: Leg, train: Train | "not_running", nowMs: number, cfg: RouteConfig): StatusResponse`. `errorStatus(nowMs: number): StatusResponse`. `selectLeg(nowMs: number, cfg: RouteConfig): Leg`.

Rules from spec §6 (outbound). Station rows are matched by `code`. A missing origin or checkpoint row → `errorStatus`. The user's stop estimate is checkpoint actual + `offsetMin` if detected, else `userStop.scheduled` + `delayMin`. Stops: origin, checkpoint, user's stop (kind/state per spec §5). `moving_after` is the label of the last detected stop.

- [ ] **Step 1: Failing tests** (fictional config, now = Rome times on 2026-10-27):
  - `not departed` (no actual anywhere, now 07:36) → grey, title `"Non ancora partito"`, subtitle `"previsto 07:50"`, all stops `kind "scheduled"`, `moving_after null`.
  - `left origin` (origin actual 07:54 for scheduled 07:31 ⇒ `delayMin 23`, now 07:55) → yellow `"Partito da Partenza"` / `"esci adesso"`. User stop time `"08:13"` with `kind "estimate"`, `scheduled "07:50"`. `moving_after "Partenza"`.
  - `left checkpoint` (checkpoint actual 08:08, now 08:09) → red `"Lasciato Checkpoint"` / `"corri"`. User stop `"08:13"`.
  - `checkpoint detected, origin not` → red as above.
  - `passed` (checkpoint actual 08:08, now 08:17 = 08:13 + 3 + 1) → green, title `"Treno passato alle 08:13"`.
  - `early train` (`delayMin -1`, origin detected) → user stop `"07:49"`, `delay_min -1`.
  - `not running` → grey `"Oggi questo treno non circola"`, `ok true`.
  - `cancelled` (train or any configured stop cancelled) → red `"Treno soppresso"`.
  - `selectLeg`: Rome 11:59 → `"outbound"`, 12:00 → `"return"`.
  - `DST change day` (2026-10-25, origin actual `Date.parse("2026-10-25T06:54:00Z")` = 07:54 CET, scheduled 07:31 CET, `delayMin 23`) → user stop `"08:13"`.
  - `errorStatus` → exactly the error object from Global Constraints.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3: Implement** the outbound branch, `errorStatus` and `selectLeg`. Keep the Italian strings as module-level constants.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: outbound status logic`.

### Task 5: Return state logic

**Files:** modify `src/status.ts`. Create `test/status-return.test.ts`.

Rules from spec §6 (return): estimate = `userStop.scheduled` + `delayMin`. Stops: origin, user's stop. The user's stop is always `kind "estimate"` once the train has departed.

- [ ] **Step 1: Failing tests** (`return.userStop.scheduled "13:00"`, origin label "Partenza ritorno", user stop label "Fermata ritorno"):
  - `not departed` → grey `"Non ancora partito da Partenza ritorno"` / `"previsto 13:00"`.
  - `left, delay 2` → green `"In arrivo verso le 13:02"` / `"stima dal ritardo a Partenza ritorno"`.
  - `left, delay 6` → yellow `"In ritardo, verso le 13:06"`.
  - `left, delay 5` (boundary) → green.
  - `probably passed` (delay 2, now 13:06) → grey `"Probabilmente passato"`.
  - `cancelled` / `not running` → as in Task 4.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3: Implement** the return branch.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: return status logic`.

### Task 6: HTTP handler

**Files:** create `src/index.ts`, `test/index.test.ts`

**Interfaces:**
- Consumes: `parseConfig`, `selectLeg`, `romeClock`, `upstreamUrl`, `fetchTrain`, `computeStatus`, `errorStatus`.
- Produces: `interface Env { ROUTE_CONFIG?: string; ALLOWED_ORIGIN: string; RATE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> } }`. `interface Deps { fetchFn: typeof fetch; now: () => number; cache: Map<Leg, { at: number; body: string }>; timeoutMs?: number }`. `handle(req: Request, env: Env, deps: Deps): Promise<Response>`. The default export `{ fetch(req, env) }` uses the global `fetch`, `Date.now` and a module-level `Map`.

Response headers on every response: `Access-Control-Allow-Origin: env.ALLOWED_ORIGIN`, `Vary: Origin`, `Content-Type: application/json; charset=utf-8`, `Cache-Control: public, max-age=30`, `X-Content-Type-Options: nosniff`. `OPTIONS` → 204 with `Access-Control-Allow-Methods: GET` and `Access-Control-Max-Age: 86400`.

- [ ] **Step 1: Failing tests** (stub `fetchFn` returning `makeRaw` bodies, fixed `now`, `.dev.vars` not used, `ROUTE_CONFIG` = the example file):
  - `POST /status` → 405. `GET /` and `GET /status/x` → 404. `GET /status?dir=sideways` → 400.
  - `GET /status?dir=outbound` → 200, JSON `ok true`, CORS header equals `ALLOWED_ORIGIN`.
  - `the body is not read`: a request whose body stream throws on read still returns 200.
  - `OPTIONS /status` → 204 with the CORS headers.
  - `rate limited`: `RATE_LIMITER.limit` → `{ success: false }` → 429. The key passed is the `cf-connecting-ip` header value.
  - `cache`: two calls within 30 s → `fetchFn` called once. A call at +31 s → called twice.
  - `upstream hang` (never-resolving `fetchFn`, `timeoutMs` 50) → 200 with `ok false`.
  - `invalid ROUTE_CONFIG` or missing → 200 with `ok false`, `fetchFn` never called.
  - `no route data leaks`: the response body for a real-shaped upstream with `stazione` names `"SECRET TOWN"` does not contain `"SECRET"`, and has no `train` field.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3: Implement `handle`.** Order: method → path → `dir` → rate limit → config → cache → upstream → `computeStatus`. Wrap the whole function in `try/catch` → `errorStatus`. Error responses are not cached.
- [ ] **Step 4:** `npm test` → PASS. `npm run typecheck` → clean.
- [ ] **Step 5: Local smoke.** `npm run dev`, then `curl "http://localhost:8787/status?dir=outbound"` and `?dir=return` → valid JSON with the real labels from `.dev.vars`. `curl -X POST …` → 405.
- [ ] **Step 6: Commit** `feat: status HTTP handler with CORS, rate limit and cache`.

### Task 7: Static page

**Files:** create `web/index.html`, `web/style.css`, `web/app.js`, `web/manifest.webmanifest`, `web/icon.png` (180×180, simple train glyph, generated locally)

`app.js` contract: `const API = location.hostname === "localhost" ? "http://localhost:8787/status" : "<WORKER_URL>/status";`. `<WORKER_URL>` is filled in Task 8. A `?dir=outbound|return` query on the page is forwarded only if it matches that closed list. Rendering: build elements with `document.createElement` and `textContent` only. `light.color` maps via `{grey, yellow, red, green}` to the CSS class `light--<color>`, and anything else → `light--grey`. `delay_min > 0` → `"+N min"`, `< 0` → `"in anticipo di N min"`, `0` → `"in orario"`. Stale: if the last success was more than 3 min ago or a fetch fails, add class `stale` and show `"non aggiornato da N min"`. Otherwise show `"aggiornato N min fa"` (`"aggiornato ora"` under 1 min).

`index.html` head:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; connect-src http://localhost:8787 <WORKER_URL>">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="apple-touch-icon" href="icon.png">
```

Layout per spec §8 and the approved mockup: header (leg name "Andata"/"Ritorno" from `direction`, plus delay), vertical route line (detected = solid dot, estimate/scheduled = hollow dot, train icon after `moving_after`, target stop in larger type), traffic-light card at the bottom with an inline SVG icon, title and subtitle, then the "aggiornato" line, then the footer `"Dati ViaggiaTreno · sito non ufficiale · nessun cookie"`. Colours are CSS custom properties with a `prefers-color-scheme: dark` override. Use `env(safe-area-inset-*)` padding. No horizontal scroll at 375 px.

- [ ] **Step 1:** Write the files.
- [ ] **Step 2: Verify locally.** Run `npm run dev` in `worker/` and serve `web/` on port 8080 (`npx --yes http-server web -p 8080 -c-1` from the repo root, run as a one-off). Open `http://localhost:8080/?dir=outbound` and `?dir=return` in the browser pane at 375×812. Check: the layout matches the mockup, the colour class follows `light.color`, there are no CSP errors in the console, and with the Worker stopped the page dims and shows "non aggiornato da N min" after a refresh.
- [ ] **Step 3: Commit** `feat: static status page`.

### Task 8: Leak guard + anonymised fixture

**Files:** create `test/fixtures/andamento-anon.json`, `test/leak.test.ts`, `test/e2e.test.ts`

- [ ] **Step 1: Fixture.** Fetch one real outbound `andamentoTreno` response (codes from `CLAUDE.local.md`). Replace every station code, name, train number, origin/destination name and company-specific text with fictional values (`S00000`…, `"STAZIONE A"`…, `00000`). Keep the structure and the timestamps' relative offsets. Save it as `test/fixtures/andamento-anon.json`.
- [ ] **Step 2: Tests.**
  - `e2e.test.ts`: `parseTrain(fixture)` → `computeStatus("outbound", …, cfg = example config remapped to the fixture codes)` yields a valid `StatusResponse` whose `stops` names come from the config.
  - `leak.test.ts`: if `worker/.dev.vars` exists, parse `ROUTE_CONFIG` and collect station codes, train numbers and labels longer than 3 chars except the generic ones in the example config. Assert that no tracked text file (`git ls-files` from the repo root, run via `child_process`) contains any of them, case-insensitive. Skip with a clear message when `.dev.vars` is absent (CI).
- [ ] **Step 3:** `npm test` → PASS.
- [ ] **Step 4: Commit** `test: anonymised end-to-end fixture and route leak guard`.

### Task 9: Deploy (needs the user)

- [ ] **Step 1: Worker.** The user runs `npx wrangler login` in `worker/` (browser OAuth). Then `npx wrangler secret put ROUTE_CONFIG` (paste the JSON from `.dev.vars`) and `npm run deploy`. Record the printed `https://are-you-late.<subdomain>.workers.dev` URL. Verify with `curl <url>/status` → `ok true`.
- [ ] **Step 2: Fill `<WORKER_URL>`** in `web/app.js` and the CSP in `web/index.html`. Commit `chore: point page at deployed worker`.
- [ ] **Step 3: Pages workflow** `.github/workflows/pages.yml`: on push to `main` and `workflow_dispatch`, permissions `pages: write, id-token: write, contents: read`, steps `actions/checkout@v4` → `actions/configure-pages@v5` → `actions/upload-pages-artifact@v3` (path `web`) → `actions/deploy-pages@v4`. Commit `ci: publish web/ to GitHub Pages`.
- [ ] **Step 4: Pre-push leak check.** `npm test` (the leak guard runs because `.dev.vars` exists) and `git log -p --all` grepped for the real codes and names in `CLAUDE.local.md` → no hits.
- [ ] **Step 5: Publish (explicit user confirmation first).** `gh repo create MirkoGibin/are-you-late --public --source . --push`, then `gh api -X POST repos/MirkoGibin/are-you-late/pages -f build_type=workflow`. Wait for the workflow (`gh run watch`).
- [ ] **Step 6: Live check.** Open `https://mirkogibin.github.io/are-you-late/` at iPhone size in the browser pane. Check: data loads, no CSP errors, and `curl -H "Origin: https://evil.example" <worker>/status` still returns `Access-Control-Allow-Origin: https://mirkogibin.github.io`.
- [ ] **Step 7: Docs.** Update `README.md` (live link, how to run locally, how to update `ROUTE_CONFIG`) and `CLAUDE.md` (Worker URL, any decisions made during implementation). Commit `docs: deployment and local development`.
