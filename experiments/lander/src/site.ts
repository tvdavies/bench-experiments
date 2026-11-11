#!/usr/bin/env bun
/**
 * Build the standalone Lander Bench site: one self-contained index.html with
 * the flight data inlined, so it can be hosted anywhere (myslop apps, a file
 * host, GitHub Pages) or opened locally.
 *
 *   bun run lander:site                       # every results/lander/*-v1-* run
 *   bun run lander:site --runs a,b            # specific run folders
 *   bun run lander:site --match v2            # run folders containing "-v2-"
 *
 * Output: results/lander/site/public/index.html
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT, round, splitList } from "@bench/core";
import type { EpisodeResult } from "./episode.ts";

const { values } = parseArgs({
  options: {
    runs: { type: "string" },
    match: { type: "string", default: "v2" },
    out: { type: "string" },
  },
});

/** Display names and providers. Unknown ids fall back to the raw id. */
/** `side: true` = shown separately as a side experiment, never ranked against protocol pilots. */
const MODEL_META: Record<string, { label: string; provider: string; side?: boolean }> = {
  "claude-opus-5-5": { label: "Opus 5.5", provider: "Anthropic" },
  "claude-sonnet-5-5": { label: "Sonnet 5.5", provider: "Anthropic" },
  "claude-haiku-5-5": { label: "Haiku 5.5", provider: "Anthropic" },
  "claude-fable-5-1": { label: "Fable 5.1", provider: "Anthropic" },
  "claude-fable-5-2": { label: "Fable 5.2", provider: "Anthropic" },
  "gpt-6.1-sol": { label: "GPT-6.1 Sol", provider: "OpenAI" },
  "gpt-6.1-terra": { label: "GPT-6.1 Terra", provider: "OpenAI" },
  "gpt-6-luna": { label: "GPT-6 Luna", provider: "OpenAI" },
  "grok-4.7": { label: "Grok 4.7", provider: "xAI" },
  "jev-1.13.0": { label: "Jev 1.13", provider: "Typesafe" },
  "jev-1.13.0+assess": { label: "Jev 1.13 · assessment framing", provider: "Typesafe", side: true },
  "muse-wonder-1.0": { label: "Muse Wonder 1.0", provider: "Meta" },
  "muse-wonder-full-1.0": { label: "Muse Wonder Full 1.0", provider: "Meta" },
  "baseline:pi": { label: "PI controller", provider: "Baseline" },
  "baseline:p": { label: "P controller", provider: "Baseline" },
  "baseline:noop": { label: "Do nothing", provider: "Baseline" },
};
const PROVIDER_ORDER = ["Anthropic", "OpenAI", "xAI", "Meta", "Typesafe", "Baseline"];
const SITE_SETS = new Set(["standard", "twist"]);

const root = resolve(REPO_ROOT, "results", "lander");
const dirs = values.runs
  ? splitList(values.runs).map((r) => resolve(root, r))
  : readdirSync(root)
      .filter((d) => d.includes(`-${values.match}-`) && !d.endsWith("-smoke"))
      .sort()
      .map((d) => resolve(root, d));

const latest = new Map<string, EpisodeResult>();
let dropped = 0;
for (const dir of dirs) {
  const file = resolve(dir, "episodes.jsonl");
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as EpisodeResult;
    if (e.infraError) {
      dropped++;
      continue;
    }
    if (!SITE_SETS.has(e.scenario.set)) continue;
    latest.set(`${e.agent}|${e.clock.mode}|${e.scenario.id}`, e);
  }
}
const episodes = [...latest.values()];
if (episodes.length === 0) {
  console.error(`No episodes found in ${dirs.length} run folder(s).`);
  process.exit(1);
}

const modelIds = [...new Set(episodes.map((e) => e.agent))].sort((a, b) => {
  const pa = PROVIDER_ORDER.indexOf(MODEL_META[a]?.provider ?? "zzz");
  const pb = PROVIDER_ORDER.indexOf(MODEL_META[b]?.provider ?? "zzz");
  return pa - pb || Object.keys(MODEL_META).indexOf(a) - Object.keys(MODEL_META).indexOf(b) || a.localeCompare(b);
});
const scenarioIds = [...new Set(episodes.map((e) => e.scenario.id))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const scenarioById = new Map(episodes.map((e) => [e.scenario.id, e.scenario]));

const r1 = (n: number) => round(n, 1);
const r2 = (n: number) => round(n, 2);

const data = {
  generated: new Date().toISOString(),
  protocol: "v2",
  msPerToken: episodes.find((e) => e.clock.mode === "tokens")?.clock.msPerToken ?? 10,
  hold: episodes[0]?.clock.holdSeconds ?? 1,
  providers: PROVIDER_ORDER.filter((p) => modelIds.some((m) => (MODEL_META[m]?.provider ?? "Other") === p)),
  models: modelIds.map((id) => ({
    id,
    label: MODEL_META[id]?.label ?? id,
    provider: MODEL_META[id]?.provider ?? "Other",
    baseline: id.startsWith("baseline:"),
    side: MODEL_META[id]?.side ?? false,
  })),
  scenarios: scenarioIds.map((id) => {
    const s = scenarioById.get(id)!;
    return {
      id,
      set: s.set,
      seed: s.seed,
      g: s.gravity,
      x0: s.start.x,
      y0: s.start.y,
      pad: s.padHalfWidth,
      wind: s.wind.mean,
      twistAlt: s.twist?.belowAltitude ?? null,
    };
  }),
  flights: episodes.map((e) => {
    const m = e.metrics;
    const td = e.outcome.touchdown;
    return {
      m: modelIds.indexOf(e.agent),
      s: scenarioIds.indexOf(e.scenario.id),
      c: e.clock.mode,
      k: e.outcome.kind,
      sc: e.outcome.score,
      td: td ? [r2(td.vy), r2(td.vx), r1(td.dx)] : null,
      n: m.decisions,
      inv: m.invalidDecisions,
      th: m.thinkingShare,
      tpd: m.decisions ? Math.round(m.outputTokens / m.decisions) : 0,
      md: m.meanDelaySeconds,
      vmae: m.verticalSpeedMae,
      ff: e.outcome.fuelFraction,
      T: e.outcome.simTime,
      tw: e.outcome.twistTriggeredAt,
      // [t, x, y, vy, main, lateral, fuel] every 0.5 s
      traj: e.trajectory
        .filter((_, i, a) => i % 2 === 0 || i === a.length - 1)
        .map((p) => [p[0], r1(p[1]), r1(p[2]), r1(p[4]), r2(p[5]), r2(p[6]), r1(p[7] ?? 0)]),
      // [t, delay, tokens, main, lateral, valid, predAlt, predVy, actAlt, actVy, note]
      dec: e.decisions.map((d) => [
        d.obs.t,
        d.delaySeconds,
        d.outputTokens,
        r2(d.control.main),
        r2(d.control.lateral),
        d.valid ? 1 : 0,
        d.prediction?.altitude5s ?? null,
        d.prediction?.verticalSpeed5s ?? null,
        d.actual5s?.altitude ?? null,
        d.actual5s?.verticalSpeed ?? null,
        (d.note ?? (d.valid ? "" : (d.parseError ?? "invalid output"))).slice(0, 160),
      ]),
    };
  }),
};

const siteDir = resolve(import.meta.dir, "..", "site");
const template = readFileSync(resolve(siteDir, "index.html"), "utf8");
const json = JSON.stringify(data).replace(/</g, "\\u003c");
const html = template
  .replace("/*__STYLES__*/", () => readFileSync(resolve(siteDir, "styles.css"), "utf8"))
  .replace("/*__APP__*/", () => readFileSync(resolve(siteDir, "app.js"), "utf8"))
  .replace("__DATA__", () => json);

const outDir = values.out ? resolve(values.out) : resolve(root, "site", "public");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "index.html"), html);
console.log(
  `${episodes.length} flights, ${modelIds.length} agents, ${scenarioIds.length} scenarios` +
    (dropped ? `, ${dropped} infra-error episodes dropped` : "") +
    ` -> ${resolve(outDir, "index.html")} (${Math.round(html.length / 1024)} KB)`,
);
