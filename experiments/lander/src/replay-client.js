// Replay viewer. Runs in the browser; inlined into report.html by report.ts.
// Reads episodes from <script id="replay-data" type="application/json">.
(() => {
  const DATA = JSON.parse(document.getElementById("replay-data").textContent);
  if (!DATA.length) return;
  const $ = (id) => document.getElementById(id);
  const selA = $("rp-a");
  const selB = $("rp-b");
  const scene = $("rp-scene");
  const timeline = $("rp-timeline");
  const SLOT = ["var(--c1)", "var(--c2)"];
  const NS = "http://www.w3.org/2000/svg";
  const st = { a: 0, b: -1, t: 0, playing: false, speed: 4, last: 0 };

  const label = (e) => `${e.agent} · ${e.clock}`;
  const fmt = (n, p = 1) => (n === undefined || n === null || Number.isNaN(n) ? "–" : Number(n).toFixed(p));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---- episode pickers ----
  const scenarios = [...new Set(DATA.map((e) => e.scenarioId))].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  selA.innerHTML = scenarios
    .map((sid) => `<optgroup label="${sid}">${DATA.map((e, i) => (e.scenarioId === sid ? `<option value="${i}">${esc(label(e))} — ${e.outcome.kind}</option>` : "")).join("")}</optgroup>`)
    .join("");

  function fillB() {
    const a = DATA[st.a];
    const others = DATA.map((e, i) => [e, i]).filter(([e, i]) => i !== st.a && e.scenarioId === a.scenarioId);
    selB.innerHTML = `<option value="-1">(none)</option>` + others.map(([e, i]) => `<option value="${i}">${esc(label(e))} — ${e.outcome.kind}</option>`).join("");
    // Prefer the same agent on the other clock, which is the most telling comparison.
    const twin = others.find(([e]) => e.agent === a.agent && e.clock !== a.clock) ?? others[0];
    st.b = twin ? twin[1] : -1;
    selB.value = String(st.b);
  }

  // Default: an LLM episode that has a twin on another clock, if one exists.
  const preferred = DATA.findIndex((e) => !e.agent.startsWith("baseline") && e.clock === "paused" && DATA.some((o) => o.agent === e.agent && o.scenarioId === e.scenarioId && o.clock !== "paused"));
  st.a = preferred >= 0 ? preferred : 0;
  selA.value = String(st.a);
  fillB();

  selA.onchange = () => { st.a = Number(selA.value); fillB(); reset(); };
  selB.onchange = () => { st.b = Number(selB.value); reset(); };

  const active = () => [DATA[st.a], st.b >= 0 ? DATA[st.b] : null];
  const endTime = () => Math.max(...active().filter(Boolean).map((e) => e.traj[e.traj.length - 1][0]));

  // ---- sampling ----
  function sample(ep, t) {
    const tr = ep.traj;
    if (t <= tr[0][0]) return tr[0];
    const last = tr[tr.length - 1];
    if (t >= last[0]) return last;
    let lo = 0, hi = tr.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid][0] <= t) lo = mid; else hi = mid; }
    const a = tr[lo], b = tr[hi], f = (t - a[0]) / (b[0] - a[0] || 1);
    return a.map((v, i) => (typeof v === "number" && typeof b[i] === "number" ? v + (b[i] - v) * f : v));
  }

  function phaseAt(ep, t) {
    let idx = -1;
    for (let i = 0; i < ep.decisions.length; i++) if (ep.decisions[i].t <= t + 1e-9) idx = i; else break;
    if (idx < 0) return { idx, thinking: false };
    const d = ep.decisions[idx];
    return { idx, d, thinking: t < d.t + d.delay - 1e-9 };
  }

  // ---- scene ----
  const W = 720, H = 380, M = 28;
  function bounds() {
    const eps = active().filter(Boolean);
    const xMax = Math.max(40, ...eps.flatMap((e) => e.traj.map((p) => Math.abs(p[1])))) * 1.1;
    const yMax = Math.max(...eps.flatMap((e) => e.traj.map((p) => p[2]))) * 1.08;
    return { sx: (x) => M + ((x + xMax) / (2 * xMax)) * (W - 2 * M), sy: (y) => H - M - (y / yMax) * (H - 2 * M), xMax, yMax };
  }

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  let B; // bounds for current pair
  function drawStatic() {
    scene.innerHTML = "";
    scene.setAttribute("viewBox", `0 0 ${W} ${H}`);
    B = bounds();
    const a = DATA[st.a];
    el("line", { x1: M, x2: W - M, y1: B.sy(0), y2: B.sy(0), class: "ground" }, scene);
    el("rect", { x: B.sx(-a.padHalfWidth), y: B.sy(0) - 3, width: B.sx(a.padHalfWidth) - B.sx(-a.padHalfWidth), height: 6, class: "padrect" }, scene);
    if (a.twistAltitude) {
      el("line", { x1: M, x2: W - M, y1: B.sy(a.twistAltitude), y2: B.sy(a.twistAltitude), class: "twist" }, scene);
      const tx = el("text", { x: W - M, y: B.sy(a.twistAltitude) - 4, "text-anchor": "end", class: "axis" }, scene);
      tx.textContent = "engine degrades below here";
    }
    const ax = el("text", { x: M, y: 16, class: "axis" }, scene);
    ax.textContent = `altitude 0–${Math.round(B.yMax)} m · dx ±${Math.round(B.xMax)} m · pad at 0`;
    active().forEach((ep, slot) => {
      if (!ep) return;
      const d = ep.traj.map((p, i) => `${i ? "L" : "M"}${B.sx(p[1]).toFixed(1)},${B.sy(p[2]).toFixed(1)}`).join("");
      el("path", { d, fill: "none", stroke: SLOT[slot], "stroke-width": 1, "stroke-dasharray": "2 3", opacity: 0.45 }, scene);
      el("path", { id: `rp-trail-${slot}`, fill: "none", stroke: SLOT[slot], "stroke-width": 2.2, "stroke-linejoin": "round" }, scene);
      const g = el("g", { id: `rp-craft-${slot}` }, scene);
      el("polygon", { class: "flame", id: `rp-flame-${slot}`, points: "" }, g);
      el("polygon", { class: "flame", id: `rp-jet-${slot}`, points: "" }, g);
      el("rect", { x: -7, y: -12, width: 14, height: 10, rx: 2, fill: SLOT[slot] }, g);
      el("path", { d: "M-6,-2 L-9,4 M6,-2 L9,4", stroke: SLOT[slot], "stroke-width": 2 }, g);
      const bubble = el("g", { id: `rp-think-${slot}`, class: "think" }, g);
      el("rect", { x: -34, y: -40, width: 68, height: 20, rx: 10 }, bubble);
      el("text", { x: 0, y: -26, "text-anchor": "middle", id: `rp-think-text-${slot}` }, bubble);
    });
    drawTimeline();
  }

  function drawCraft(ep, slot) {
    const s = sample(ep, st.t);
    const ph = phaseAt(ep, st.t);
    const x = B.sx(s[1]), y = B.sy(s[2]);
    $(`rp-craft-${slot}`).setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    const main = s[5], lat = s[6];
    const fl = 3 + main * 26;
    $(`rp-flame-${slot}`).setAttribute("points", main > 0.02 ? `-4,-2 4,-2 0,${fl.toFixed(1)}` : "");
    const jl = Math.abs(lat) * 16, side = lat > 0 ? -1 : 1; // pushing right means exhaust on the left
    $(`rp-jet-${slot}`).setAttribute("points", Math.abs(lat) > 0.03 ? `${7 * side},-9 ${7 * side},-5 ${(7 + jl) * side},-7` : "");
    const visible = ph.thinking && st.t < ep.traj[ep.traj.length - 1][0];
    $(`rp-think-${slot}`).style.display = visible ? "" : "none";
    if (visible) $(`rp-think-text-${slot}`).textContent = `thinking… ${Math.max(0, ph.d.t + ph.d.delay - st.t).toFixed(1)}s`;
    const upto = ep.traj.filter((p) => p[0] <= st.t);
    upto.push(s);
    $(`rp-trail-${slot}`).setAttribute("d", upto.map((p, i) => `${i ? "L" : "M"}${B.sx(p[1]).toFixed(1)},${B.sy(p[2]).toFixed(1)}`).join(""));
    return { s, ph };
  }

  // ---- timeline ----
  const TW = 720, ROW = 22;
  function drawTimeline() {
    const eps = active();
    const n = eps.filter(Boolean).length;
    timeline.setAttribute("viewBox", `0 0 ${TW} ${n * (ROW + 6) + 22}`);
    timeline.innerHTML = "";
    const tEnd = endTime();
    const tx = (t) => 4 + (t / tEnd) * (TW - 8);
    eps.forEach((ep, slot) => {
      if (!ep) return;
      const y0 = slot * (ROW + 6) + 4;
      el("rect", { x: tx(0), y: y0, width: tx(ep.traj[ep.traj.length - 1][0]) - tx(0), height: ROW, class: "tl-bg" }, timeline);
      for (const d of ep.decisions) {
        if (d.delay > 0) el("rect", { x: tx(d.t), y: y0, width: Math.max(1, tx(d.t + d.delay) - tx(d.t)), height: ROW, class: "tl-think" }, timeline).appendChild(Object.assign(document.createElementNS(NS, "title"), { textContent: `decision ${d.i}: thinking ${d.delay.toFixed(1)}s (${d.tokens} tokens)` }));
        if (!d.tooLate) el("rect", { x: tx(d.t + d.delay), y: y0 + ROW - 5, width: Math.max(1, tx(d.t + d.delay + ep.hold) - tx(d.t + d.delay)), height: 5, fill: SLOT[slot] }, timeline);
        el("line", { x1: tx(d.t), x2: tx(d.t), y1: y0, y2: y0 + ROW, class: "tl-tick" }, timeline);
      }
      if (ep.twistAt != null) el("line", { x1: tx(ep.twistAt), x2: tx(ep.twistAt), y1: y0 - 2, y2: y0 + ROW + 2, class: "twist" }, timeline);
    });
    const axis = el("text", { x: TW - 4, y: n * (ROW + 6) + 16, "text-anchor": "end", class: "axis" }, timeline);
    axis.textContent = `sim time 0–${tEnd.toFixed(0)} s · amber = thinking (old command still running) · coloured = new command held`;
    el("line", { id: "rp-playhead", x1: 0, x2: 0, y1: 0, y2: n * (ROW + 6), class: "playhead" }, timeline);
    timeline.onclick = (ev) => {
      const r = timeline.getBoundingClientRect();
      st.t = Math.max(0, Math.min(tEnd, ((ev.clientX - r.left) / r.width * TW - 4) / (TW - 8) * tEnd));
      render();
    };
  }

  // ---- panels ----
  function panel(ep, slot, s, ph) {
    const host = $(`rp-panel-${slot}`);
    if (!ep) { host.innerHTML = ""; host.hidden = true; return; }
    host.hidden = false;
    const ended = st.t >= ep.traj[ep.traj.length - 1][0] - 1e-6;
    const d = ph.d;
    const status = ended
      ? `<b class="${ep.outcome.kind === "landed" ? "good" : "bad"}">${ep.outcome.kind.toUpperCase()}</b> · score ${ep.outcome.score}${ep.outcome.touchdown ? ` · touchdown vy ${fmt(ep.outcome.touchdown.vy, 2)}, vx ${fmt(ep.outcome.touchdown.vx, 2)}, dx ${fmt(ep.outcome.touchdown.dx, 1)}` : ""}`
      : ph.thinking
        ? `<b class="warn">THINKING</b> on decision ${d.i + 1}: ${d.tokens} tokens = ${fmt(d.delay)} s. The old command keeps running.`
        : d ? `Holding decision ${d.i + 1}` : "Autopilot (hover)";
    const pred = d && d.pred ? `<div class="kv"><span>Predicted @ +5 s</span><span>alt ${fmt(d.pred[0], 0)} m, vy ${fmt(d.pred[1])}</span></div><div class="kv"><span>Actual @ +5 s</span><span>${d.act ? `alt ${fmt(d.act[0], 0)} m, vy ${fmt(d.act[1])}` : "–"}</span></div>` : "";
    host.innerHTML = `
      <h3><span class="sw" style="background:${SLOT[slot]}"></span>${esc(label(ep))}</h3>
      <p class="status">${status}</p>
      <div class="kvs">
        <div class="kv"><span>t</span><span>${fmt(st.t)} s</span></div>
        <div class="kv"><span>Altitude</span><span>${fmt(s[2])} m</span></div>
        <div class="kv"><span>vy / vx</span><span>${fmt(s[4])} / ${fmt(s[3])} m/s</span></div>
        <div class="kv"><span>dx from pad</span><span>${fmt(s[1])} m</span></div>
        <div class="kv"><span>Fuel</span><span>${s[7] === undefined ? "–" : fmt(s[7])}</span></div>
        <div class="kv"><span>Wind</span><span>${s[8] === undefined ? "–" : fmt(s[8], 2)} m/s²</span></div>
        <div class="kv"><span>Engines</span><span>main ${fmt(s[5], 2)} · lateral ${fmt(s[6], 2)}</span></div>
        ${pred}
      </div>
      ${d && d.note ? `<p class="note">“${esc(d.note)}”</p>` : ""}
      <ol class="log">${ep.decisions.map((x) => `<li class="${ph.d && x.i === ph.d.i ? "cur" : ""}${x.valid ? "" : " invalid"}" data-t="${x.t}"><span>${fmt(x.t)}s</span><span>${x.delay > 0 ? `+${fmt(x.delay)}s` : ""}</span><span>m ${fmt(x.ctrl[0], 2)} l ${fmt(x.ctrl[1], 2)}</span><span>${esc(x.note || (x.valid ? "" : "invalid output"))}</span></li>`).join("")}</ol>`;
    host.querySelectorAll(".log li").forEach((li) => (li.onclick = () => { st.t = Number(li.dataset.t); render(); }));
    const cur = host.querySelector(".log li.cur");
    if (cur && st.playing) cur.scrollIntoView({ block: "nearest" });
  }

  // ---- loop ----
  function render() {
    const tEnd = endTime();
    active().forEach((ep, slot) => {
      if (!ep) { panel(null, slot); return; }
      const { s, ph } = drawCraft(ep, slot);
      panel(ep, slot, s, ph);
    });
    const ph = $("rp-playhead");
    if (ph) { const x = 4 + (st.t / tEnd) * (TW - 8); ph.setAttribute("x1", x); ph.setAttribute("x2", x); }
    $("rp-time").textContent = `${st.t.toFixed(1)} / ${tEnd.toFixed(1)} s`;
    $("rp-play").textContent = st.playing ? "Pause" : st.t >= tEnd ? "Replay" : "Play";
  }

  function frame(now) {
    if (!st.playing) return;
    const dt = (now - st.last) / 1000;
    st.last = now;
    st.t = Math.min(endTime(), st.t + dt * st.speed);
    if (st.t >= endTime()) st.playing = false;
    render();
    if (st.playing) requestAnimationFrame(frame);
  }

  function reset() { st.t = 0; st.playing = false; drawStatic(); render(); }

  $("rp-play").onclick = () => {
    if (st.t >= endTime()) st.t = 0;
    st.playing = !st.playing;
    st.last = performance.now();
    render();
    if (st.playing) requestAnimationFrame(frame);
  };
  $("rp-speed").onchange = (e) => (st.speed = Number(e.target.value));

  reset();
})();
