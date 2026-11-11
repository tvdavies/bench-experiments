// Lander Bench site. Vanilla JS, no dependencies; data is inlined by src/site.ts.
(() => {
  "use strict";
  const D = JSON.parse(document.getElementById("data").textContent);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n, p = 1) => (n === null || n === undefined || Number.isNaN(n) ? "–" : Number(n).toFixed(p));
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------- theme ----------
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const savedTheme = store.get("lander-theme");
  if (savedTheme === "light" || savedTheme === "dark") document.documentElement.dataset.theme = savedTheme;
  $("theme-toggle").onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("lander-theme", next);
  };

  // ---------- model encoding: hue = provider group, shape + dash = model within group ----------
  const groupOf = (p) => (p === "Anthropic" ? "anthropic" : p === "OpenAI" ? "openai" : p === "Baseline" ? "baseline" : "other");
  const SHAPES = ["circle", "square", "triangle", "diamond", "tdown"];
  const DASHES = ["", "7 4", "2 3", "9 3 2 3", "4 4"];
  const M = D.models.map((m, i) => ({ ...m, i, group: groupOf(m.provider) }));
  const groupCounts = {};
  for (const m of M) {
    m.k = groupCounts[m.group] = (groupCounts[m.group] ?? -1) + 1;
    m.color = `var(--p-${m.group})`;
    m.shape = SHAPES[m.k % SHAPES.length];
    m.dash = DASHES[m.k % DASHES.length];
  }
  const llms = M.filter((m) => !m.baseline);

  function shapeSvg(m, x, y, r = 5, extra = "") {
    const ring = `stroke="var(--surface)" stroke-width="2" paint-order="stroke"`;
    const f = `fill="${m.color}" ${ring} ${extra}`;
    switch (m.shape) {
      case "square": return `<rect x="${x - r * 0.9}" y="${y - r * 0.9}" width="${r * 1.8}" height="${r * 1.8}" rx="1.5" ${f}/>`;
      case "triangle": return `<path d="M${x},${y - r * 1.1}L${x + r * 1.05},${y + r * 0.8}L${x - r * 1.05},${y + r * 0.8}Z" ${f}/>`;
      case "diamond": return `<path d="M${x},${y - r * 1.2}L${x + r * 1.1},${y}L${x},${y + r * 1.2}L${x - r * 1.1},${y}Z" ${f}/>`;
      case "tdown": return `<path d="M${x},${y + r * 1.1}L${x + r * 1.05},${y - r * 0.8}L${x - r * 1.05},${y - r * 0.8}Z" ${f}/>`;
      default: return `<circle cx="${x}" cy="${y}" r="${r}" ${f}/>`;
    }
  }
  const legendMark = (m) =>
    `<svg class="mark" width="30" height="14" viewBox="0 0 30 14" aria-hidden="true"><line x1="1" x2="29" y1="7" y2="7" stroke="${m.color}" stroke-width="2" stroke-dasharray="${m.dash}"/>${shapeSvg(m, 15, 7, 4.2)}</svg>`;

  // ---------- data access ----------
  const F = D.flights.map((f, i) => ({ ...f, i, model: M[f.m], scen: D.scenarios[f.s] }));
  const inSet = (f, set) => set === "all" || f.scen.set === set;
  // Baselines decide instantly, so their only flights are "paused"; they count for both clocks.
  const flightsOf = (m, clock, set) => F.filter((f) => f.m === m.i && inSet(f, set) && (f.c === clock || (m.baseline && f.c === "paused")));
  function agg(list) {
    if (!list.length) return null;
    const dec = list.reduce((a, f) => a + f.n, 0);
    return {
      n: list.length,
      score: mean(list.map((f) => f.sc)),
      landed: list.filter((f) => f.k === "landed").length,
      tpd: dec ? list.reduce((a, f) => a + f.tpd * f.n, 0) / dec : 0,
      th: mean(list.map((f) => f.th)),
    };
  }
  function rows(set) {
    return M.map((m) => {
      const p = agg(flightsOf(m, "paused", set));
      const l = agg(flightsOf(m, "tokens", set));
      return { m, p, l, tax: p && l ? l.score - p.score : null };
    }).filter((r) => r.p || r.l);
  }

  // ---------- tooltip ----------
  const tip = $("tooltip");
  function showTip(html, ev) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > innerHeight - 8) y = ev.clientY - h - pad;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- state ----------
  const S = { set: "standard", fset: "standard", clock: "paused", view: "path", sort: { key: "l", dir: -1 }, hidden: new Set(), hover: null };

  // Segmented controls
  document.querySelectorAll(".seg[data-control]").forEach((seg) => {
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-value]");
      if (!b) return;
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      const key = seg.dataset.control;
      if (key === "speed") { R.speed = Number(b.dataset.value); return; }
      S[key] = b.dataset.value;
      if (key === "set") renderResults();
      else renderMultiples();
    });
  });

  // Linked highlight across every chart
  function setHover(mi) {
    S.hover = mi;
    document.querySelectorAll("[data-m]").forEach((el) => {
      const on = mi === null || Number(el.dataset.m) === mi;
      el.classList.toggle("dim", !on);
    });
  }

  // ---------- hero ----------
  function renderHero() {
    const all = rows("all").filter((r) => !r.m.baseline);
    const bestP = [...all].filter((r) => r.p).sort((a, b) => b.p.score - a.p.score)[0];
    const bestL = [...all].filter((r) => r.l).sort((a, b) => b.l.score - a.l.score)[0];
    const worstTax = [...all].filter((r) => r.tax !== null).sort((a, b) => a.tax - b.tax)[0];
    const pi = rows("all").find((r) => r.m.id === "baseline:pi");
    const flights = F.filter((f) => !f.model.baseline).length;
    const tile = (k, v, d) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
    $("tiles").innerHTML = [
      tile("Models", llms.length, `${flights} model flights over ${D.scenarios.length} scenarios`),
      bestP ? tile("Best with the world paused", fmt(bestP.p.score), `${esc(bestP.m.label)} · ${bestP.p.landed}/${bestP.p.n} landed`) : "",
      bestL ? tile("Best with the world live", fmt(bestL.l.score), `${esc(bestL.m.label)} · ${bestL.l.landed}/${bestL.l.n} landed`) : "",
      worstTax ? tile("Biggest thinking tax", `${fmt(worstTax.tax)}`, `${esc(worstTax.m.label)}, paused → live`) : "",
      pi ? tile("PI controller (20 lines of code)", fmt(pi.p.score), `${pi.p.landed}/${pi.p.n} landed, decides instantly`) : "",
    ].join("");
    document.querySelectorAll('[data-fill="msPerToken"]').forEach((el) => (el.textContent = D.msPerToken));
    document.querySelectorAll('[data-fill="hold"]').forEach((el) => (el.textContent = D.hold));
    document.querySelectorAll('[data-fill="tokPerSec"]').forEach((el) => (el.textContent = Math.round(1000 / D.msPerToken)));
    $("generated").textContent = `Generated ${D.generated.slice(0, 16).replace("T", " ")} UTC · ${F.length} flights`;
  }

  // ---------- leaderboard ----------
  const COLS = [
    { key: "rank", label: "#", sortable: false },
    { key: "model", label: "Model", sortable: false },
    { key: "p", label: "Paused", num: false },
    { key: "l", label: "Live", num: false },
    { key: "tax", label: "Thinking tax", num: true },
    { key: "tpd", label: "Tokens / decision", num: true },
    { key: "th", label: "Time thinking (live)", num: true },
  ];
  const sortVal = (r, key) =>
    key === "p" ? r.p?.score ?? -1 : key === "l" ? r.l?.score ?? -1 : key === "tax" ? r.tax ?? -999 : key === "tpd" ? (r.m.baseline ? -1 : r.l?.tpd ?? r.p?.tpd ?? -1) : key === "th" ? (r.m.baseline ? -1 : r.l?.th ?? -1) : 0;

  function scoreBar(a, m) {
    if (!a) return `<span class="muted">–</span>`;
    return `<div class="scorebar"><span class="val">${fmt(a.score)}</span><span class="bar"><span class="fill" style="width:${clamp(a.score, 0, 100)}%;background:${m.color}"></span></span><span class="cnt">${a.landed}/${a.n}</span></div>`;
  }

  function renderResults() {
    const order = (a, b) => S.sort.dir * (sortVal(a, S.sort.key) - sortVal(b, S.sort.key)) || sortVal(b, "p") - sortVal(a, "p");
    const all = rows(S.set);
    // Models are ranked; reference controllers sit below them, unranked.
    const rs = [...all.filter((r) => !r.m.baseline).sort(order), ...all.filter((r) => r.m.baseline).sort((a, b) => b.p.score - a.p.score)];
    const head = `<thead><tr>${COLS.map((c) => `<th class="${c.num ? "num" : ""}" data-key="${c.key}" ${c.key === S.sort.key ? `aria-sort="${S.sort.dir < 0 ? "descending" : "ascending"}"` : ""}>${c.label}</th>`).join("")}</tr></thead>`;
    let rank = 0;
    let sep = false;
    const body = rs.map((r) => {
      const m = r.m;
      const divider = m.baseline && !sep ? ((sep = true), `<tr class="divider"><td></td><td colspan="${COLS.length - 1}">Reference controllers: hand-written, decide instantly</td></tr>`) : "";
      const tax = m.baseline ? `<span class="muted">none</span>` : r.tax === null ? "–" : `<span class="tax ${r.tax < -5 ? "neg" : r.tax > 5 ? "pos" : ""}">${r.tax > 0 ? "+" : r.tax < 0 ? "−" : ""}${fmt(Math.abs(r.tax))}</span>`;
      const tpd = m.baseline ? `<span class="muted">0</span>` : Math.round(r.l?.tpd ?? r.p?.tpd ?? 0).toLocaleString();
      const th = m.baseline ? `<span class="muted">0%</span>` : r.l ? `${Math.round(r.l.th * 100)}%` : "–";
      return `${divider}<tr class="${m.baseline ? "baseline" : ""}" data-m="${m.i}">
        <td class="rank">${m.baseline ? "" : ++rank}</td>
        <td><div class="model-cell">${legendMark(m)}<div><div class="name">${esc(m.label)}</div><div class="prov">${esc(m.provider)}</div></div></div></td>
        <td>${scoreBar(r.p, m)}</td>
        <td>${m.baseline ? `<div class="scorebar"><span class="val muted">${fmt(r.p?.score)}</span><span class="muted" style="font-size:12.5px">same: decides instantly</span></div>` : scoreBar(r.l, m)}</td>
        <td class="num">${tax}</td><td class="num">${tpd}</td><td class="num">${th}</td></tr>`;
    }).join("");
    $("board").innerHTML = head + `<tbody>${body}</tbody>`;
    $("board").querySelectorAll("th[data-key]").forEach((th) => {
      const c = COLS.find((x) => x.key === th.dataset.key);
      if (c.sortable === false) return;
      th.onclick = () => { S.sort = { key: c.key, dir: S.sort.key === c.key ? -S.sort.dir : -1 }; renderResults(); };
    });
    $("board").querySelectorAll("tbody tr[data-m]").forEach((tr) => {
      const mi = Number(tr.dataset.m);
      tr.onmouseenter = () => setHover(mi);
      tr.onmouseleave = () => setHover(null);
      tr.onclick = () => { openReplayFor(mi); document.getElementById("replay").scrollIntoView({ behavior: "smooth" }); };
    });
    renderScatter(rs);
    renderVerbosity(rs);
    $("legend-results").innerHTML = legendHtml(rs.map((r) => r.m), false);
  }

  function legendHtml(models, interactive) {
    let out = "", last = null;
    for (const m of models) {
      if (interactive && m.group !== last) out += `<span class="group-label">${m.group === "other" ? "Other labs" : esc(m.provider)}</span>`;
      last = m.group;
      out += `<span class="item${S.hidden.has(m.i) && interactive ? " off" : ""}" data-m="${m.i}" data-legend="${m.i}">${legendMark(m)}${esc(m.label)}</span>`;
    }
    return out;
  }

  // ---------- generic axes ----------
  function niceTicks(lo, hi, n = 5) {
    const span = hi - lo, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) ?? 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  // Direct labels: cluster points whose labels would overlap horizontally, then stack each
  // cluster vertically and keep the stack inside the plot.
  function placeLabels(pts, top, bottom, h = 13, w = 96) {
    const clusters = [];
    for (const p of [...pts].sort((a, b) => a.lx - b.lx)) {
      const c = clusters.find((cl) => cl.some((q) => Math.abs(q.lx - p.lx) < w && Math.abs(q.y - p.y) < h * cl.length + h));
      c ? c.push(p) : clusters.push([p]);
    }
    for (const c of clusters) {
      c.sort((a, b) => a.y - b.y);
      c.forEach((p, i) => (p.ly = i ? Math.max(p.y, c[i - 1].ly + h) : p.y));
      for (let i = c.length - 1; i >= 0; i--) c[i].ly = Math.min(c[i].ly, i === c.length - 1 ? bottom : c[i + 1].ly - h);
      for (let i = 0; i < c.length; i++) c[i].ly = Math.max(c[i].ly, i ? c[i - 1].ly + h : top);
    }
    return pts;
  }

  function scatterChart(host, pts, { xLabel, yLabel, xDomain, yDomain = [0, 100], xLog = false, diag = false, xTicks, xFmt = (v) => v }) {
    const W = 560, H = 380, ml = 44, mr = 120, mt = 14, mb = 40;
    const iw = W - ml - mr, ih = H - mt - mb;
    const tx = xLog ? (v) => ml + ((Math.log10(v) - Math.log10(xDomain[0])) / (Math.log10(xDomain[1]) - Math.log10(xDomain[0]))) * iw : (v) => ml + ((v - xDomain[0]) / (xDomain[1] - xDomain[0])) * iw;
    const ty = (v) => mt + ih - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * ih;
    const yT = niceTicks(yDomain[0], yDomain[1], 5);
    const xT = xTicks ?? niceTicks(xDomain[0], xDomain[1], 5);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)} against ${esc(xLabel)}">`;
    s += `<g class="ax">${yT.map((v) => `<line class="gridline" x1="${ml}" x2="${ml + iw}" y1="${ty(v)}" y2="${ty(v)}"/><text x="${ml - 8}" y="${ty(v) + 3.5}" text-anchor="end">${v}</text>`).join("")}`;
    s += xT.map((v) => `<text x="${tx(v)}" y="${mt + ih + 16}" text-anchor="middle">${xFmt(v)}</text>`).join("");
    s += `<line class="baseline-line" x1="${ml}" x2="${ml + iw}" y1="${ty(yDomain[0])}" y2="${ty(yDomain[0])}"/>`;
    s += `<text class="title" x="${ml + iw / 2}" y="${H - 4}" text-anchor="middle">${esc(xLabel)}</text>`;
    s += `<text class="title" x="${-(mt + ih / 2)}" y="12" transform="rotate(-90)" text-anchor="middle">${esc(yLabel)}</text></g>`;
    if (diag) s += `<line class="diag" x1="${tx(xDomain[0])}" y1="${ty(yDomain[0])}" x2="${tx(xDomain[1])}" y2="${ty(yDomain[1])}"/><text class="pt-label" x="${tx(xDomain[1]) - 4}" y="${ty(yDomain[1]) + 14}" text-anchor="end" style="fill:var(--muted)">no tax</text>`;
    const P = pts.map((p) => ({ ...p, x: tx(p.xv), y: ty(p.yv), lx: tx(p.xv) + 10 }));
    placeLabels(P, mt + 4, mt + ih - 6);
    for (const p of P) {
      s += `<g class="pt" data-m="${p.m.i}" data-tip="${esc(p.tip)}">`;
      if (Math.abs(p.ly - p.y) > 2) s += `<line x1="${p.x + 5}" y1="${p.y}" x2="${p.lx - 2}" y2="${p.ly - 4}" stroke="var(--axis)"/>`;
      s += `${shapeSvg(p.m, p.x, p.y, 5.5)}<circle cx="${p.x}" cy="${p.y}" r="12" fill="transparent"/><text class="pt-label" x="${p.lx}" y="${p.ly + 4}">${esc(p.m.label)}</text></g>`;
    }
    s += `</svg>`;
    host.innerHTML = s;
    host.querySelectorAll(".pt").forEach((g) => {
      const mi = Number(g.dataset.m);
      g.onmousemove = (e) => showTip(g.dataset.tip, e);
      g.onmouseenter = () => setHover(mi);
      g.onmouseleave = () => { hideTip(); setHover(null); };
      g.onclick = () => { openReplayFor(mi); document.getElementById("replay").scrollIntoView({ behavior: "smooth" }); };
    });
  }

  function renderScatter(rs) {
    // The PI controller is the one useful reference point; the other baselines are clutter here.
    const pts = rs.filter((r) => r.p && (r.l || r.m.id === "baseline:pi") && (!r.m.baseline || r.m.id === "baseline:pi")).map((r) => {
      const l = r.m.baseline ? r.p : r.l;
      return { m: r.m, xv: r.p.score, yv: l.score, tip: `<b>${esc(r.m.label)}</b><br>Paused ${fmt(r.p.score)} · Live ${fmt(l.score)}<br><span class="tt-sub">${r.m.baseline ? "Decides instantly" : `Thinking tax ${fmt(l.score - r.p.score)}`}</span>` };
    });
    scatterChart($("chart-scatter"), pts, { xLabel: "Score with the world paused", yLabel: "Score with the world live", xDomain: [0, 100], diag: true });
  }

  function renderVerbosity(rs) {
    const pts = rs.filter((r) => !r.m.baseline && r.l && r.l.tpd > 0).map((r) => ({
      m: r.m, xv: clamp(r.l.tpd, 10, 20000), yv: r.l.score,
      tip: `<b>${esc(r.m.label)}</b><br>${Math.round(r.l.tpd).toLocaleString()} tokens / decision<br>≈ ${fmt((r.l.tpd * D.msPerToken) / 1000)} s of flight per decision<br>Live score ${fmt(r.l.score)}`,
    }));
    scatterChart($("chart-verbosity"), pts, { xLabel: `Output tokens per decision (live), ${D.msPerToken} ms each`, yLabel: "Score with the world live", xDomain: [10, 20000], xLog: true, xTicks: [10, 100, 1000, 10000], xFmt: (v) => (v >= 1000 ? `${v / 1000}k` : v) });
  }

  // ---------- small multiples ----------
  const VIEW = {
    path: { x: (p) => p[1], y: (p) => p[2], xl: "dx from pad (m)", yl: "altitude (m)" },
    alt: { x: (p) => p[0], y: (p) => p[2], xl: "time (s)", yl: "altitude (m)" },
    vy: { x: (p) => p[0], y: (p) => p[3], xl: "time (s)", yl: "vertical speed (m/s)" },
  };

  function renderMultiples() {
    const scens = D.scenarios.filter((s) => s.set === S.fset);
    const models = M.filter((m) => F.some((f) => f.m === m.i && f.scen.set === S.fset));
    $("legend-flights").innerHTML = legendHtml(models, true);
    $("legend-flights").querySelectorAll("[data-legend]").forEach((el) => {
      const mi = Number(el.dataset.legend);
      el.onmouseenter = () => setHover(mi);
      el.onmouseleave = () => setHover(null);
      el.onclick = () => { S.hidden.has(mi) ? S.hidden.delete(mi) : S.hidden.add(mi); renderMultiples(); };
    });
    const v = VIEW[S.view];
    const W = 400, H = 280, ml = 40, mr = 10, mt = 10, mb = 30, iw = W - ml - mr, ih = H - mt - mb;
    $("multiples").innerHTML = scens.map((sc) => {
      const fl = F.filter((f) => f.s === D.scenarios.indexOf(sc) && !S.hidden.has(f.m) && (f.c === S.clock || (f.model.baseline && f.c === "paused")));
      // Domains: keep the interesting region; climbing/runaway flights are clipped, not allowed to squash everyone else.
      let xd, yd;
      if (S.view === "path") {
        const xm = Math.min(450, Math.max(60, Math.abs(sc.x0) * 1.35, ...fl.map((f) => Math.min(450, Math.max(...f.traj.map((p) => Math.abs(p[1])))))));
        xd = [-xm, xm];
        yd = [0, sc.y0 * 1.12];
      } else {
        xd = [0, Math.min(240, Math.max(30, ...fl.map((f) => f.T)))];
        yd = S.view === "alt" ? [0, sc.y0 * 1.12] : [-40, 15];
      }
      const tx = (x) => ml + ((x - xd[0]) / (xd[1] - xd[0])) * iw;
      const ty = (y) => mt + ih - ((y - yd[0]) / (yd[1] - yd[0])) * ih;
      const clipId = `clip-${sc.id}`;
      let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(sc.id)} trajectories"><defs><clipPath id="${clipId}"><rect x="${ml}" y="${mt - 4}" width="${iw}" height="${ih + 8}"/></clipPath></defs><g class="ax">`;
      for (const t of niceTicks(yd[0], yd[1], 4)) s += `<line class="gridline" x1="${ml}" x2="${ml + iw}" y1="${ty(t)}" y2="${ty(t)}"/><text x="${ml - 6}" y="${ty(t) + 3.5}" text-anchor="end">${t}</text>`;
      for (const t of niceTicks(xd[0], xd[1], 5)) s += `<text x="${tx(t)}" y="${mt + ih + 14}" text-anchor="middle">${t}</text>`;
      s += `<text class="title" x="${ml + iw / 2}" y="${H - 2}" text-anchor="middle">${v.xl}</text></g>`;
      if (S.view === "path") s += `<line class="groundline" x1="${ml}" x2="${ml + iw}" y1="${ty(0)}" y2="${ty(0)}"/><rect class="padrect" x="${tx(-sc.pad)}" y="${ty(0) - 2}" width="${tx(sc.pad) - tx(-sc.pad)}" height="4" rx="2"/>`;
      if (S.view === "vy") s += `<rect x="${ml}" y="${ty(0)}" width="${iw}" height="${ty(-2) - ty(0)}" fill="var(--good)" opacity="0.12"/><line class="baseline-line" x1="${ml}" x2="${ml + iw}" y1="${ty(0)}" y2="${ty(0)}"/>`;
      if (S.view !== "vy" && sc.twistAlt) s += `<line class="twistline" x1="${ml}" x2="${ml + iw}" y1="${ty(sc.twistAlt)}" y2="${ty(sc.twistAlt)}"/><text class="twistlabel" x="${ml + iw - 2}" y="${ty(sc.twistAlt) - 4}" text-anchor="end">engine weakens below here</text>`;
      s += `<g clip-path="url(#${clipId})">`;
      for (const f of fl) {
        const d = f.traj.map((p, i) => `${i ? "L" : "M"}${tx(v.x(p)).toFixed(1)},${ty(v.y(p)).toFixed(1)}`).join("");
        const tip = `<b>${esc(f.model.label)}</b> · ${f.c === "tokens" ? "live" : "paused"}<br>${f.k} · score ${fmt(f.sc)}${f.td ? `<br><span class="tt-sub">touchdown vy ${fmt(f.td[0])}, vx ${fmt(f.td[1])}, dx ${fmt(f.td[2], 0)}</span>` : ""}`;
        const last = f.traj[f.traj.length - 1];
        const ex = tx(v.x(last)), ey = ty(v.y(last));
        const end = f.k === "landed"
          ? shapeSvg(f.model, ex, ey, 4.5, 'class="endmark"')
          : `<path class="endmark" d="M${ex - 4},${ey - 4}L${ex + 4},${ey + 4}M${ex + 4},${ey - 4}L${ex - 4},${ey + 4}" stroke="${f.model.color}" stroke-width="2"/>`;
        s += `<g data-m="${f.m}" data-tip="${esc(tip)}" class="flight${S.hover !== null && S.hover !== f.m ? " dim" : ""}"><path class="traj" d="${d}" stroke="${f.model.color}" stroke-dasharray="${f.model.dash}"/>${end}<path class="traj-hit" d="${d}"/></g>`;
      }
      s += `</g></svg>`;
      const landed = fl.filter((f) => !f.model.baseline && f.k === "landed").length;
      const total = fl.filter((f) => !f.model.baseline).length;
      return `<div class="card multi"><div class="multi-head"><h3>${S.fset === "twist" ? "Engine failure" : "Windy"} · seed ${sc.seed}</h3><div class="meta">g ${sc.g} m/s² · ${landed}/${total} models landed</div></div>${s}</div>`;
    }).join("");
    $("multiples").querySelectorAll("g.flight").forEach((g) => {
      const mi = Number(g.dataset.m);
      g.onmousemove = (e) => showTip(g.dataset.tip, e);
      g.onmouseenter = () => setHover(mi);
      g.onmouseleave = () => { hideTip(); setHover(null); };
    });
  }

  // ---------- replay ----------
  const SLOT = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];
  const LETTER = ["A", "B", "C", "D"];
  const R = { s: 0, picks: [], focus: 0, t: 0, playing: false, speed: 4, last: 0, end: 1, B: null, els: [] };
  const flightFor = (s, m, c) => F.find((f) => f.s === s && f.m === m && f.c === c);
  const scenLabel = (sc) => `${sc.set === "twist" ? "Engine failure" : "Windy"} · seed ${sc.seed}`;

  $("rp-scenario").innerHTML = D.scenarios.map((sc, i) => `<option value="${i}">${scenLabel(sc)}</option>`).join("");
  $("rp-scenario").onchange = (e) => { R.s = Number(e.target.value); R.picks = R.picks.filter((p) => flightFor(R.s, p.m, p.c)); if (!R.picks.length) R.picks = defaultPicks(R.s); rebuildReplay(); };
  $("rp-add").onchange = (e) => {
    if (!e.target.value) return;
    const [m, c] = e.target.value.split("|");
    if (R.picks.length < 4) R.picks.push({ m: Number(m), c });
    rebuildReplay();
  };

  function defaultPicks(s, preferModel = null) {
    const all = rows("all").filter((r) => !r.m.baseline);
    const bestP = preferModel ?? [...all].filter((r) => r.p).sort((a, b) => b.p.score - a.p.score)[0]?.m.i;
    const bestL = [...all].filter((r) => r.l && r.m.i !== bestP).sort((a, b) => b.l.score - a.l.score)[0]?.m.i;
    const pi = M.find((m) => m.id === "baseline:pi")?.i;
    const picks = [];
    const add = (m, c) => { if (m !== undefined && flightFor(s, m, c) && !picks.some((p) => p.m === m && p.c === c)) picks.push({ m, c }); };
    add(bestP, "paused"); add(bestP, "tokens"); add(bestL, "tokens"); add(pi, "paused");
    return picks.slice(0, 4);
  }

  function openReplayFor(mi) {
    const sc = R.s;
    R.picks = defaultPicks(sc, mi);
    rebuildReplay();
  }

  function sample(f, t) {
    const tr = f.traj;
    if (t <= tr[0][0]) return tr[0];
    const last = tr[tr.length - 1];
    if (t >= last[0]) return last;
    let lo = 0, hi = tr.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid][0] <= t) lo = mid; else hi = mid; }
    const a = tr[lo], b = tr[hi], k = (t - a[0]) / (b[0] - a[0] || 1);
    return a.map((v, i) => v + (b[i] - v) * k);
  }
  function phase(f, t) {
    let idx = -1;
    for (let i = 0; i < f.dec.length; i++) { if (f.dec[i][0] <= t + 1e-9) idx = i; else break; }
    if (idx < 0) return { idx, thinking: false };
    const d = f.dec[idx];
    return { idx, d, thinking: t < d[0] + d[1] - 1e-9 };
  }

  const SW = 800, SH = 420, SM = 34;
  function rebuildReplay() {
    R.playing = false;
    R.t = 0;
    R.focus = Math.min(R.focus, Math.max(0, R.picks.length - 1));
    $("rp-scenario").value = String(R.s);
    const flights = R.picks.map((p) => flightFor(R.s, p.m, p.c)).filter(Boolean);
    R.flights = flights;
    R.end = Math.max(1, ...flights.map((f) => f.T));

    // chips + add menu
    $("rp-chips").innerHTML = flights.map((f, i) => `<span class="chip"><span class="badge" style="background:${SLOT[i]}">${LETTER[i]}</span>${esc(f.model.label)} <span class="muted">${f.c === "tokens" ? "live" : "paused"}</span><button type="button" data-rm="${i}" aria-label="Remove ${esc(f.model.label)}">×</button></span>`).join("");
    $("rp-chips").querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { R.picks.splice(Number(b.dataset.rm), 1); rebuildReplay(); }));
    const opts = [];
    for (const m of M) for (const c of m.baseline ? ["paused"] : ["paused", "tokens"]) {
      if (flightFor(R.s, m.i, c) && !R.picks.some((p) => p.m === m.i && p.c === c)) opts.push(`<option value="${m.i}|${c}">${esc(m.label)} · ${c === "tokens" ? "live" : "paused"}</option>`);
    }
    $("rp-add").innerHTML = `<option value="">${R.picks.length >= 4 ? "Four flights max" : "+ Add flight"}</option>${R.picks.length >= 4 ? "" : opts.join("")}`;
    $("rp-add").disabled = R.picks.length >= 4;

    // scene bounds from the selected flights
    const sc = D.scenarios[R.s];
    const xm = Math.max(60, Math.abs(sc.x0) * 1.2, ...flights.map((f) => Math.max(...f.traj.map((p) => Math.abs(p[1]))))) * 1.08;
    const ym = Math.max(sc.y0, ...flights.map((f) => Math.max(...f.traj.map((p) => p[2])))) * 1.08;
    const sx = (x) => SM + ((x + xm) / (2 * xm)) * (SW - 2 * SM);
    const sy = (y) => SH - 40 - (y / ym) * (SH - 40 - 18);
    R.B = { sx, sy };

    let s = `<defs>${flights.map((_, i) => `<pattern id="hatch-${i}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${SLOT[i]}" opacity="0.18"/><line x1="0" y1="0" x2="0" y2="6" stroke="${SLOT[i]}" stroke-width="2.2"/></pattern>`).join("")}</defs>`;
    for (const t of niceTicks(0, ym, 4)) s += `<line x1="${SM}" x2="${SW - SM}" y1="${sy(t)}" y2="${sy(t)}" stroke="var(--grid)"/><text x="${SM + 2}" y="${sy(t) - 4}" fill="var(--muted)" font-size="11">${t} m</text>`;
    s += `<rect x="0" y="${sy(0)}" width="${SW}" height="${SH - sy(0)}" fill="var(--ground)"/>`;
    s += `<rect x="${sx(-sc.pad)}" y="${sy(0) - 3}" width="${sx(sc.pad) - sx(-sc.pad)}" height="6" rx="2" fill="var(--good)"/>`;
    s += `<text x="${(sx(-sc.pad) + sx(sc.pad)) / 2}" y="${sy(0) + 20}" text-anchor="middle" fill="var(--ink-2)" font-size="11">pad</text>`;
    if (sc.twistAlt && sc.twistAlt < ym) s += `<line class="twistline" x1="${SM}" x2="${SW - SM}" y1="${sy(sc.twistAlt)}" y2="${sy(sc.twistAlt)}"/><text class="twistlabel" x="${SW - SM}" y="${sy(sc.twistAlt) - 5}" text-anchor="end">engine weakens below here</text>`;
    flights.forEach((f, i) => {
      const d = f.traj.map((p, j) => `${j ? "L" : "M"}${sx(p[1]).toFixed(1)},${sy(p[2]).toFixed(1)}`).join("");
      s += `<path d="${d}" fill="none" stroke="${SLOT[i]}" stroke-width="1.2" stroke-dasharray="2 4" opacity="0.55"/>`;
      s += `<path id="rp-trail-${i}" fill="none" stroke="${SLOT[i]}" stroke-width="2.4" stroke-linejoin="round"/>`;
    });
    flights.forEach((f, i) => {
      s += `<g id="rp-craft-${i}">
        <polygon id="rp-flame-${i}" fill="var(--flame)"/><polygon id="rp-jet-${i}" fill="var(--flame)"/>
        <path d="M-7,-3 L-10,5 M7,-3 L10,5" stroke="var(--ink-2)" stroke-width="2" stroke-linecap="round"/>
        <rect x="-9" y="-16" width="18" height="14" rx="4" fill="${SLOT[i]}" stroke="var(--surface)" stroke-width="1.5"/>
        <text x="0" y="-5.5" text-anchor="middle" fill="#fff" font-size="10" font-weight="700">${LETTER[i]}</text>
        <g id="rp-think-${i}" style="display:none"><rect x="-38" y="-42" width="76" height="20" rx="10" fill="var(--ink)"/><text id="rp-think-t-${i}" x="0" y="-28" text-anchor="middle" fill="var(--surface)" font-size="11" font-weight="600"></text></g>
      </g>`;
    });
    $("rp-scene").innerHTML = s;

    // lanes
    const LW = 800, LH = 26, lx0 = 26, lx1 = LW - 24;
    const lt = (t) => lx0 + (t / R.end) * (lx1 - lx0);
    R.lt = lt;
    let l = "";
    flights.forEach((f, i) => {
      const y = i * (LH + 6);
      l += `<text class="lane-label" x="2" y="${y + LH / 2 + 4}" font-weight="700">${LETTER[i]}</text>`;
      l += `<rect class="lane-bg" x="${lx0}" y="${y}" width="${lt(f.T) - lx0}" height="${LH}" rx="5"/>`;
      for (const d of f.dec) {
        if (d[1] > 0) l += `<rect x="${lt(d[0])}" y="${y}" width="${Math.max(1, lt(Math.min(f.T, d[0] + d[1])) - lt(d[0]))}" height="${LH}" fill="url(#lhatch-${i})"><title>Thinking ${fmt(d[1])} s (${d[2]} tokens)</title></rect>`;
        const a0 = d[0] + d[1];
        if (a0 < f.T) l += `<rect x="${lt(a0)}" y="${y + LH - 6}" width="${Math.max(1, lt(Math.min(f.T, a0 + D.hold)) - lt(a0))}" height="6" fill="${SLOT[i]}"/>`;
      }
      const ex = lt(f.T);
      l += f.k === "landed"
        ? `<path d="M${ex + 4},${y + LH / 2} l3,3 l6,-7" stroke="var(--good)" stroke-width="2.2" fill="none"/>`
        : `<path d="M${ex + 4},${y + LH / 2 - 4} l8,8 M${ex + 12},${y + LH / 2 - 4} l-8,8" stroke="var(--critical)" stroke-width="2.2"/>`;
    });
    const lh = Math.max(1, flights.length) * (LH + 6) + 16;
    l = `<defs>${flights.map((_, i) => `<pattern id="lhatch-${i}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${SLOT[i]}" opacity="0.15"/><line x1="0" y1="0" x2="0" y2="6" stroke="${SLOT[i]}" stroke-width="2"/></pattern>`).join("")}</defs>` + l;
    l += `<text x="${lx1}" y="${lh - 2}" text-anchor="end" fill="var(--muted)" font-size="11">hatched = thinking, old command still firing · solid = new command held · ${fmt(R.end, 0)} s</text>`;
    l += `<line id="rp-head" class="playhead" x1="${lx0}" x2="${lx0}" y1="0" y2="${lh - 14}"/>`;
    $("rp-lanes").setAttribute("viewBox", `0 0 ${LW} ${lh}`);
    $("rp-lanes").innerHTML = l;
    $("rp-lanes").onclick = (e) => {
      const r = $("rp-lanes").getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * LW;
      seek(((x - lx0) / (lx1 - lx0)) * R.end);
    };

    // cards: fixed structure, updated in place
    $("rp-cards").innerHTML = flights.map((f, i) => `<div class="fcard${i === R.focus ? " focus" : ""}" data-i="${i}">
      <span class="badge" style="background:${SLOT[i]}">${LETTER[i]}</span>
      <div class="title"><span>${esc(f.model.label)}</span><span class="clock">${f.c === "tokens" ? "live" : "paused"} · ${fmt(f.sc)}</span></div>
      <div class="status" id="rp-st-${i}"></div>
      <div class="stats">
        <div class="stat">alt<span id="rp-alt-${i}"></span></div><div class="stat">vy<span id="rp-vy-${i}"></span></div>
        <div class="stat">dx<span id="rp-dx-${i}"></span></div><div class="stat">fuel<span id="rp-fuel-${i}"></span></div>
      </div></div>`).join("") || `<p class="muted">Add a flight to start.</p>`;
    $("rp-cards").querySelectorAll(".fcard").forEach((c) => (c.onclick = () => { R.focus = Number(c.dataset.i); $("rp-cards").querySelectorAll(".fcard").forEach((x) => x.classList.toggle("focus", x === c)); buildLog(); render(); }));
    buildLog();
    render();
  }

  function buildLog() {
    const f = R.flights[R.focus];
    if (!f) { $("rp-log").innerHTML = ""; $("rp-log-title").textContent = "Decisions"; return; }
    $("rp-log-title").textContent = `${LETTER[R.focus]} · ${f.model.label} · ${f.dec.length} decisions`;
    $("rp-log").innerHTML = f.dec.map((d, i) => {
      const pred = d[6] !== null && d[8] !== null ? `<small>pred 5 s: alt ${fmt(d[6], 0)} vy ${fmt(d[7])} · actual ${fmt(d[8], 0)} / ${fmt(d[9])}</small>` : "";
      return `<li data-i="${i}" class="${d[5] ? "" : "bad"}${f.c === "paused" ? " paused" : ""}"><span class="t">${fmt(d[0])}s</span>${f.c === "paused" ? "" : `<span class="d" title="thinking time">+${fmt(d[1])}s</span>`}<span class="n">m ${fmt(d[3], 2)} · l ${fmt(d[4], 2)}${d[10] ? ` · ${esc(d[10])}` : ""}${pred}</span></li>`;
    }).join("");
    $("rp-log").querySelectorAll("li").forEach((li) => (li.onclick = () => seek(f.dec[Number(li.dataset.i)][0] + 1e-6)));
    R.logCur = -1;
  }

  function render() {
    const { sx, sy } = R.B;
    R.flights.forEach((f, i) => {
      const s = sample(f, R.t);
      const ph = phase(f, R.t);
      const ended = R.t >= f.T - 1e-6;
      $(`rp-craft-${i}`).setAttribute("transform", `translate(${sx(s[1]).toFixed(1)},${sy(s[2]).toFixed(1)})`);
      const main = ended ? 0 : s[4], lat = ended ? 0 : s[5];
      $(`rp-flame-${i}`).setAttribute("points", main > 0.02 ? `-4,-2 4,-2 0,${(4 + main * 24).toFixed(1)}` : "");
      const side = lat > 0 ? -1 : 1, jl = Math.abs(lat) * 14;
      $(`rp-jet-${i}`).setAttribute("points", Math.abs(lat) > 0.03 ? `${9 * side},-11 ${9 * side},-6 ${(9 + jl) * side},-8.5` : "");
      const thinking = ph.thinking && !ended;
      $(`rp-think-${i}`).style.display = thinking ? "" : "none";
      if (thinking) $(`rp-think-t-${i}`).textContent = `thinking ${fmt(ph.d[0] + ph.d[1] - R.t)}s`;
      const upto = f.traj.filter((p) => p[0] <= R.t);
      upto.push(s);
      $(`rp-trail-${i}`).setAttribute("d", upto.map((p, j) => `${j ? "L" : "M"}${sx(p[1]).toFixed(1)},${sy(p[2]).toFixed(1)}`).join(""));
      const st = $(`rp-st-${i}`);
      st.innerHTML = ended
        ? f.k === "landed" ? `<b class="state-good">Landed</b> · ${f.td ? `vy ${fmt(f.td[0])}, dx ${fmt(f.td[2], 0)} m` : ""}` : `<b class="state-bad">${f.k === "timeout" ? "Timed out" : f.k === "missed-pad" ? "Missed the pad" : "Crashed"}</b>${f.td ? ` · vy ${fmt(f.td[0])} m/s` : ""}`
        : thinking ? `<b class="state-thinking">Thinking</b> · ${ph.d[2].toLocaleString()} tokens, ${fmt(ph.d[1])} s`
        : ph.d ? `Flying decision ${ph.idx + 1}${ph.d[10] ? ` · ${esc(ph.d[10])}` : ""}` : "Autopilot holding hover";
      $(`rp-alt-${i}`).textContent = fmt(s[2], 0);
      $(`rp-vy-${i}`).textContent = fmt(s[3]);
      $(`rp-dx-${i}`).textContent = fmt(s[1], 0);
      $(`rp-fuel-${i}`).textContent = fmt(s[6], 0);
    });
    // log highlight: scroll inside the log only, never the page
    const f = R.flights[R.focus];
    if (f) {
      const idx = phase(f, R.t).idx;
      if (idx !== R.logCur) {
        const log = $("rp-log");
        log.querySelector("li.cur")?.classList.remove("cur");
        const li = log.children[idx];
        if (li) {
          li.classList.add("cur");
          if (li.offsetTop < log.scrollTop || li.offsetTop + li.offsetHeight > log.scrollTop + log.clientHeight) log.scrollTop = li.offsetTop - log.clientHeight / 3;
        }
        R.logCur = idx;
      }
    }
    const hx = R.lt(R.t);
    $("rp-head")?.setAttribute("x1", hx);
    $("rp-head")?.setAttribute("x2", hx);
    $("rp-time").textContent = `${fmt(R.t)} s`;
    $("rp-scrub").value = String(Math.round((R.t / R.end) * 1000));
    $("rp-play").classList.toggle("playing", R.playing);
    $("rp-play").setAttribute("aria-label", R.playing ? "Pause" : "Play");
  }

  function seek(t) { R.t = clamp(t, 0, R.end); render(); }
  function frame(now) {
    if (!R.playing) return;
    R.t = Math.min(R.end, R.t + ((now - R.last) / 1000) * R.speed);
    R.last = now;
    if (R.t >= R.end) R.playing = false;
    render();
    if (R.playing) requestAnimationFrame(frame);
  }
  $("rp-play").onclick = () => {
    if (!R.flights.length) return;
    if (R.t >= R.end) R.t = 0;
    R.playing = !R.playing;
    R.last = performance.now();
    render();
    if (R.playing) requestAnimationFrame(frame);
  };
  $("rp-scrub").oninput = (e) => { R.playing = false; seek((Number(e.target.value) / 1000) * R.end); };

  // ---------- boot ----------
  renderHero();
  renderResults();
  renderMultiples();
  R.picks = defaultPicks(0);
  rebuildReplay();
})();
