# are-you-late

Mobile web page (iPhone first) telling a commuter whether their regional train has left the previous stations and how late it is: one fixed outbound train in the morning, one fixed return train in the early afternoon.

Full design: [docs/superpowers/specs/2026-10-26-are-you-late-design.md](docs/superpowers/specs/2026-10-26-are-you-late-design.md). Read it before changing behaviour.

## Privacy (important)

This repository is public and must not reveal the route. **No station names, station codes, train numbers or real timetables in tracked files**: code, docs, tests/fixtures, commit messages, issues and PRs.

- The real details are in `CLAUDE.local.md` (gitignored, read automatically by Claude Code).
- The real config is in `worker/.dev.vars` (local) and in `~/.config/are-you-late/poller.env` on the workstation, from which the deploy creates the Kubernetes Secret `are-you-late` (production). The Worker no longer holds it.
- Examples and fixtures use fictional values (`S00000`, "Partenza", …).

## Architecture (push, spec §12–13)

- `web/` is a static page on GitHub Pages. **Dumb client**: it fetches `/status`, renders with `textContent` only and handles stale data, measuring age from `updated_at`. It contains no route data.
- **Poller** (`worker/src/poller*.ts`, bundled to `worker/dist/poller.mjs`): **all logic lives here**: leg selection, state, estimates, colours. It runs as a CronJob on a home k3s cluster, because ViaggiaTreno blocks cloud hosts. It reads the validated `ROUTE_CONFIG`, calls ViaggiaTreno, validates the upstream data and pushes ready-to-render JSON to the Worker.
- `worker/` is a Cloudflare Worker in TypeScript. It accepts the pushed status, stores it in KV and serves it on `GET /status`. It does not know the route.
- **Tenant of a shared cluster:** the namespace `are-you-late` is provided by the cluster's own repository, which also publishes the tenant rules. Everything inside the namespace belongs to this repository. This repository never creates the namespace and never creates cluster-scoped objects.
- Deploy: poller with `deploy/site.yml` through `kubectl` from the workstation (see [deploy/README.md](deploy/README.md)). Worker manually via `wrangler deploy`. Pages via the official GitHub Actions workflow.
- Plan B (not now): Telegram bot on a home server.

## Data source: ViaggiaTreno (unofficial, undocumented)

Base: `https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno`

| Endpoint | Use |
|---|---|
| `andamentoTreno/{originCode}/{train}/{midnightMs}` | stops with scheduled/actual times, delay |
| `partenze/{station}/{date}` | departures board (future trains only) |
| `cercaNumeroTrenoTrenoAutocomplete/{train}` | origin code for a train number |
| `autocompletaStazione/{text}` | station code lookup |

- Cancellation (verified 2026-10-26): partial = `tipoTreno "PP"` with `fermate[].actualFermataType === 3` on the skipped stops. Full = `tipoTreno "ST"` / `provvedimento 1` (not yet observed). `actualFermataType` 0 = not yet reached, 1 = regular.
- `andamentoTreno` returns HTTP 204 for a day that is not loaded yet (e.g. tomorrow), the same as for a train that does not run.
- On the target line only a few stations report actual times (see the spec §2 and `CLAUDE.local.md`).
- **Blocked from cloud hosts (verified 2026-10-26):** ViaggiaTreno (Akamai) answers HTTP 403 "Access Denied" to requests from Cloudflare Workers and from Deno Deploy, with or without a browser User-Agent. Requests from a home connection work. Do not try to get around the block: data must be fetched from a home connection.
- No CORS headers, so the browser cannot call it directly. It may change without notice: when something breaks, check these endpoints first.

## Project rules

- Keep it minimal: plain HTML/CSS/JS in `web/` (no framework, no build). Small TypeScript modules in `worker/`. Tooling is project-local devDependencies only.
- Security: the Worker accepts `GET /status` (+ `OPTIONS`), which never reads the body, and `POST /push`, which checks the bearer `PUSH_TOKEN` in constant time before reading a body of at most 8 KB and validates it field by field. No CORS on `/push`. Secret values never enter tracked files, manifests, logs, Ansible variables or command arguments. `dir` is validated against a closed list. No client input reaches upstream URLs. The upstream JSON is validated and never passed through. CORS is limited to the Pages origin. Rate limit + 30 s edge cache.
- No cookies, analytics or tracking. `noindex`. The footer states the data source and that the site is unofficial.
- Language: code, docs and commit messages in **English**. User-facing UI strings in **Italian**.
- No workstation details in tracked files, commit messages or issues: the workstation is any Linux machine. The terms to search for are in `~/.config/homelab/host-patterns.txt`, outside every repository. Never copy them into a tracked file.
- Thresholds and labels live in `ROUTE_CONFIG`. Important decisions go in this file. Tasks and ideas go to GitHub Issues (generic wording, no route details).
- Small commits.
