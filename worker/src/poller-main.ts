import { runOnce } from "./poller";

const ok = await runOnce(process.env, { fetchFn: fetch, now: Date.now, log: console.log });
process.exitCode = ok ? 0 : 1;
