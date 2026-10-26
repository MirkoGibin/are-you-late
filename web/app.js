// Dumb client: fetch /status, render with textContent only, handle stale data.
"use strict";

const API = location.hostname === "localhost" || location.hostname === "127.0.0.1"
  ? "http://127.0.0.1:8787/status"
  : "https://are-you-late.SUBDOMAIN.workers.dev/status";
const REFRESH_MS = 60_000;
const STALE_MS = 3 * 60_000;
const COLORS = ["grey", "yellow", "red", "green"];
const CAPTION = { detected: "rilevato", estimate: "stima", scheduled: "previsto" };

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = String(text);
  return e;
};

let last = null; // last successful response
let lastOkAt = 0;
let failing = false; // last fetch failed: keep `last` on screen, dimmed

function delayText(d) {
  if (typeof d !== "number") return ["", ""];
  if (d > 0) return [`+${d} min`, "delay--late"];
  if (d < 0) return [`in anticipo di ${-d} min`, "delay--early"];
  return ["in orario", ""];
}

function trainMarker() {
  const li = el("li", "train");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "train__icon");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ["M7 4h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z", "M4 11h16", "M8 21l2-3M16 21l-2-3"]) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  li.append(svg, el("span", "", "in viaggio"));
  return li;
}

function render(s) {
  $("leg").textContent = s.direction === "outbound" ? "Andata" : s.direction === "return" ? "Ritorno" : "Treno";
  const [dt, dc] = delayText(s.delay_min);
  $("delay").textContent = dt;
  $("delay").className = `delay ${dc}`;

  const route = $("route");
  route.replaceChildren();
  for (const st of Array.isArray(s.stops) ? s.stops : []) {
    const kind = st.kind in CAPTION ? st.kind : "scheduled";
    const li = el("li", `stop stop--${["passed", "next", "target", "pending"].includes(st.state) ? st.state : "pending"} kind--${kind}`);
    const body = el("div");
    let caption = `${st.time} · ${CAPTION[kind]}`;
    if (st.scheduled && st.scheduled !== st.time) caption += ` · prev. ${st.scheduled}`;
    body.append(el("div", "stop__name", st.name), el("div", "stop__time", caption));
    li.append(el("span", "dot"), body);
    route.appendChild(li);
    if (s.moving_after && st.name === s.moving_after) route.appendChild(trainMarker());
  }

  const color = COLORS.includes(s.light && s.light.color) ? s.light.color : "grey";
  $("light").className = `light light--${color}`;
  $("title").textContent = (s.light && s.light.title) || "";
  $("subtitle").textContent = (s.light && s.light.subtitle) || "";
}

function renderAge() {
  const age = Date.now() - lastOkAt;
  const min = Math.floor(age / 60_000);
  const stale = !last || failing || age > STALE_MS;
  $("app").classList.toggle("stale", Boolean(last) && stale);
  $("updated").textContent = !last ? "" : stale ? `non aggiornato da ${Math.max(1, min)} min` : min < 1 ? "aggiornato ora" : `aggiornato ${min} min fa`;
}

async function refresh() {
  const dir = new URLSearchParams(location.search).get("dir");
  const url = dir === "outbound" || dir === "return" ? `${API}?dir=${dir}` : API;
  try {
    const res = await fetch(url, { referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error(String(res.status));
    last = await res.json();
    lastOkAt = Date.now();
    render(last);
    failing = false;
  } catch {
    failing = true;
    if (!last) render({ light: { color: "grey", title: "Dati non disponibili al momento", subtitle: "" } });
  }
  renderAge();
}

refresh();
setInterval(refresh, REFRESH_MS);
setInterval(renderAge, 15_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});
