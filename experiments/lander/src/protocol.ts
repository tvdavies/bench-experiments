/**
 * The pilot protocol (v2). The single definition of what every pilot sees and
 * what it can control. Agents translate this into their transport (a chat
 * message and tool for LLMs, `state` and choice questions for Jev), but they
 * must not add, remove or reword information, and must not change the controls.
 *
 * Rules:
 * - Same information: every pilot receives the identical observation object.
 * - Same controls: every pilot chooses from the same discrete menus.
 * - Same questions: the control questions are worded once, here.
 * - Nothing extra in the scored run: no side questions that cost some pilots time.
 */
import { round } from "@bench/core";
import type { Control } from "./sim.ts";
import type { DecisionContext } from "./types.ts";

export const PROTOCOL_VERSION = "v2";

/** Main engine throttle options, 0 to 1 in 0.1 steps. */
export const MAIN_LEVELS = Array.from({ length: 11 }, (_, i) => round(i / 10, 1));
/** Lateral thrust options, -1 to 1 in 0.25 steps. */
export const LATERAL_LEVELS = Array.from({ length: 9 }, (_, i) => round(-1 + i * 0.25, 2));

export const QUESTIONS = {
  main: "Choose the main engine throttle to command now.",
  lateral: "Choose the lateral thrust to command now.",
} as const;

export function nearestLevel(levels: readonly number[], value: number): number {
  let best = levels[0] as number;
  for (const l of levels) if (Math.abs(l - value) < Math.abs(best - value)) best = l;
  return best;
}

/** Snap any command onto the protocol menus. Used for every pilot, baselines included. */
export function quantize(c: Control): Control {
  return { main: nearestLevel(MAIN_LEVELS, c.main), lateral: nearestLevel(LATERAL_LEVELS, c.lateral) };
}

export function isOnGrid(c: Control): boolean {
  return MAIN_LEVELS.includes(c.main) && LATERAL_LEVELS.includes(c.lateral);
}

function clockRule(ctx: DecisionContext): string {
  const hold = `then your command is held for ${ctx.clock.holdSeconds} s of sim time before the next readings`;
  switch (ctx.clock.mode) {
    case "paused":
      return `The world is paused while you decide; your command takes effect immediately, ${hold}.`;
    case "tokens":
      return `The world keeps moving while you decide: sim time advances ${ctx.clock.msPerToken} ms per output token you generate, hidden reasoning included, while your previous command keeps running; ${hold}.`;
    case "wall":
      return `The world keeps moving while you decide: sim time advances with the real time your response takes (x${ctx.clock.wallScale}), while your previous command keeps running; ${hold}.`;
  }
}

/**
 * The observation every pilot receives. Plain JSON, identical across pilots for
 * the same decision point.
 */
export function buildObservation(ctx: DecisionContext) {
  const s = ctx.spec;
  const o = ctx.obs;
  return {
    protocol: PROTOCOL_VERSION,
    task: "Land the lander softly on the pad.",
    rules: {
      success: `Touchdown (altitude reaches 0) counts as a landing only if |vertical_speed| <= 2.0 m/s, |horizontal_speed| <= 1.0 m/s and |offset_from_pad| <= ${s.padHalfWidth} m. Anything else is a crash.`,
      time_limit_s: s.timeLimit,
      scoring: "A safe landing matters most, then fuel left, then how close to the pad centre you land.",
      clock: clockRule(ctx),
    },
    coordinates: {
      altitude_m: "metres above flat ground; up is positive",
      offset_from_pad_m: "horizontal position relative to the pad centre; positive means right of the pad",
      horizontal_speed_mps: "positive means moving right",
      vertical_speed_mps: "positive means moving up; negative means descending",
    },
    vehicle: {
      gravity_mps2: s.gravity,
      main_engine: `throttle 0 to 1 gives up to ${s.mainAccelMax} m/s² of upward acceleration; hover is about ${round(s.gravity / s.mainAccelMax, 2)} throttle`,
      lateral_thrusters: `-1 to 1 gives up to ${s.lateralAccelMax} m/s² of horizontal acceleration; positive pushes right`,
      fuel: `${s.fuelCapacity} units at the start; burn per second = main throttle + 0.5 x |lateral|; with no fuel the engines stop`,
      wind: "pushes the lander sideways and changes over time, with gusts",
      sensors: "readings carry small noise",
      handover: "you take over from an autopilot holding hover throttle and zero lateral thrust",
    },
    controls: {
      main_throttle: { question: QUESTIONS.main, options: MAIN_LEVELS },
      lateral: { question: QUESTIONS.lateral, options: LATERAL_LEVELS },
    },
    instruments: {
      time_s: o.t,
      altitude_m: o.altitude,
      offset_from_pad_m: o.dx,
      horizontal_speed_mps: o.vx,
      vertical_speed_mps: o.vy,
      fuel_remaining: o.fuel,
      wind_accel_estimate_mps2: o.windEstimate,
    },
    current_command: { main_throttle: o.command.main, lateral: o.command.lateral },
    ...(ctx.lastDecision &&
      ctx.clock.mode !== "paused" && {
        last_decision: {
          output_tokens: ctx.lastDecision.outputTokens,
          sim_seconds_before_it_took_effect: ctx.lastDecision.delaySeconds,
        },
      }),
    recent_readings: ctx.recent.map((r) => ({
      time_s: r.obs.t,
      altitude_m: r.obs.altitude,
      offset_from_pad_m: r.obs.dx,
      horizontal_speed_mps: r.obs.vx,
      vertical_speed_mps: r.obs.vy,
      fuel_remaining: r.obs.fuel,
      wind_accel_estimate_mps2: r.obs.windEstimate,
      commanded_main_throttle: r.command.main,
      commanded_lateral: r.command.lateral,
    })),
  };
}

export type Observation = ReturnType<typeof buildObservation>;
