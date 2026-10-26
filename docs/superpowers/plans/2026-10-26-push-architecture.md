# Push Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch train data from the home k3s server and push the computed status to the Cloudflare Worker, which stores it in KV and serves it to the page.

**Architecture:** The pure modules already built (`config`, `time`, `viaggiatreno`, `status`) move behind a new poller entry point (`poller.ts` + `poller-main.ts`). The poller is bundled to one `.mjs` and runs as a k3s CronJob on `node:24-alpine`. The Worker drops its upstream calls and gains an authenticated `POST /push` plus KV storage.

**Tech Stack:** TypeScript, Vitest, Wrangler 4 + Workers KV, esbuild (already installed via wrangler), k3s CronJob, SSH.

**Spec:** `docs/superpowers/specs/2026-10-26-are-you-late-design.md` (§12 supersedes earlier sections where they conflict).

## Global Constraints

- All constraints of `docs/superpowers/plans/2026-10-26-are-you-late.md` still apply (privacy, language, Europe/Rome, client rules).
- `PUSH_TOKEN` and `ROUTE_CONFIG` are never written to tracked files, manifests, command lines visible in process lists, or logs. They are piped via stdin.
- `/push`: Bearer token compared in constant time; 401 before reading the body; body ≤ 8192 bytes → else 413; schema-validated → else 400; success 204; no CORS headers.
- The Worker never calls ViaggiaTreno and never reads `ROUTE_CONFIG`.
- Poller: at most one upstream request per run; exit code 0 on a successful push, 1 otherwise.

## Review Focus

- **Poller stopped or server down**: the page must not show an old "Partito" as current. The client derives age from `updated_at` and dims after 3 min. Pinned in Task 4 (manual) and Task 2 (GET returns stored `updated_at` unchanged).
- **Token brute force / timing**: wrong tokens of any length must take the same path and return 401 without reading the body. Pinned in Task 2.
- **Oversized or chunked push without Content-Length**: must be cut at 8 KB while reading. Pinned in Task 2.
- **Stale leg from yesterday served without `dir`**: "most recent `updated_at`" picks today's leg once the poller has run. Before 05:00 the page shows yesterday's leg dimmed. Accepted, and visible via stale.
- **KV write quota**: about 420 writes/day < 1000 free. A failure → Worker 5xx on push → poller exit 1 → Job failure history. Pinned in Task 2 (KV put error → 503).

---

### Task 1: Status schema validation

**Files:** create `worker/src/schema.ts`, `worker/test/schema.test.ts`

**Interfaces:** Produces `parseStatus(v: unknown): StatusResponse | null` (rebuilds a clean object; only fields of `StatusResponse`).

- [ ] **Step 1: Failing tests**:
  - Round-trips the outputs of `computeStatus` for one outbound and one return case (use the existing test fixtures/helpers) and `errorStatus(now)`.
  - Rejects: unknown colour, unknown `kind`/`state`, string > 80 chars, 6 stops, `delay_min` 2.5 / 601, `updated_at` "yesterday", missing `light`, `ok` not boolean, array input.
  - Drops unknown fields (`train`, `extra`).
- [ ] **Step 2:** `npm --prefix worker test` → FAIL (module missing).
- [ ] **Step 3: Implement** with hand-written guards in the style of `config.ts`.
- [ ] **Step 4:** Tests and typecheck → PASS.
- [ ] **Step 5: Commit** `feat: validate pushed status payloads`.

### Task 2: Worker — `/push`, KV, GET from KV

**Files:** modify `worker/src/index.ts`, `worker/wrangler.toml`; rewrite `worker/test/index.test.ts`

**Interfaces:**
- `Env { ALLOWED_ORIGIN: string; PUSH_TOKEN?: string; STATUS: KVLike; RATE_LIMITER?: … }`, where `KVLike = { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> }`.
- `Deps { now: () => number }`. `handle(req, env, deps)`. Exported `safeEqual(a: string, b: string): boolean`.
- KV keys: `status:outbound`, `status:return`.

- [ ] **Step 1: Failing tests** (in-memory `KVLike` stub):
  - push: no/invalid `Authorization` → 401 and the body stream is never read (throwing body). Correct token + valid `{leg,status}` → 204 and KV holds the re-serialised clean status. `Content-Length: 9000` → 413. Streamed 9000 bytes without length → 413. Invalid JSON / schema → 400. KV `put` throws → 503. `PUSH_TOKEN` unset → 401 always. No `Access-Control-Allow-Origin` on `/push` responses.
  - `safeEqual`: equal → true, different same length → false, different length → false.
  - GET: no stored keys → 200 `ok:false`. Both stored → returns the one with the newer `updated_at`. `?dir=return` → that key. Response body equals the stored body. Existing routing/CORS/rate-limit/OPTIONS tests are kept (rate limit applies to GET and POST).
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3: Implement.** Remove upstream fetching and the in-memory cache from `index.ts`. `wrangler.toml` gets a `[[kv_namespaces]] binding = "STATUS"` with the id created in Task 5 (placeholder `TO_BE_CREATED` until then, which wrangler dev accepts locally with `--local`).
- [ ] **Step 4:** Tests and typecheck → PASS.
- [ ] **Step 5: Commit** `feat: worker serves pushed status from KV`.

### Task 3: Poller

**Files:** create `worker/src/poller.ts`, `worker/src/poller-main.ts`, `worker/test/poller.test.ts`. Modify `worker/package.json` (script `build:poller`), `.gitignore` (`dist/`, `.env*`).

**Interfaces:** `runOnce(env: { ROUTE_CONFIG?: string; PUSH_URL?: string; PUSH_TOKEN?: string }, deps: { fetchFn: typeof fetch; now: () => number }): Promise<boolean>`. `poller-main.ts` calls it with `process.env`, logs one line without secrets or route data (`push ok leg=outbound color=yellow` / `push failed status=401`), and sets `process.exitCode`.

- [ ] **Step 1: Failing tests:**
  - Valid config → exactly one upstream call to `upstreamUrl(...)` for `selectLeg(now)`, then one POST to `PUSH_URL` with `Authorization: Bearer <token>`, `Content-Type: application/json`, body `{leg, status}` where `status` equals `computeStatus(...)`. Returns true on 204.
  - Upstream null → pushes `errorStatus(now)` for the leg.
  - Invalid/missing config, URL or token → no network calls, returns false.
  - Push answers 401 / throws → returns false.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3: Implement.** `build:poller` = `esbuild src/poller-main.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/poller.mjs`. Run it and check `node dist/poller.mjs` with no env exits 1 and prints a config error line.
- [ ] **Step 4:** Tests and typecheck → PASS.
- [ ] **Step 5: Commit** `feat: poller pushes status from the home server`.

### Task 4: Client age from `updated_at`

**Files:** modify `web/app.js`.

- [ ] **Step 1:** `lastOkAt = Date.parse(data.updated_at) || Date.now()` on success.
- [ ] **Step 2: Verify in the browser pane** with local `wrangler dev` and a manual push of a status whose `updated_at` is 5 minutes old → page dimmed, "non aggiornato da 5 min". Then push a fresh one → normal.
- [ ] **Step 3: Commit** `feat: page age follows the server read time`.

### Task 5: k3s manifests and deploy

**Files:** create `deploy/k3s/namespace.yaml`, `deploy/k3s/cronjob.yaml`, `deploy/README.md` (generic commands, no values).

- [ ] **Step 1: Manifests** per spec §12 (CronJob fields and pod hardening exactly as listed). The pod mounts ConfigMap `poller-code` at `/app` (read-only) and uses `envFrom: secretRef: are-you-late`. `automountServiceAccountToken: false`.
- [ ] **Step 2: Cloudflare.** `wrangler kv namespace create STATUS` → put the id in `wrangler.toml`. Generate `PUSH_TOKEN` (32 random bytes hex) locally into `worker/.dev.vars`, then `wrangler secret put PUSH_TOKEN` (stdin) and `wrangler secret delete ROUTE_CONFIG`. `wrangler deploy`.
- [ ] **Step 3: Server (SSH).** `kubectl apply -f namespace.yaml`. Create Secret `are-you-late` from stdin (`ROUTE_CONFIG`, `PUSH_TOKEN`, `PUSH_URL=https://are-you-late.are-you-late.workers.dev/push`). Create ConfigMap `poller-code` from the built `dist/poller.mjs` (piped). `kubectl apply -f cronjob.yaml`.
- [ ] **Step 4: Verify.** `kubectl create job --from=cronjob/poller manual-1 -n are-you-late`, then its logs show `push ok`. `curl <worker>/status` → `ok:true` with real labels. Leak guard + `git log -p` grep before any commit.
- [ ] **Step 5: Commit** `feat: k3s deployment for the poller`.

### Task 6: Publish page (user confirmation required) and docs

- [ ] **Step 1:** Fill the Worker URL into `web/app.js` and the CSP (`connect-src` = Worker origin only, drop 127.0.0.1). Add `.github/workflows/pages.yml` (as in the first plan, Task 9 Step 3).
- [ ] **Step 2:** Ask the user. Then `gh repo create MirkoGibin/are-you-late --public --source . --push` (branch merged to `main` first) and enable Pages via `gh api`.
- [ ] **Step 3:** Live check on the Pages URL at iPhone size. Update `README.md`/`CLAUDE.md` (architecture, how to redeploy the poller, how to rotate `PUSH_TOKEN`).
