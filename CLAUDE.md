# are-you-late

Mobile web page (iPhone first) telling a commuter whether their regional train has left the previous stations and how late it is: one fixed outbound train in the morning, one fixed return train in the early afternoon.

Full design: [docs/superpowers/specs/2026-10-26-are-you-late-design.md](docs/superpowers/specs/2026-10-26-are-you-late-design.md). Read it before changing behaviour.

## Privacy (important)

This repository is public and must not reveal the route. **No station names, station codes, train numbers or real timetables in tracked files**: code, docs, tests/fixtures, commit messages, issues and PRs.

- The real details are in `CLAUDE.local.md` (gitignored, read automatically by Claude Code).
- The real config is in `worker/.dev.vars` (local) and the Cloudflare secret `ROUTE_CONFIG` (production).
- Examples and fixtures use fictional values (`S00000`, "Partenza", …).

## Architecture (decided 2026-10-26)

- `web/` is a static page on GitHub Pages. **Dumb client**: it fetches `/status`, renders with `textContent` only and handles stale data. It contains no route data.
- `worker/` is a Cloudflare Worker in TypeScript. **All logic lives here**: leg selection, state, estimates, colours. It reads the route from the validated `ROUTE_CONFIG`, calls ViaggiaTreno, validates the upstream data and returns ready-to-render JSON using the config labels.
- Deploy: Worker manually from the PC via `wrangler login`, config via `wrangler secret put ROUTE_CONFIG`. Pages via the official GitHub Actions workflow. Automatic Worker deploy from GitHub Actions is a later option.
- Plan B (not now): Telegram bot on a home server.

## Data source: ViaggiaTreno (unofficial, undocumented)

Base: `https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno`

| Endpoint | Use |
|---|---|
| `andamentoTreno/{originCode}/{train}/{midnightMs}` | stops with scheduled/actual times, delay |
| `partenze/{station}/{date}` | departures board (future trains only) |
| `cercaNumeroTrenoTrenoAutocomplete/{train}` | origin code for a train number |
| `autocompletaStazione/{text}` | station code lookup |

- On the target line only a few stations report actual times (see the spec §2 and `CLAUDE.local.md`).
- No CORS headers, so the browser cannot call it directly. It may change without notice: when something breaks, check these endpoints first.

## Project rules

- Keep it minimal: plain HTML/CSS/JS in `web/` (no framework, no build). Small TypeScript modules in `worker/`. Tooling is project-local devDependencies only.
- Security: the Worker accepts only `GET /status` (+ `OPTIONS`) and never reads the body. `dir` is validated against a closed list. No client input reaches upstream URLs. The upstream JSON is validated and never passed through. CORS is limited to the Pages origin. Rate limit + 30 s edge cache.
- No cookies, analytics or tracking. `noindex`. The footer states the data source and that the site is unofficial.
- Language: code, docs and commit messages in **English**. User-facing UI strings in **Italian**.
- Thresholds and labels live in `ROUTE_CONFIG`. Important decisions go in this file. Tasks and ideas go to GitHub Issues (generic wording, no route details).
- Small commits.
