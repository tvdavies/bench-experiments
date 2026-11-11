import { describe, expect, test } from "bun:test";
import { parseSeeds } from "@bench/core";
import { ControllerAgent, NoopAgent } from "../src/agents/baselines.ts";
import { parseControl, telemetryMessage } from "../src/agents/llm.ts";
import { runEpisode } from "../src/episode.ts";
import { makeScenario } from "../src/scenario.ts";
import { LanderSim, publicSpec, scoreTouchdown } from "../src/sim.ts";
import type { Agent, ClockConfig, Decision } from "../src/types.ts";

const paused: ClockConfig = { mode: "paused", holdSeconds: 1, msPerToken: 10, wallScale: 1 };
const tokens: ClockConfig = { ...paused, mode: "tokens" };

/** Scripted "LLM" that spends a fixed number of tokens per decision, then flies like the PI controller. */
class SlowThinker implements Agent {
  readonly name = "test:slow";
  readonly consumesTime = true;
  private readonly inner = new ControllerAgent("pi");
  constructor(private readonly tokensPerDecision: number) {}
  async decide(ctx: Parameters<Agent["decide"]>[0]): Promise<Decision> {
    const d = await this.inner.decide(ctx);
    return { ...d, usage: { inputTokens: 0, outputTokens: this.tokensPerDecision, reasoningTokens: 0 } };
  }
}

describe("sim", () => {
  test("same seed gives the same wind in every set except calm", () => {
    const a = new LanderSim(makeScenario("standard", 7));
    const b = new LanderSim(makeScenario("twist", 7));
    a.advance(30);
    b.advance(30);
    expect(a.log.map((s) => s.wind)).toEqual(b.log.map((s) => s.wind));
    expect(makeScenario("calm", 7).start).toEqual(makeScenario("standard", 7).start);
  });

  test("starts at hover throttle and holds altitude rate without wind", () => {
    const sim = new LanderSim(makeScenario("calm", 3));
    const vy0 = sim.vy;
    sim.advance(5);
    expect(sim.vy).toBeCloseTo(vy0, 5);
  });

  test("observations are deterministic for a given tick", () => {
    const s = makeScenario("standard", 2);
    const a = new LanderSim(s);
    const b = new LanderSim(s);
    a.advance(3);
    b.advance(3);
    expect(a.observe()).toEqual(b.observe());
  });

  test("engine twist triggers below its altitude", () => {
    const s = makeScenario("twist", 4);
    const sim = new LanderSim(s);
    sim.setControl({ main: 0, lateral: 0 });
    while (!sim.done) sim.advance(1);
    expect(sim.twistTriggeredAt).not.toBeNull();
    expect(sim.stateAt(sim.twistTriggeredAt as number)?.engineFactor).toBe(1);
  });

  test("scoring", () => {
    expect(scoreTouchdown({ t: 1, dx: 0, vx: 0, vy: -1 }, 1, 15)).toEqual({ kind: "landed", score: 100 });
    expect(scoreTouchdown({ t: 1, dx: 30, vx: 0, vy: -1 }, 1, 15).kind).toBe("missed-pad");
    const hard = scoreTouchdown({ t: 1, dx: 0, vx: 0, vy: -3 }, 1, 15);
    const harder = scoreTouchdown({ t: 1, dx: 0, vx: 0, vy: -10 }, 1, 15);
    expect(hard.kind).toBe("crashed");
    expect(hard.score).toBeGreaterThan(harder.score);
    expect(hard.score).toBeLessThan(50);
  });
});

describe("episodes", () => {
  test("PI baseline lands every calm and standard seed", async () => {
    for (const set of ["calm", "standard"] as const) {
      for (let seed = 1; seed <= 10; seed++) {
        const r = await runEpisode(makeScenario(set, seed), new ControllerAgent("pi"), paused);
        expect(r.outcome.kind).toBe("landed");
      }
    }
  });

  test("noop crashes", async () => {
    const r = await runEpisode(makeScenario("standard", 1), new NoopAgent(), paused);
    expect(r.outcome.kind).toBe("crashed");
  });

  test("token clock charges sim time per output token", async () => {
    const r = await runEpisode(makeScenario("calm", 1), new SlowThinker(150), tokens);
    const first = r.decisions[0];
    expect(first?.requestedDelaySeconds).toBeCloseTo(1.5, 5);
    expect(first?.delaySeconds).toBeCloseTo(1.5, 5);
    expect(r.metrics.thinkingShare).toBeGreaterThan(0.5);
  });

  test("paused clock ignores tokens", async () => {
    const r = await runEpisode(makeScenario("calm", 1), new SlowThinker(150), paused);
    expect(r.metrics.thinkingShare).toBe(0);
    expect(r.outcome.kind).toBe("landed");
  });

  test("thinking slower hurts on the same scenarios", async () => {
    let fast = 0;
    let slow = 0;
    for (let seed = 1; seed <= 8; seed++) {
      fast += (await runEpisode(makeScenario("standard", seed), new SlowThinker(20), tokens)).outcome.score;
      slow += (await runEpisode(makeScenario("standard", seed), new SlowThinker(1500), tokens)).outcome.score;
    }
    expect(fast).toBeGreaterThan(slow);
  });

  test("infra errors abort the episode instead of scoring it", async () => {
    const broken: Agent = {
      name: "test:broken",
      consumesTime: true,
      decide: async ({ obs }) => ({ control: obs.command, valid: false, infraError: "HTTP 503" }),
    };
    const r = await runEpisode(makeScenario("standard", 1), broken, tokens);
    expect(r.infraError).toBe("HTTP 503");
  });
});

describe("llm agent helpers", () => {
  test("parses tool args or JSON in text", () => {
    expect(parseControl({ main: 0.5, lateral: 0 }, "")).toEqual({ main: 0.5, lateral: 0 });
    expect(parseControl(null, 'ok {"main": 0.4, "lateral": -0.2} done')).toEqual({ main: 0.4, lateral: -0.2 });
    expect(parseControl(null, "no json")).toBeNull();
  });

  test("telemetry mentions thinking cost only on live clocks", () => {
    const s = makeScenario("standard", 1);
    const obs = new LanderSim(s).observe();
    const base = { spec: publicSpec(s), obs, recent: [], lastDecision: { outputTokens: 300, delaySeconds: 3 } };
    expect(telemetryMessage({ ...base, clock: tokens })).toContain("300 output tokens");
    expect(telemetryMessage({ ...base, clock: paused })).not.toContain("output tokens");
  });
});

test("parseSeeds", () => {
  expect(parseSeeds("1-3,7")).toEqual([1, 2, 3, 7]);
});
