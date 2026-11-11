#!/usr/bin/env bun
/**
 * Build a self-contained HTML report from one or more run folders.
 *
 *   bun run lander:report                         # every run under results/lander
 *   bun run lander:report results/lander/<runId>  # specific runs
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, round } from "@bench/core";
import type { EpisodeResult } from "./episode.ts";
import { type SummaryRow, summarise } from "./summary.ts";

const root = resolve(REPO_ROOT, "results", "lander");
const args = process.argv.slice(2);
const runDirs = args.length
  ? args.map((a) => resolve(a))
  : existsSync(root)
    ? readdirSync(root).map((d) => resolve(root, d))
    : [];

const episodes: EpisodeResult[] = [];
for (const dir of runDirs) {
  const file = resolve(dir, "episodes.jsonl");
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) if (line.trim()) episodes.push(JSON.parse(line));
}
if (episodes.length === 0) {
  console.error("No episodes found. Run `bun run lander ...` first.");
  process.exit(1);
}

// Later runs override earlier ones for the same agent/clock/scenario.
const latest = new Map<string, EpisodeResult>();
for (const e of episodes) latest.set(`${e.agent}|${e.clock.mode}|${e.scenario.id}`, e);
const all = [...latest.values()];
const rows = summarise(all).sort((a, b) => a.set.localeCompare(b.set) || b.meanScore - a.meanScore);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const fmt = (n: number | null, p = 1) => (n === null || Number.isNaN(n) ? "–" : n.toFixed(p));

function scoreboard(rs: SummaryRow[]): string {
  const head = ["Agent", "Clock", "Set", "n", "Score", "Landed", "Crashed", "Missed", "Timeout", "Thinking", "Tok/decision", "vy MAE 5s", "vy MAE pre/post twist"];
  const body = rs
    .map(
      (r) => `<tr>
  <td>${esc(r.agent)}</td><td><span class="pill ${r.clock}">${r.clock}</span></td><td>${r.set}</td>
  <td class="n">${r.episodes}${r.infraErrors ? ` <span class="warn" title="episodes dropped for endpoint errors">(+${r.infraErrors} err)</span>` : ""}</td>
  <td class="n strong">${fmt(r.meanScore)} <span class="dim">±${fmt(r.scoreCi95)}</span></td>
  <td class="n">${r.landed}</td><td class="n">${r.crashed}</td><td class="n">${r.missedPad}</td><td class="n">${r.timeouts}</td>
  <td class="n">${fmt(r.meanThinkingShare * 100, 0)}%</td><td class="n">${r.outputTokensPerDecision}</td>
  <td class="n">${fmt(r.verticalSpeedMae, 2)}</td>
  <td class="n">${r.verticalSpeedMaeBeforeTwist === null ? "–" : `${fmt(r.verticalSpeedMaeBeforeTwist, 2)} → ${fmt(r.verticalSpeedMaeAfterTwist, 2)}`}</td>
</tr>`,
    )
    .join("\n");
  return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
}

function thinkingTax(rs: SummaryRow[]): string {
  const out: string[] = [];
  const keys = new Set(rs.map((r) => `${r.agent}|${r.set}`));
  for (const key of keys) {
    const [agent, set] = key.split("|") as [string, string];
    const p = rs.find((r) => r.agent === agent && r.set === set && r.clock === "paused");
    const t = rs.find((r) => r.agent === agent && r.set === set && r.clock !== "paused");
    if (!p || !t) continue;
    const tax = p.meanScore - t.meanScore;
    out.push(
      `<tr><td>${esc(agent)}</td><td>${set}</td><td class="n">${fmt(p.meanScore)}</td><td class="n">${fmt(t.meanScore)} <span class="dim">(${t.clock})</span></td><td class="n strong ${tax > 5 ? "bad" : tax < -5 ? "good" : ""}">${tax >= 0 ? "−" : "+"}${fmt(Math.abs(tax))}</td><td class="n">${fmt(t.meanThinkingShare * 100, 0)}%</td></tr>`,
    );
  }
  if (out.length === 0) return `<p class="dim">Run the same agent with <code>--clock paused,tokens</code> to see this.</p>`;
  return `<table><thead><tr><th>Agent</th><th>Set</th><th>Paused score</th><th>Live score</th><th>Thinking tax</th><th>Time spent thinking</th></tr></thead><tbody>${out.join("")}</tbody></table>`;
}

const PALETTE = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)"];
const seriesKeys = [...new Set(all.map((e) => `${e.agent} · ${e.clock.mode}`))].sort();
const colour = (key: string) => PALETTE[seriesKeys.indexOf(key) % PALETTE.length] as string;

function trajectoryPlot(scenarioId: string, eps: EpisodeResult[]): string {
  const W = 520;
  const H = 300;
  const pad = 32;
  const xs = eps.flatMap((e) => e.trajectory.map((p) => p[1]));
  const ys = eps.flatMap((e) => e.trajectory.map((p) => p[2]));
  const xMax = Math.max(60, ...xs.map(Math.abs)) * 1.05;
  const yMax = Math.max(...ys) * 1.05;
  const sx = (x: number) => pad + ((x + xMax) / (2 * xMax)) * (W - 2 * pad);
  const sy = (y: number) => H - pad - (y / yMax) * (H - 2 * pad);
  const s = eps[0]?.scenario;
  const padHalf = s?.padHalfWidth ?? 15;

  const paths = eps
    .map((e) => {
      const key = `${e.agent} · ${e.clock.mode}`;
      const d = e.trajectory.map((p, i) => `${i ? "L" : "M"}${sx(p[1]).toFixed(1)},${sy(p[2]).toFixed(1)}`).join("");
      const last = e.trajectory[e.trajectory.length - 1];
      const end = last
        ? `<circle cx="${sx(last[1]).toFixed(1)}" cy="${sy(last[2]).toFixed(1)}" r="4" fill="${e.outcome.kind === "landed" ? colour(key) : "none"}" stroke="${colour(key)}" stroke-width="2"><title>${esc(key)}: ${e.outcome.kind} ${e.outcome.score}</title></circle>`
        : "";
      return `<path d="${d}" fill="none" stroke="${colour(key)}" stroke-width="1.8" stroke-linejoin="round"><title>${esc(key)}: ${e.outcome.kind} (${e.outcome.score})</title></path>${end}`;
    })
    .join("");
  const twist = s?.twist
    ? `<line x1="${pad}" x2="${W - pad}" y1="${sy(s.twist.belowAltitude)}" y2="${sy(s.twist.belowAltitude)}" class="twist"/><text x="${W - pad}" y="${sy(s.twist.belowAltitude) - 4}" text-anchor="end" class="axis">engine degrades</text>`
    : "";
  const legend = eps
    .map((e) => `<li><span class="sw" style="background:${colour(`${e.agent} · ${e.clock.mode}`)}"></span>${esc(e.agent)} · ${e.clock.mode} — <b>${e.outcome.kind}</b> ${e.outcome.score}${e.outcome.touchdown ? ` <span class="dim">(vy ${round(e.outcome.touchdown.vy, 1)}, vx ${round(e.outcome.touchdown.vx, 1)}, dx ${round(e.outcome.touchdown.dx, 0)})</span>` : ""}</li>`)
    .join("");
  return `<figure>
<figcaption><b>${scenarioId}</b> <span class="dim">g=${s?.gravity} m/s² · start alt ${s?.start.y} m, dx ${s?.start.x} m · wind mean ${s?.wind.mean}</span></figcaption>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Trajectories for ${scenarioId}">
  <line x1="${pad}" x2="${W - pad}" y1="${sy(0)}" y2="${sy(0)}" class="ground"/>
  <rect x="${sx(-padHalf)}" y="${sy(0) - 3}" width="${sx(padHalf) - sx(-padHalf)}" height="6" class="padrect"/>
  <text x="${pad}" y="${pad - 10}" class="axis">altitude ${Math.round(yMax)} m</text>
  <text x="${W / 2}" y="${H - 8}" text-anchor="middle" class="axis">dx (pad at 0, ±${Math.round(xMax)} m)</text>
  ${twist}${paths}
</svg>
<ul class="legend">${legend}</ul>
</figure>`;
}

const byScenario = new Map<string, EpisodeResult[]>();
for (const e of all) byScenario.set(e.scenario.id, [...(byScenario.get(e.scenario.id) ?? []), e]);
const plots = [...byScenario.entries()]
  .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
  .map(([id, eps]) => trajectoryPlot(id, eps.sort((a, b) => a.agent.localeCompare(b.agent))))
  .join("\n");

// Compact per-episode data for the in-browser replay viewer.
const replayData = all.map((e) => ({
  agent: e.agent,
  clock: e.clock.mode,
  hold: e.clock.holdSeconds,
  scenarioId: e.scenario.id,
  padHalfWidth: e.scenario.padHalfWidth,
  twistAltitude: e.scenario.twist?.belowAltitude ?? null,
  twistAt: e.outcome.twistTriggeredAt,
  outcome: { kind: e.outcome.kind, score: e.outcome.score, touchdown: e.outcome.touchdown },
  traj: e.trajectory,
  decisions: e.decisions.map((d) => ({
    i: d.index,
    t: d.obs.t,
    delay: d.delaySeconds,
    tooLate: d.tooLate,
    tokens: d.outputTokens,
    valid: d.valid,
    ctrl: [d.control.main, d.control.lateral],
    pred: d.prediction ? [d.prediction.altitude5s ?? null, d.prediction.verticalSpeed5s ?? null] : null,
    act: d.actual5s ? [d.actual5s.altitude, d.actual5s.verticalSpeed] : null,
    note: d.note ?? d.parseError ?? d.infraError ?? "",
  })),
}));
// Safe to embed in <script>: no "<" survives, so "</script>" can't appear.
const replayJson = JSON.stringify(replayData).replace(/</g, "\\u003c");
const replayClient = readFileSync(resolve(import.meta.dir, "replay-client.js"), "utf8");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lander Bench Report</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--dim:#6b6a65;--line:#dedbd2;--card:#fff;--good:#1f7a4d;--bad:#b3261e;--warn:#9a6700;
--c1:#2f6fdf;--c2:#d1495b;--c3:#2a9d8f;--c4:#e9a03b;--c5:#7b5ea7;--c6:#4f772d;--c7:#c05299;--c8:#5f6b7a;--sky:#e8eef7}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151513;--fg:#ecebe6;--dim:#9b9a93;--line:#34332f;--card:#1d1d1b;--good:#5cc48d;--bad:#ff8a80;--warn:#e3b341;
--c1:#6f9cff;--c2:#ff7a8a;--c3:#4fd1c0;--c4:#ffc266;--c5:#b598e6;--c6:#8fc25a;--c7:#ef86c8;--c8:#a3adba;--sky:#1b2230}}
:root[data-theme="dark"]{--bg:#151513;--fg:#ecebe6;--dim:#9b9a93;--line:#34332f;--card:#1d1d1b;--good:#5cc48d;--bad:#ff8a80;--warn:#e3b341}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:36px 0 10px}
p{max-width:75ch}.dim{color:var(--dim)}.strong{font-weight:600}.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13.5px;background:var(--card)}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{font-weight:600;color:var(--dim)}td.n{text-align:right;font-variant-numeric:tabular-nums}
.pill{font-size:12px;padding:1px 7px;border-radius:99px;border:1px solid var(--line)}.pill.tokens,.pill.wall{border-color:var(--c4)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,520px),1fr));gap:18px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}figcaption{font-size:13px;margin-bottom:6px}
svg{width:100%;height:auto;display:block}.ground{stroke:var(--dim);stroke-width:1}.padrect{fill:var(--good)}.twist{stroke:var(--bad);stroke-dasharray:4 4}
.axis{fill:var(--dim);font-size:11px}.legend{list-style:none;padding:0;margin:8px 0 0;font-size:12.5px}.legend li{margin:2px 0}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:middle}code{font-size:13px}
.replay{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.rp-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px;font-size:13.5px}
.rp-controls label{display:flex;gap:6px;align-items:center;color:var(--dim)}
select,button{font:inherit;font-size:13.5px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:5px 9px;max-width:100%}
button{cursor:pointer;font-weight:600;min-width:76px}button:hover{border-color:var(--fg)}
#rp-time{font-variant-numeric:tabular-nums;color:var(--dim);margin-left:auto}
#rp-scene{background:linear-gradient(var(--sky),var(--bg));border-radius:8px}
#rp-timeline{margin-top:6px;cursor:pointer}
.flame{fill:var(--c4)}.think rect{fill:var(--fg);opacity:.85}.think text{fill:var(--bg);font-size:11px;font-weight:600}
.tl-bg{fill:var(--line);opacity:.5}.tl-think{fill:var(--c4)}.tl-tick{stroke:var(--fg);stroke-width:.6;opacity:.5}.playhead{stroke:var(--fg);stroke-width:1.5}
.rp-panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:14px;margin-top:12px}
.rp-panel{border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13px}
.rp-panel h3{margin:0 0 4px;font-size:14px}.status{margin:0 0 8px;min-height:2.6em}
.kvs{display:grid;grid-template-columns:1fr 1fr;gap:2px 14px}.kv{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dashed var(--line);padding:2px 0}
.kv span:first-child{color:var(--dim)}.kv span:last-child{font-variant-numeric:tabular-nums;text-align:right}
.note{font-style:italic;margin:8px 0;color:var(--fg)}
.log{list-style:none;padding:0;margin:8px 0 0;max-height:190px;overflow-y:auto;border-top:1px solid var(--line);font-size:12px}
.log li{display:grid;grid-template-columns:52px 50px 98px 1fr;gap:6px;padding:3px 4px;cursor:pointer;border-bottom:1px solid var(--line)}
.log li span:nth-child(2){color:var(--warn)}.log li span:last-child{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.log li.cur{background:var(--line)}.log li.invalid span:last-child{color:var(--bad)}
@media (max-width:640px){.kvs{grid-template-columns:1fr}.log li{grid-template-columns:46px 44px 1fr}.log li span:last-child{display:none}}
</style></head><body><main>
<h1>Lander bench</h1>
<p class="dim">${all.length} episodes from ${runDirs.length} run folder(s). Generated ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC.</p>
<p>Each agent lands a 2D lander in gusty wind. In the <b>paused</b> clock the world waits while the model thinks. In the <b>tokens</b> clock every output token costs sim time while the previous command keeps running. The gap between the two is the <b>thinking tax</b>. The <b>twist</b> set silently weakens the main engine mid-descent. Prediction error on vertical speed, before and after, shows whether the model noticed.</p>
<h2>Replay</h2>
<p class="dim">Pick a flight, plus a second flight on the same scenario to compare. By default you get the same model with the world paused versus moving. Amber on the timeline is time the model spent thinking while its old command kept running. Click the timeline or a log row to jump.</p>
<div class="replay">
  <div class="rp-controls">
    <label>Flight A <select id="rp-a"></select></label>
    <label>vs B <select id="rp-b"></select></label>
    <button id="rp-play" type="button">Play</button>
    <label>Speed <select id="rp-speed"><option value="1">1×</option><option value="2">2×</option><option value="4" selected>4×</option><option value="8">8×</option></select></label>
    <span id="rp-time"></span>
  </div>
  <svg id="rp-scene" role="img" aria-label="Lander replay"></svg>
  <svg id="rp-timeline" role="img" aria-label="Thinking timeline"></svg>
  <div class="rp-panels"><div class="rp-panel" id="rp-panel-0"></div><div class="rp-panel" id="rp-panel-1"></div></div>
</div>
<h2>Scoreboard</h2><div class="scroll">${scoreboard(rows)}</div>
<h2>Thinking tax</h2><div class="scroll">${thinkingTax(rows)}</div>
<h2>Trajectories</h2><p class="dim">Filled end marker = safe landing, hollow = crash, miss or timeout. Green bar = pad.</p>
<div class="grid">${plots}</div>
</main>
<script id="replay-data" type="application/json">${replayJson}</script>
<script>${replayClient}</script>
</body></html>`;

const out = resolve(root, "report.html");
writeFileSync(out, html);
console.log(out);
