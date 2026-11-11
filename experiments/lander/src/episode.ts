import { mean, round } from "@bench/core";
import { LanderSim, type Control, type Observation, type Outcome, type Scenario, publicSpec } from "./sim.ts";
import type { Agent, ClockConfig, Decision, TelemetryRow } from "./types.ts";

export const RECENT_ROWS = 10;
const MAX_CONSECUTIVE_INFRA_ERRORS = 4;
const PREDICTION_HORIZON = 5;

export interface DecisionRecord {
  index: number;
  obs: Observation;
  control: Control;
  valid: boolean;
  /** Sim seconds that passed between the observation and the command taking effect. */
  delaySeconds: number;
  /** Delay the clock charged; larger than delaySeconds when the flight ended mid-think. */
  requestedDelaySeconds: number;
  /** The command arrived after touchdown or timeout. */
  tooLate: boolean;
  outputTokens: number;
  reasoningTokens: number;
  inputTokens: number;
  latencyMs: number;
  prediction?: Decision["prediction"];
  actual5s?: { altitude: number; verticalSpeed: number };
  note?: string;
  parseError?: string;
  infraError?: string;
}

export interface EpisodeMetrics {
  decisions: number;
  invalidDecisions: number;
  lateDecisions: number;
  meanDelaySeconds: number;
  maxDelaySeconds: number;
  /** Fraction of flight time spent waiting on the agent. */
  thinkingShare: number;
  outputTokens: number;
  reasoningTokens: number;
  inputTokens: number;
  wallSeconds: number;
  predictionCount: number;
  altitudeMae: number | null;
  verticalSpeedMae: number | null;
  /** Vertical-speed prediction error before / after the silent engine twist. */
  verticalSpeedMaeBeforeTwist: number | null;
  verticalSpeedMaeAfterTwist: number | null;
}

export interface EpisodeResult {
  agent: string;
  clock: ClockConfig;
  scenario: Scenario;
  outcome: Outcome;
  metrics: EpisodeMetrics;
  /** Set when the run was aborted by infrastructure failures; exclude from scores. */
  infraError?: string;
  decisions: DecisionRecord[];
  /** True trajectory, sampled every 0.25 s. */
  trajectory: Array<
    [t: number, x: number, y: number, vx: number, vy: number, main: number, lateral: number, fuel: number, wind: number]
  >;
}

export function delayFor(clock: ClockConfig, agent: Agent, d: Decision): number {
  if (!agent.consumesTime || clock.mode === "paused") return 0;
  if (clock.mode === "tokens") return ((d.usage?.outputTokens ?? 0) * clock.msPerToken) / 1000;
  return ((d.latencyMs ?? 0) / 1000) * clock.wallScale;
}

export async function runEpisode(
  scenario: Scenario,
  agent: Agent,
  clock: ClockConfig,
  onDecision?: (record: DecisionRecord, sim: LanderSim) => void,
): Promise<EpisodeResult> {
  const sim = new LanderSim(scenario);
  const spec = publicSpec(scenario);
  const recent: TelemetryRow[] = [];
  const decisions: DecisionRecord[] = [];
  const started = performance.now();
  let lastDecision: { outputTokens: number; delaySeconds: number } | null = null;
  let consecutiveInfra = 0;
  let infraError: string | undefined;

  while (!sim.done) {
    const obs = sim.observe();
    const decision = await agent.decide({ spec, clock, obs, recent: [...recent], lastDecision });

    if (decision.infraError) {
      consecutiveInfra++;
      if (consecutiveInfra >= MAX_CONSECUTIVE_INFRA_ERRORS) {
        infraError = decision.infraError;
        break;
      }
    } else {
      consecutiveInfra = 0;
    }

    // The previous command keeps running while the agent thinks.
    const requestedDelaySeconds = round(delayFor(clock, agent, decision));
    const delaySeconds = sim.advance(requestedDelaySeconds);
    const tooLate = sim.done;
    if (!tooLate) {
      sim.setControl(decision.control);
      sim.advance(clock.holdSeconds);
    }

    const record: DecisionRecord = {
      index: decisions.length,
      obs,
      control: { ...decision.control },
      valid: decision.valid,
      delaySeconds,
      requestedDelaySeconds,
      tooLate,
      outputTokens: decision.usage?.outputTokens ?? 0,
      reasoningTokens: decision.usage?.reasoningTokens ?? 0,
      inputTokens: decision.usage?.inputTokens ?? 0,
      latencyMs: round(decision.latencyMs ?? 0),
      ...(decision.prediction && { prediction: decision.prediction }),
      ...(decision.note && { note: decision.note.slice(0, 500) }),
      ...(decision.parseError && { parseError: decision.parseError }),
      ...(decision.infraError && { infraError: decision.infraError.slice(0, 500) }),
    };
    decisions.push(record);
    onDecision?.(record, sim);

    recent.push({ obs, command: sim.control });
    if (recent.length > RECENT_ROWS) recent.shift();
    lastDecision = { outputTokens: record.outputTokens, delaySeconds };
  }

  // Score predictions against the true trajectory 5 s after each observation.
  for (const d of decisions) {
    const actual = sim.stateAt(d.obs.t + PREDICTION_HORIZON);
    if (actual && d.obs.t + PREDICTION_HORIZON <= sim.t) {
      d.actual5s = { altitude: round(actual.y, 1), verticalSpeed: round(actual.vy) };
    }
  }

  const outcome: Outcome =
    sim.outcome() ??
    // Aborted mid-flight by infra errors.
    {
      kind: "timeout",
      score: 0,
      touchdown: null,
      fuelRemaining: round(sim.fuel),
      fuelFraction: round(sim.fuel / scenario.fuelCapacity, 3),
      simTime: sim.t,
      twistTriggeredAt: sim.twistTriggeredAt,
    };

  return {
    agent: agent.name,
    clock,
    scenario,
    outcome,
    metrics: computeMetrics(decisions, outcome, (performance.now() - started) / 1000),
    ...(infraError && { infraError }),
    decisions,
    trajectory: sim.log
      .filter((_, i) => i % 5 === 0)
      .map((s) => [
        round(s.t),
        round(s.x, 1),
        round(s.y, 1),
        round(s.vx),
        round(s.vy),
        round(s.main),
        round(s.lateral),
        round(s.fuel, 1),
        round(s.wind),
      ]),
  };
}

function computeMetrics(decisions: DecisionRecord[], outcome: Outcome, wallSeconds: number): EpisodeMetrics {
  const delays = decisions.map((d) => d.delaySeconds);
  const scored = decisions.filter((d) => d.actual5s && d.prediction);
  const errs = (rows: DecisionRecord[], key: "altitude" | "verticalSpeed") => {
    const predKey = key === "altitude" ? "altitude5s" : "verticalSpeed5s";
    const values = rows
      .map((d) => {
        const p = d.prediction?.[predKey];
        return typeof p === "number" && d.actual5s ? Math.abs(p - d.actual5s[key]) : null;
      })
      .filter((v): v is number => v !== null);
    return values.length ? round(mean(values)) : null;
  };
  const twistAt = outcome.twistTriggeredAt;
  return {
    decisions: decisions.length,
    invalidDecisions: decisions.filter((d) => !d.valid).length,
    lateDecisions: decisions.filter((d) => d.tooLate).length,
    meanDelaySeconds: round(delays.length ? mean(delays) : 0),
    maxDelaySeconds: round(delays.length ? Math.max(...delays) : 0),
    thinkingShare: round(outcome.simTime > 0 ? delays.reduce((a, b) => a + b, 0) / outcome.simTime : 0, 3),
    outputTokens: decisions.reduce((a, d) => a + d.outputTokens, 0),
    reasoningTokens: decisions.reduce((a, d) => a + d.reasoningTokens, 0),
    inputTokens: decisions.reduce((a, d) => a + d.inputTokens, 0),
    wallSeconds: round(wallSeconds, 1),
    predictionCount: scored.length,
    altitudeMae: errs(scored, "altitude"),
    verticalSpeedMae: errs(scored, "verticalSpeed"),
    verticalSpeedMaeBeforeTwist: twistAt === null ? null : errs(scored.filter((d) => d.obs.t < twistAt), "verticalSpeed"),
    verticalSpeedMaeAfterTwist: twistAt === null ? null : errs(scored.filter((d) => d.obs.t >= twistAt), "verticalSpeed"),
  };
}
