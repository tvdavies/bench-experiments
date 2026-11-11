#!/usr/bin/env bun
/**
 * Run a matrix of agents x clocks x scenario sets x seeds.
 *
 *   bun run lander --model claude-haiku-5-5 --clock paused,tokens --set standard --seeds 1-5
 *   bun run lander --baseline p,pi,noop --set calm,standard,twist --seeds 1-20
 */
import { parseArgs } from "node:util";
import { JsonlWriter, makeRunId, parseSeeds, pool, resolveModelConfig, resultsDir, round, splitList, writeJson } from "@bench/core";
import { ControllerAgent, NoopAgent } from "./agents/baselines.ts";
import { JevAgent } from "./agents/jev.ts";
import { LlmAgent } from "./agents/llm.ts";
import { type EpisodeResult, runEpisode } from "./episode.ts";
import { SCENARIO_SETS, type ScenarioSet, isScenarioSet, makeScenario } from "./scenario.ts";
import { formatTable, summarise } from "./summary.ts";
import type { Agent, ClockConfig, ClockMode } from "./types.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    baseline: { type: "string" },
    clock: { type: "string", default: "paused,tokens" },
    set: { type: "string", default: "standard" },
    seeds: { type: "string", default: "1-5" },
    hold: { type: "string", default: "1" },
    "ms-per-token": { type: "string", default: "10" },
    "wall-scale": { type: "string", default: "1" },
    "reasoning-effort": { type: "string" },
    "max-tokens": { type: "string", default: "8000" },
    concurrency: { type: "string", default: "4" },
    label: { type: "string" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || (!values.model && !values.baseline)) {
  console.log(`Usage: bun run lander [--model a,b] [--baseline p,pi,noop] [options]

  --model             Comma-separated model ids for the OpenAI-compatible endpoint (BENCH_BASE_URL)
  --baseline          Scripted agents: p, pi, noop
  --clock             paused,tokens,wall            (default: paused,tokens)
  --set               ${SCENARIO_SETS.join(",")}     (default: standard)
  --seeds             e.g. 1-5 or 1,4,9              (default: 1-5)
  --hold              Seconds each command is held   (default: 1)
  --ms-per-token      Token clock rate               (default: 10, i.e. 100 tok/s)
  --wall-scale        Wall clock multiplier          (default: 1)
  --reasoning-effort  Passed through as reasoning_effort
  --max-tokens        Per-decision output cap        (default: 8000)
  --concurrency       Episodes in flight             (default: 4)
  --label             Suffix for the results folder`);
  process.exit(values.help ? 0 : 1);
}

const clocks: ClockConfig[] = splitList(values.clock).map((mode) => {
  if (!["paused", "tokens", "wall"].includes(mode)) throw new Error(`Unknown clock: ${mode}`);
  return {
    mode: mode as ClockMode,
    holdSeconds: Number(values.hold),
    msPerToken: Number(values["ms-per-token"]),
    wallScale: Number(values["wall-scale"]),
  };
});
const sets: ScenarioSet[] = splitList(values.set).map((s) => {
  if (!isScenarioSet(s)) throw new Error(`Unknown set: ${s} (expected ${SCENARIO_SETS.join(", ")})`);
  return s;
});
const seeds = parseSeeds(values.seeds);

type AgentFactory = { name: string; consumesTime: boolean; make: () => Agent };
const factories: AgentFactory[] = [];
for (const id of splitList(values.baseline)) {
  const make = id === "noop" ? () => new NoopAgent() : id === "p" || id === "pi" ? () => new ControllerAgent(id) : null;
  if (!make) throw new Error(`Unknown baseline: ${id}`);
  factories.push({ name: make().name, consumesTime: false, make });
}
for (const model of splitList(values.model)) {
  if (model.startsWith("jev-")) {
    // Typesafe's structured-question API, not chat completions. See agents/jev.ts.
    const make = () => new JevAgent(model);
    factories.push({ name: model, consumesTime: true, make });
    continue;
  }
  const config = resolveModelConfig({
    model,
    maxTokens: Number(values["max-tokens"]),
    ...(values["reasoning-effort"] && { reasoningEffort: values["reasoning-effort"] }),
  });
  const make = () => new LlmAgent(config);
  factories.push({ name: make().name, consumesTime: true, make });
}

interface Job {
  factory: AgentFactory;
  clock: ClockConfig;
  set: ScenarioSet;
  seed: number;
}
const jobs: Job[] = [];
for (const factory of factories) {
  // Scripted baselines think instantly, so every clock gives the same result: run them once.
  const agentClocks = factory.consumesTime ? clocks : [{ ...(clocks[0] as ClockConfig), mode: "paused" as const }];
  for (const clock of agentClocks) for (const set of sets) for (const seed of seeds) jobs.push({ factory, clock, set, seed });
}

const runId = makeRunId(values.label);
const dir = resultsDir("lander", runId);
const episodesOut = new JsonlWriter(`${dir}/episodes.jsonl`);
writeJson(`${dir}/config.json`, {
  runId,
  agents: factories.map((f) => f.name),
  clocks,
  sets,
  seeds,
  baseUrl: process.env.BENCH_BASE_URL ?? "default",
  startedAt: new Date().toISOString(),
});

console.log(`Run ${runId}: ${jobs.length} episodes -> ${dir}`);
let finished = 0;
const results = await pool(
  jobs.map((job) => async (): Promise<EpisodeResult> => {
    const result = await runEpisode(makeScenario(job.set, job.seed), job.factory.make(), job.clock);
    episodesOut.write(result);
    finished++;
    if (!values.quiet) {
      const o = result.outcome;
      const m = result.metrics;
      console.log(
        `[${finished}/${jobs.length}] ${result.agent} ${job.clock.mode} ${result.scenario.id}: ${o.kind} ${o.score}` +
          (o.touchdown ? ` (vy ${o.touchdown.vy}, vx ${o.touchdown.vx}, dx ${o.touchdown.dx})` : "") +
          ` | ${m.decisions} decisions, thinking ${round(m.thinkingShare * 100, 0)}% of flight, ${m.outputTokens} out tok` +
          (m.invalidDecisions ? `, ${m.invalidDecisions} invalid` : "") +
          (result.infraError ? ` | INFRA ERROR: ${result.infraError.slice(0, 160)}` : ""),
      );
    }
    return result;
  }),
  Number(values.concurrency),
);

const summary = summarise(results);
writeJson(`${dir}/summary.json`, { runId, finishedAt: new Date().toISOString(), rows: summary });
console.log(`\n${formatTable(summary)}\n\nResults: ${dir}`);
