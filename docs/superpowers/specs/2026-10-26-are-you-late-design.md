# are-you-late — Design

Date: 2026-10-26 · Status: draft, awaiting review

## 1. Goal

A commuter walks to a regional train stop. In the morning they board a fixed **outbound** train, and in the early afternoon a fixed **return** train at another stop. They need to know at a glance whether the train has left the previous stations and how late it is, so they can decide whether to leave home, hurry or wait.

Success: opening the page on an iPhone answers "has it left? how late? do I go now?" within two seconds.

Out of scope for now: other trains, notifications, "leave in X minutes" based on walking time, the Telegram bot (plan B).

**Privacy constraint**: the repository is public, so it must not reveal the route. No station names, station codes, train numbers or real timetables in tracked files (code, docs, tests, commit messages, issues). Real values live only in the deployed configuration and in gitignored local files (§6).

## 2. Data source: ViaggiaTreno (unofficial API)

Base URL: `https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno`

- `andamentoTreno/{originCode}/{trainNumber}/{midnightMs}` returns the train's stops with scheduled (`programmata`) and actual (`effettiva`) times and the current delay (`ritardo`).
- The API sends no CORS headers, so a browser cannot call it directly. It may change without notice.
- On the target line not every station reports actual times. This was checked on every train of the line on 2026-10-26:
  - **Outbound**: the origin station and one intermediate station (the **checkpoint**, about 5 min before the user's stop) are detected.
  - **Return**: only the **return origin**, about 50 min before the user's return stop, is detected before the user boards.
- The user's outbound stop is not listed in ViaggiaTreno, so it is modelled as the checkpoint + a configurable offset (currently 5 min).

## 3. Route configuration

Everything route-specific is data, not code:

```jsonc
{
  "switchTime": "12:00",              // before: outbound, from: return (Europe/Rome)
  "outbound": {
    "train": "00000",
    "origin":     { "code": "S00000", "label": "Partenza" },
    "checkpoint": { "code": "S00001", "label": "Checkpoint" },
    "userStop":   { "label": "La tua fermata", "offsetMin": 5, "scheduled": "07:50" }
  },
  "return": {
    "train": "00001",
    "origin":   { "code": "S00002", "label": "Partenza ritorno" },
    "userStop": { "code": "S00003", "label": "Fermata ritorno", "scheduled": "13:00" }
  },
  "thresholds": { "passedGraceMin": 3, "returnYellowDelayMin": 5 }
}
```

- Labels are shown verbatim on the page, so the owner decides how much they reveal (real names or aliases).
- Production: one Worker secret, `ROUTE_CONFIG` (JSON), set with `wrangler secret put`. It does not appear in `wrangler.toml` or in the repo.
- Local: `worker/.dev.vars` (gitignored). The repo ships `worker/route-config.example.json` with fictional values.
- The Worker validates the config at startup: codes match `^S\d{5}$`, train numbers `^\d{1,6}$`, times `HH:MM`, labels ≤ 40 chars. If the config is invalid, every request returns `ok: false`.

## 4. Architecture

```
iPhone (static page, GitHub Pages)
   │  GET /status   every 60 s, and when the page becomes visible again
   ▼
Cloudflare Worker ──► ViaggiaTreno andamentoTreno (URLs built from ROUTE_CONFIG only)
   │  all logic: pick leg by time, compute state, estimates, colour
   │  edge cache 30 s
   ▼
ready-to-render JSON
```

The client is as dumb as possible: all decisions live in the Worker.

## 5. Worker API contract

Only `GET /status` exists, with optional `?dir=outbound|return` for testing. Without it, the leg is chosen by the Europe/Rome clock and `switchTime`.

Example response (fictional labels):

```json
{
  "ok": true,
  "direction": "outbound",
  "delay_min": 17,
  "light": { "color": "yellow", "title": "Partito da Partenza", "subtitle": "esci adesso" },
  "stops": [
    { "name": "Partenza", "time": "07:54", "kind": "detected", "state": "passed" },
    { "name": "Checkpoint", "time": "08:08", "kind": "estimate", "state": "next" },
    { "name": "La tua fermata", "time": "08:13", "kind": "estimate", "state": "target", "scheduled": "07:50" }
  ],
  "moving_after": "Partenza",
  "updated_at": "2026-10-27T07:03:05+01:00"
}
```

- The train number is not returned: the page doesn't need it.
- `light.color` ∈ `grey | yellow | red | green`.
- `stops[].kind` ∈ `detected | estimate | scheduled`. `stops[].state` ∈ `passed | next | target | pending`.
- `moving_after` is the label of the last passed stop, after which the train icon is drawn, or `null`.
- When anything is wrong (upstream down, invalid data or config), the response is `{ "ok": false, "light": { "color": "grey", "title": "Dati non disponibili al momento", "subtitle": "" }, "updated_at": … }` with HTTP 200, so the page can still render it. Field names are English. Fixed user-facing strings are **Italian**, and station names come from the config labels.

## 6. State logic (Worker, pure function)

`computeStatus(train, now, config) → StatusResponse`, where `train` is already-validated data. Times are Europe/Rome. `{origin}` and similar placeholders below are config labels.

### Outbound — user's stop = checkpoint + `offsetMin`

| Condition | Light | Title · subtitle |
|---|---|---|
| no actual time at origin | grey | "Non ancora partito" · "previsto HH:MM" |
| actual time at origin | yellow | "Partito da {origin}" · "esci adesso" |
| actual time at checkpoint | red | "Lasciato {checkpoint}" · "corri" |
| now > estimate at user's stop + `passedGraceMin` | green | "Treno passato alle HH:MM" |

The estimate at the user's stop is the checkpoint actual time + `offsetMin` if detected, otherwise `userStop.scheduled` + current delay.

### Return — user boards at `return.userStop`

| Condition | Light | Title · subtitle |
|---|---|---|
| no actual time at return origin | grey | "Non ancora partito da {origin}" · "previsto HH:MM" |
| left origin, delay ≤ `returnYellowDelayMin` | green | "In arrivo verso le HH:MM" · "stima dal ritardo a {origin}" |
| left origin, delay > `returnYellowDelayMin` | yellow | "In ritardo, verso le HH:MM" · "stima dal ritardo a {origin}" |
| now > estimate + `passedGraceMin` | grey | "Probabilmente passato" |

The estimate is `userStop.scheduled` + delay measured at the return origin. It is always labelled as an estimate.

Stops shown: outbound is origin → checkpoint → user's stop. Return is origin → user's stop. Undetected stops show `scheduled + delay` as `estimate`.

### Special cases

| Case | Light | Title |
|---|---|---|
| train cancelled, fully or on the user's section | red | "Treno soppresso" |
| train not running today (not found / empty response) | grey | "Oggi questo treno non circola" |
| upstream error, invalid data or invalid config | grey | "Dati non disponibili al momento" (`ok: false`) |

How ViaggiaTreno flags cancellations (fields such as `tipoTreno` / `provvedimento`) is **to be verified on real data** during implementation, and a fixture will be saved (anonymised) when a real case appears.

## 7. Security

There is no way to authenticate an anonymous public page, and any key shipped to the client is public. The Worker is therefore designed to be harmless whoever calls it.

- **Minimal surface**: only `GET /status` and `OPTIONS`. Other methods get 405, other paths 404. The request body is never read. Headers and query parameters are ignored except `dir`, which is checked against a closed list (anything else → 400).
- **No user input upstream**: ViaggiaTreno URLs are built only from the validated `ROUTE_CONFIG` (no injection, no SSRF).
- **Upstream validation**: the ViaggiaTreno JSON is validated (types, string lengths, plausible timestamps) and a new response object is built. Upstream data is never passed through, so real station names from ViaggiaTreno never reach the client, only the config labels.
- **DDoS / abuse**: Cloudflare's built-in DDoS protection. A 30 s edge cache means at most about 2 upstream calls per minute per location, whatever the traffic. A Workers rate-limit binding allows about 30 requests/min per IP, and above that the Worker returns 429. On the free plan (100k requests/day) exhaustion means downtime, not a bill.
- **CORS**: `Access-Control-Allow-Origin` set to the Pages origin only. This is not access control against scripts.
- **Client**: renders only with `textContent` (never `innerHTML`). Colours map to a closed set of CSS classes, with unknown values falling back to grey. No third-party scripts. A strict Content-Security-Policy allows only the page's own script and `connect-src` to the Worker origin. `<meta name="robots" content="noindex">` keeps it out of search engines.
- **Secrets / private data**: the only private item is `ROUTE_CONFIG` (Cloudflare secret, plus gitignored `.dev.vars` locally). The Worker is deployed manually from the developer's PC via `wrangler login` (OAuth, token kept in the local wrangler profile, never in the repo). A later option is a GitHub Actions deploy with a minimal-scope Cloudflare API token stored in GitHub Secrets.
- **Residual exposure**: anyone with the page URL sees what the page shows (the labels the owner chose). The URL is not secret.

## 8. Frontend

- Plain HTML/CSS/JS, no build step, no framework. `app.js` stays around 50 lines: fetch, render, refresh timer, stale handling. The page contains no route data: everything arrives from `/status`.
- Layout (iPhone first): header with leg and delay; a vertical route line with stops (detected = solid dot, estimate = hollow dot, train icon after `moving_after`); a large traffic-light card below with icon, title and subtitle; "aggiornato N min fa" at the bottom.
- Refresh every 60 s and on `visibilitychange` to visible.
- If the Worker is unreachable, keep the last response, dim it and show "non aggiornato da N min". This is the only client-side logic.
- Light/dark mode via `prefers-color-scheme`. `manifest.webmanifest` + `apple-touch-icon` for "Add to Home Screen".
- Footer: "Dati ViaggiaTreno · sito non ufficiale · nessun cookie".

## 9. Repository layout

```
are-you-late/
├─ CLAUDE.md · README.md          generic, public
├─ CLAUDE.local.md                real route details (gitignored)
├─ docs/superpowers/specs/2026-10-26-are-you-late-design.md
├─ .github/workflows/pages.yml    publish web/ to GitHub Pages (official actions, no secrets)
├─ web/      index.html · style.css · app.js · manifest.webmanifest · icon.png
└─ worker/
   ├─ src/index.ts         routing, method/param checks, CORS, rate limit, cache
   ├─ src/config.ts        parse + validate ROUTE_CONFIG
   ├─ src/viaggiatreno.ts  upstream fetch + validation
   ├─ src/status.ts        pure state logic
   ├─ test/                Vitest tests + anonymised fixtures
   ├─ route-config.example.json   fictional values
   ├─ .dev.vars            real ROUTE_CONFIG for wrangler dev (gitignored)
   └─ wrangler.toml · package.json · tsconfig.json
```

The Worker is written in TypeScript (supported natively by wrangler). Node.js LTS is installed on the workstation. All other tooling (wrangler, vitest, typescript) is project-local devDependencies.

## 10. Testing and verification

- **Fixtures**: real ViaggiaTreno responses with station names, codes and train numbers replaced by fictional ones before they are saved. A test fails if a fixture contains a value from `.dev.vars` (when present), as a guard against leaks.
- **Unit tests (Vitest)** on `computeStatus`: not departed, left origin, left checkpoint, passed, return left origin (small and large delay), not running today, and cancelled once a real sample exists.
- **Config tests**: invalid `ROUTE_CONFIG` gives `ok: false`.
- **Validation tests**: malformed upstream payloads give `ok: false`.
- **Handler tests**: wrong method → 405, wrong path → 404, invalid `dir` → 400, CORS header only for the allowed origin.
- **Manual**: `wrangler dev` (reads `.dev.vars`) plus the page in a local browser, using `?dir=` to force either leg. Then deploy and check on a real iPhone on a real morning, and tune thresholds.

## 11. Open points

- Exact cancellation flags in ViaggiaTreno (see §6).
- Exact user-stop offset (5 min) to be tuned with use.
- Telegram bot (plan B) and automatic Worker deploy: later, separate work.
