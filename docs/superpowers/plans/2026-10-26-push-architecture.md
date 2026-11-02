# Push Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch train data from the home k3s cluster and push the computed status to the Cloudflare Worker, which stores it in KV and serves it to the page.

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

> Tasks 5 and 6 were revised on 2026-11-02 by spec §13: this system is now a tenant of a shared cluster. Its namespace is provided by the cluster's own repository, and deploys run through `kubectl` from the workstation. The secrets rule still holds: values pass only through stdin and a file outside the repository.

### Task 5: Deploy to the cluster

**Files:** create `deploy/site.yml`, `deploy/k3s/cronjob.yaml`, `deploy/poller.env.example`, `deploy/README.md`. Modify `worker/wrangler.toml`, `CLAUDE.md`, `README.md`.

**Precondition:** namespace `are-you-late` exists on the cluster. If not, stop: this repository never creates it.

**Interfaces:** `deploy/site.yml` variables: `secrets_file` (default `~/.config/are-you-late/poller.env`), `kubeconfig_file` (default `~/.kube/config`). The file holds `ROUTE_CONFIG`, `PUSH_TOKEN`, `PUSH_URL`, one `KEY=value` per line, unquoted.

**Review Focus for this task:**
- **Secrets file readable by others:** the playbook stops unless its mode is `0600`. Pinned in Step 2.
- **A pipe hiding a failed `kubectl create`:** `set -o pipefail` makes the task fail. Pinned in Step 3.
- **Secret values in Ansible output:** pinned in Step 8.
- **A quoted `ROUTE_CONFIG` copied from `.dev.vars`:** the poller logs `config error`. Pinned in Step 6, which strips the quotes, and Step 9.

- [ ] **Step 1: Write the CronJob.** `deploy/k3s/cronjob.yaml`: the fields and hardening in spec §12, exactly. Namespace `are-you-late`, name `poller`, image `node:24-alpine`, command `node /app/poller.mjs`, ConfigMap `poller-code` mounted read-only at `/app`, `envFrom` Secret `are-you-late`, requests `50m`/`64Mi`, limits `200m`/`128Mi`, `seccompProfile: RuntimeDefault`.
  Run: `KUBECONFIG=~/.kube/config kubectl apply --dry-run=server -f deploy/k3s/cronjob.yaml`
  Expected: `cronjob.batch/poller created (server dry run)`.
- [ ] **Step 2: Write the stop conditions first.** `deploy/site.yml`, on `localhost` with `connection: local`, `gather_facts: false`, and `KUBECONFIG` from `kubeconfig_file` in `environment`. Checks, in order: namespace exists; `worker/dist/poller.mjs` exists; `secrets_file` exists with mode `0600`. Each failure message names what to do.
  Run with `-e secrets_file=/nonexistent`. Expected: stops on the secrets check, with nothing applied. Run with the bundle renamed. Expected: stops on the bundle check. Run with a temporary `0644` file. Expected: stops on the mode check.
- [ ] **Step 3: Add the apply tasks.** ConfigMap `poller-code` from the bundle, Secret `are-you-late` from `secrets_file`, then the CronJob, using the command form in spec §13. `executable: /bin/bash`, `set -o pipefail`, `no_log: true` on the Secret task.
  Run: `ansible-playbook -i localhost, deploy/site.yml --syntax-check`. Expected: `playbook: deploy/site.yml`.
- [ ] **Step 4: Documents.** `deploy/poller.env.example` with fictional values only. `deploy/README.md` with generic commands: build, run, rotate `PUSH_TOKEN`. Update `CLAUDE.md` and `README.md`: push architecture, tenant of a shared cluster, deploy, `POST /push` in the security rules, and the no-workstation-details rule.
  Run: `npm --prefix worker test && npm --prefix worker run typecheck`. Expected: PASS, including the leak guard.
- [ ] **Step 5: Commit** `feat: deploy the poller to the shared cluster`.
- [ ] **Step 6: Prepare the secrets, printing no values.** Create `~/.config/are-you-late/poller.env` with mode `0600`: `ROUTE_CONFIG` from `worker/.dev.vars` with its surrounding quotes removed, `PUSH_TOKEN` from `openssl rand -hex 32`. `PUSH_URL` is added in Step 7.
- [ ] **Step 7: USER GATE: Cloudflare.** After confirmation, from `worker/`:
  - `npx wrangler kv namespace create STATUS`, and put the id in `wrangler.toml`;
  - pipe the token: `grep '^PUSH_TOKEN=' ~/.config/are-you-late/poller.env | cut -d= -f2- | npx wrangler secret put PUSH_TOKEN`;
  - `npx wrangler secret delete ROUTE_CONFIG`;
  - `npx wrangler deploy`, and read the real URL from its output;
  - append `PUSH_URL=<url>/push` to the secrets file.
  Commit `chore: bind the status KV namespace`.
- [ ] **Step 8: USER GATE: cluster.** After confirmation: `npm --prefix worker run build:poller`, then `ansible-playbook -i localhost, deploy/site.yml`.
  Expected: `failed=0` and no secret values in the output.
  Run: `kubectl get secret are-you-late -n are-you-late -o jsonpath='{.metadata.annotations}'`. Expected: no `last-applied-configuration`.
- [ ] **Step 9: Verify end to end.** `kubectl create job --from=cronjob/poller manual-1 -n are-you-late`.
  Expected: its log shows `push ok`, and `curl <worker>/status` returns `ok:true` with real labels. If ViaggiaTreno refuses the pod, the log and status show it: stop and report. Do not try to get around a block. Delete `manual-1` afterwards.

### Task 6: Publish the page

**Files:** modify `web/app.js`, `web/index.html`. Create `.github/workflows/pages.yml`.

- [ ] **Step 1:** Put the Worker URL in `web/app.js` and in the CSP (`connect-src` is the Worker origin only, without `127.0.0.1`). Add the workflow as in the first plan, Task 9 Step 3. Commit `feat: point the page at the Worker`.
- [ ] **Step 2: Whole-branch review** as the executing skill requires, including this plan's Review Focus.
- [ ] **Step 3: Scan all history.**
  Real values: every string value of the `code`, `train` and `label` fields in `ROUTE_CONFIG` that is not in the example config, searched with `git grep` in every commit of `git rev-list --all`, and in `git log --all --format=%B`. Also the real station names, train numbers and times in `CLAUDE.local.md`. Workstation details: the terms in `~/.config/homelab/host-patterns.txt`, a file outside every repository, ignoring case. Never copy those terms into a tracked file. Print only file and commit for each hit, never the value.
  Expected: no hits.
- [ ] **Step 4: USER GATE: publish.** After confirmation: merge the branch into `main`, `gh repo create MirkoGibin/are-you-late --public --source . --push`, enable Pages with `gh api`, and add the repository to the shared board.
- [ ] **Step 5: Live check** on the Pages URL at iPhone size, including the dimming that Task 4 verified only on a stub DOM.
