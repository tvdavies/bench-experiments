import type { Usage } from "@bench/core";
import type { Control, Observation, PublicSpec } from "./sim.ts";

/**
 * How sim time relates to the agent's thinking.
 *
 * - paused: the world freezes while the agent decides (classic turn-based).
 * - tokens: the world advances `msPerToken` per output token (reasoning
 *           included) while the previous command keeps running. Provider-
 *           neutral: network and queueing latency don't count.
 * - wall:   the world advances by real elapsed request time x `wallScale`.
 *           Closest to reality, but confounded by network and gateway load.
 */
export type ClockMode = "paused" | "tokens" | "wall";

export interface ClockConfig {
  mode: ClockMode;
  /** Sim seconds each command is held after it takes effect. */
  holdSeconds: number;
  msPerToken: number;
  wallScale: number;
}

export interface TelemetryRow {
  obs: Observation;
  /** Command issued in response to this observation. */
  command: Control;
}

export interface DecisionContext {
  spec: PublicSpec;
  clock: ClockConfig;
  obs: Observation;
  /** Most recent rows first-to-last (oldest first). */
  recent: TelemetryRow[];
  lastDecision: { outputTokens: number; delaySeconds: number } | null;
}

export interface Prediction {
  altitude5s?: number;
  verticalSpeed5s?: number;
}

export interface Decision {
  control: Control;
  prediction?: Prediction;
  note?: string;
  usage?: Usage;
  latencyMs?: number;
  /** False when the agent's output couldn't be parsed into a command. */
  valid: boolean;
  /** The agent asked for a value outside the protocol menus; it was snapped to the nearest option. */
  offGrid?: boolean;
  /** Request failed (network, quota, gateway). Not the agent's fault. */
  infraError?: string;
  parseError?: string;
}

export interface Agent {
  readonly name: string;
  /** Whether this agent's thinking costs sim time (LLMs yes, scripted baselines no). */
  readonly consumesTime: boolean;
  decide(ctx: DecisionContext): Promise<Decision>;
}
