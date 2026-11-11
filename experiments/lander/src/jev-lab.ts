#!/usr/bin/env bun
/**
 * Jev lab: try interface variants on Jev to learn what makes the benchmark
 * fairer to judgement-style models. Not a scored benchmark run.
 *
 * Every variant is tagged `fairForAll`: true when the same change could be given
 * identically to every pilot (a candidate for the next protocol), false when it
 * is tailored to Jev (diagnostic only).
 *
 *   bun experiments/lander/src/jev-lab.ts                   # all variants
 *   bun experiments/lander/src/jev-lab.ts --only v2,goal    # some
 *   bun experiments/lander/src/jev-lab.ts --seeds 1-5 --set standard,twist
 */
import { parseArgs } from "node:util";
import { JsonlWriter, clamp, makeRunId, mean, parseSeeds, pool, resultsDir, round, splitList, writeJson } from "@bench/core";
import { type ChoiceAnswer, type Options, callJev } from "./agents/jev.ts";
import { runEpisode } from "./episode.ts";
import { LATERAL_LEVELS, MAIN_LEVELS, QUESTIONS, buildObservation } from "./protocol.ts";
import { type ScenarioSet, makeScenario } from "./scenario.ts";
import type { Control } from "./sim.ts";
import type { Agent, ClockConfig, Decision, DecisionContext } from "./types.ts";

const MODEL = "jev-1.13.0";
const KEY = process.env.JEV_API_KEY ?? "";

interface Built {
  state: unknown;
  questions: Record<string, unknown>;
  decode: (answers: Record<string, ChoiceAnswer>) => Control | null;
}
interface Variant {
  id: string;
  desc: string;
  fairForAll: boolean;
  build: (ctx: DecisionContext) => Built;
}

// ---------- building blocks ----------

const key = (prefix: string, v: number) => `${prefix}_${String(v).replace("-", "neg").replace(".", "_")}`;
const bareMenu = (prefix: string, levels: readonly number[]): Options =>
  Object.fromEntries(levels.map((v) => [key(prefix, v), { value: v, text: String(v) }]));

/** Main options labelled with their physical effect, derived from the vehicle spec every pilot already gets. */
function physicsMainMenu(ctx: DecisionContext): Options {
  const { gravity: g, mainAccelMax: a } = ctx.spec;
  return Object.fromEntries(
    MAIN_LEVELS.map((v) => {
      const net = round(v * a - g, 1);
      const text =
        v === 0
          ? "0 — engine off: free fall, descent speeds up by " + round(g, 1) + " m/s every second"
          : Math.abs(net) < 0.25
            ? `${v} — about hover: vertical speed stays roughly the same`
            : net < 0
              ? `${v} — weaker than gravity: descent speeds up by ${-net} m/s every second`
              : `${v} — stronger than gravity: descent slows (or climb speeds up) by ${net} m/s every second`;
      return [key("main", v), { value: v, text }];
    }),
  );
}
function simpleMainMenu(): Options {
  const tag: Record<number, string> = { 0: "engine off", 0.5: "about hover", 1: "full upward thrust" };
  return Object.fromEntries(MAIN_LEVELS.map((v) => [key("main", v), { value: v, text: tag[v] ? `${v} — ${tag[v]}` : String(v) }]));
}
function labelledLateralMenu(): Options {
  const txt = (v: number) =>
    v === 0 ? "0 — no sideways thrust" : `${v} — ${Math.abs(v) === 1 ? "full" : Math.abs(v) >= 0.5 ? "medium" : "gentle"} push ${v < 0 ? "left (towards negative offset)" : "right (towards positive offset)"}`;
  return Object.fromEntries(LATERAL_LEVELS.map((v) => [key("lateral", v), { value: v, text: txt(v) }]));
}

const RELATIVE_MAIN: Record<string, { delta: number; text: string }> = {
  much_less: { delta: -0.3, text: "Reduce the main throttle a lot (by 0.3)" },
  less: { delta: -0.1, text: "Reduce the main throttle a little (by 0.1)" },
  hold: { delta: 0, text: "Keep the main throttle as it is" },
  more: { delta: 0.1, text: "Increase the main throttle a little (by 0.1)" },
  much_more: { delta: 0.3, text: "Increase the main throttle a lot (by 0.3)" },
};
const RELATIVE_LATERAL: Record<string, { delta: number; text: string }> = {
  left_more: { delta: -0.25, text: "Shift lateral thrust towards pushing left (by 0.25)" },
  hold: { delta: 0, text: "Keep the lateral thrust as it is" },
  right_more: { delta: 0.25, text: "Shift lateral thrust towards pushing right (by 0.25)" },
};

const crit = (o: Record<string, { text: string }>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.text]));
const pick = (a: ChoiceAnswer | undefined, o: Options) => (a && o[a.choice] ? (o[a.choice] as { value: number }).value : null);

const GOAL_MAIN = "Choose the main engine throttle to command now, to land softly on the pad.";
const GOAL_LATERAL = "Choose the lateral thrust to command now, to land on the pad.";

function absolute(mainQ: string, latQ: string, mainMenu: (ctx: DecisionContext) => Options, latMenu: () => Options) {
  return (ctx: DecisionContext): Built => {
    const mm = mainMenu(ctx);
    const lm = latMenu();
    return {
      state: buildObservation(ctx),
      questions: {
        main: { type: "choice", instructions: mainQ, criteria: crit(mm) },
        lateral: { type: "choice", instructions: latQ, criteria: crit(lm) },
      },
      decode: (a) => {
        const main = pick(a.main, mm);
        const lateral = pick(a.lateral, lm);
        return main === null || lateral === null ? null : { main, lateral };
      },
    };
  };
}

function relative(mainQ: string, latQ: string, lateralMode: "relative" | "absolute-labelled") {
  return (ctx: DecisionContext): Built => {
    const cur = ctx.obs.command;
    const lm = labelledLateralMenu();
    return {
      state: buildObservation(ctx),
      questions: {
        main: { type: "choice", instructions: mainQ, criteria: crit(RELATIVE_MAIN) },
        lateral:
          lateralMode === "relative"
            ? { type: "choice", instructions: latQ, criteria: crit(RELATIVE_LATERAL) }
            : { type: "choice", instructions: GOAL_LATERAL, criteria: crit(lm) },
      },
      decode: (a) => {
        const dm = a.main && RELATIVE_MAIN[a.main.choice];
        if (!dm) return null;
        const main = clamp(cur.main + dm.delta, 0, 1);
        if (lateralMode === "relative") {
          const dl = a.lateral && RELATIVE_LATERAL[a.lateral.choice];
          if (!dl) return null;
          return { main, lateral: clamp(cur.lateral + dl.delta, -1, 1) };
        }
        const lateral = pick(a.lateral, lm);
        return lateral === null ? null : { main, lateral };
      },
    };
  };
}

/**
 * Autopilot interface: the pilot chooses target vertical and horizontal speeds and a fixed
 * autopilot (the same proportional law as the P baseline, at the same 1 s command rate)
 * converts them to throttle and lateral thrust. Fair to every pilot if every pilot gets it,
 * but it changes the task from flying the stick to managing the descent.
 */
const VS_TARGETS = [-20, -15, -10, -6, -3, -1.5, -0.5, 0, 2];
const VX_TARGETS = [-6, -3, -1.5, -0.5, 0, 0.5, 1.5, 3, 6];
function autopilot(labelled: boolean) {
  return (ctx: DecisionContext): Built => {
    const vsMenu: Options = Object.fromEntries(
      VS_TARGETS.map((v) => [key("vs", v), { value: v, text: labelled ? (v < 0 ? `descend at ${-v} m/s` : v === 0 ? "hold altitude (0 m/s)" : `climb at ${v} m/s`) : String(v) }]),
    );
    const vxMenu: Options = Object.fromEntries(
      VX_TARGETS.map((v) => [key("vx", v), { value: v, text: labelled ? (v < 0 ? `move left at ${-v} m/s` : v === 0 ? "no sideways motion (0 m/s)" : `move right at ${v} m/s`) : String(v) }]),
    );
    const obs = buildObservation(ctx);
    const state = {
      ...obs,
      controls: {
        target_vertical_speed_mps: { question: "Choose the target vertical speed for the autopilot now, to land softly on the pad.", options: VS_TARGETS },
        target_horizontal_speed_mps: { question: "Choose the target horizontal speed for the autopilot now, to land on the pad.", options: VX_TARGETS },
        autopilot: "an autopilot sets the throttle and lateral thrust each second to reach the chosen speeds (wind included); you choose the speeds",
      },
    };
    return {
      state,
      questions: {
        main: { type: "choice", instructions: state.controls.target_vertical_speed_mps.question, criteria: crit(vsMenu) },
        lateral: { type: "choice", instructions: state.controls.target_horizontal_speed_mps.question, criteria: crit(vxMenu) },
      },
      decode: (a) => {
        const vyT = pick(a.main, vsMenu);
        const vxT = pick(a.lateral, vxMenu);
        if (vyT === null || vxT === null) return null;
        const o = ctx.obs, s = ctx.spec;
        return {
          main: clamp((s.gravity + 0.8 * (vyT - o.vy)) / s.mainAccelMax, 0, 1),
          lateral: clamp((0.8 * (vxT - o.vx) - o.windEstimate) / s.lateralAccelMax, -1, 1),
        };
      },
    };
  };
}

/**
 * Yes/no trim: each axis is two yes/no questions ("should it be increased now?",
 * "should it be reduced now?"). A clear yes (and not the opposite) moves the command one
 * step. Any pilot can answer the same questions; the step rule is fixed and public.
 */
function yesNoTrim(step: number) {
  return (ctx: DecisionContext): Built => {
    const cur = ctx.obs.command;
    const q = (text: string) => ({ type: "noul", instructions: text });
    return {
      state: buildObservation(ctx),
      questions: {
        main_up: q("Should the main engine throttle be increased now, to land softly on the pad?"),
        main_down: q("Should the main engine throttle be reduced now, to land softly on the pad?"),
        lat_right: q("Should the lateral thrust be shifted towards pushing right now, to land on the pad?"),
        lat_left: q("Should the lateral thrust be shifted towards pushing left now, to land on the pad?"),
      },
      decode: (a) => {
        const p = (k: string) => (a[k] as unknown as { noul?: number } | undefined)?.noul;
        const [up, down, right, left] = [p("main_up"), p("main_down"), p("lat_right"), p("lat_left")];
        if ([up, down, right, left].some((x) => typeof x !== "number")) return null;
        const move = (yes: number, no: number) => (yes > 0.5 && yes > no ? 1 : no > 0.5 && no > yes ? -1 : 0);
        return {
          main: clamp(cur.main + step * move(up as number, down as number), 0, 1),
          lateral: clamp(cur.lateral + 0.25 * move(right as number, left as number), -1, 1),
        };
      },
    };
  };
}

const VARIANTS: Variant[] = [
  { id: "yesno-trim", desc: "Yes/no: increase? reduce? for each axis; a clear yes moves the command one step (main 0.2, lateral 0.25)", fairForAll: true, build: yesNoTrim(0.2) },
  { id: "autopilot", desc: "Choose target vertical/horizontal speeds (bare numbers); a fixed autopilot flies them", fairForAll: true, build: autopilot(false) },
  { id: "autopilot+labels", desc: "Autopilot targets with plain-language labels (descend at 6 m/s, move left at 3 m/s)", fairForAll: true, build: autopilot(true) },
  { id: "v2", desc: "Protocol v2 as run: bare-number menus, neutral questions", fairForAll: true, build: absolute(QUESTIONS.main, QUESTIONS.lateral, () => bareMenu("main", MAIN_LEVELS), () => bareMenu("lateral", LATERAL_LEVELS)) },
  { id: "goal", desc: "Goal named in both questions", fairForAll: true, build: absolute(GOAL_MAIN, GOAL_LATERAL, () => bareMenu("main", MAIN_LEVELS), () => bareMenu("lateral", LATERAL_LEVELS)) },
  { id: "labels", desc: "Short meanings on key options (engine off / hover / full; push left/right)", fairForAll: true, build: absolute(QUESTIONS.main, QUESTIONS.lateral, simpleMainMenu, labelledLateralMenu) },
  { id: "goal+labels", desc: "Goal in questions + short option meanings", fairForAll: true, build: absolute(GOAL_MAIN, GOAL_LATERAL, simpleMainMenu, labelledLateralMenu) },
  { id: "goal+physics", desc: "Goal in questions + every throttle option labelled with its effect on vertical speed", fairForAll: true, build: absolute(GOAL_MAIN, GOAL_LATERAL, physicsMainMenu, labelledLateralMenu) },
  {
    id: "relative",
    desc: "Trim controls for both axes: less / hold / more, applied to the current command",
    fairForAll: true,
    build: relative("How should the main engine throttle change now, to land softly on the pad?", "How should the lateral thrust change now, to land on the pad?", "relative"),
  },
  {
    id: "relative-main",
    desc: "Trim control for main (less / hold / more) + labelled absolute lateral",
    fairForAll: true,
    build: relative("How should the main engine throttle change now, to land softly on the pad?", "", "absolute-labelled"),
  },
];

// ---------- runner ----------

class LabAgent implements Agent {
  readonly consumesTime = true;
  readonly name: string;
  constructor(private readonly v: Variant) {
    this.name = `${MODEL}~${v.id}`;
  }
  async decide(ctx: DecisionContext): Promise<Decision> {
    const hold = { ...ctx.obs.command };
    const b = this.v.build(ctx);
    const res = await callJev(MODEL, KEY, b.state, b.questions);
    if ("error" in res) return { control: hold, valid: false, infraError: res.error };
    const answers = (res.json.answers ?? {}) as Record<string, ChoiceAnswer>;
    const control = b.decode(answers);
    if (!control) return { control: hold, valid: false, parseError: "unusable answers", usage: res.usage, latencyMs: res.latencyMs };
    const note = Object.entries(answers)
      .map(([k, a]) => ("noul" in (a as object) ? `${k}: ${Math.round(((a as unknown as { noul: number }).noul) * 100)}%` : `${k}: ${a.choice} (${Math.round(a.confidence * 100)}%)`))
      .join(", ");
    return { control, valid: true, note, usage: res.usage, latencyMs: res.latencyMs };
  }
}

if (import.meta.main) {
  if (!KEY) throw new Error("JEV_API_KEY is required");
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      seeds: { type: "string", default: "1-5" },
      set: { type: "string", default: "standard" },
      clock: { type: "string", default: "paused,tokens" },
      concurrency: { type: "string", default: "10" },
    },
  });
  const only = splitList(values.only);
  const variants = only.length ? VARIANTS.filter((v) => only.includes(v.id)) : VARIANTS;
  const seeds = parseSeeds(values.seeds);
  const sets = splitList(values.set) as ScenarioSet[];
  const clocks: ClockConfig[] = splitList(values.clock).map((mode) => ({ mode: mode as ClockConfig["mode"], holdSeconds: 1, msPerToken: 10, wallScale: 1 }));
  const runId = makeRunId("jev-lab");
  const dir = resultsDir("lander", runId);
  const out = new JsonlWriter(`${dir}/episodes.jsonl`);
  const jobs = variants.flatMap((v) => clocks.flatMap((c) => sets.flatMap((s) => seeds.map((seed) => ({ v, c, s, seed })))));
  const results = await pool(
    jobs.map((j) => async () => {
      const r = await runEpisode(makeScenario(j.s, j.seed), new LabAgent(j.v), j.c);
      out.write({ ...r, variant: j.v.id });
      return { j, r };
    }),
    Number(values.concurrency),
  );
  console.log(`\n${"variant".padEnd(15)} ${"fair".padEnd(5)} ${"clock".padEnd(7)} ${"set".padEnd(9)} score  landed  crash  tok/dec  mean-main  invalid`);
  const rows = [];
  for (const v of variants)
    for (const c of clocks)
      for (const s of sets) {
        const rs = results.filter((x) => x.j.v === v && x.j.c === c && x.j.s === s && !x.r.infraError).map((x) => x.r);
        if (!rs.length) continue;
        const dec = rs.flatMap((r) => r.decisions);
        const row = {
          variant: v.id,
          fairForAll: v.fairForAll,
          clock: c.mode,
          set: s,
          n: rs.length,
          score: round(mean(rs.map((r) => r.outcome.score)), 1),
          landed: rs.filter((r) => r.outcome.kind === "landed").length,
          tpd: Math.round(mean(dec.map((d) => d.outputTokens))),
          meanMain: round(mean(dec.map((d) => d.control.main)), 2),
          invalid: dec.filter((d) => !d.valid).length,
        };
        rows.push(row);
        console.log(
          `${v.id.padEnd(15)} ${String(v.fairForAll).padEnd(5)} ${c.mode.padEnd(7)} ${s.padEnd(9)} ${String(row.score).padStart(5)}  ${`${row.landed}/${row.n}`.padStart(6)}  ${String(row.n - row.landed).padStart(5)}  ${String(row.tpd).padStart(7)}  ${String(row.meanMain).padStart(9)}  ${String(row.invalid).padStart(7)}`,
        );
      }
  writeJson(`${dir}/summary.json`, { runId, variants: variants.map(({ id, desc, fairForAll }) => ({ id, desc, fairForAll })), rows });
  console.log(`\n${dir}`);
}
