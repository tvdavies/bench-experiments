/**
 * Jev (Typesafe "systemone") pilot.
 *
 * Jev is not a chat model. It takes a `state` and a set of typed questions,
 * and answers each one with probabilities: `noul` (P(yes)) or `choice` (a
 * distribution over named criteria). We fly with two choice questions, one
 * for main throttle and one for lateral thrust, and use the probability-weighted
 * mean as the command, so the output is continuous even though the options
 * are discrete.
 *
 * Jev can't answer numeric questions, so it makes no 5 s predictions.
 * Only synthetic sim telemetry is sent. Requires JEV_API_KEY.
 */
import { clamp } from "@bench/core";
import type { Usage } from "@bench/core";
import type { Agent, Decision, DecisionContext } from "../types.ts";
import { systemPrompt, telemetryMessage } from "./llm.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const MAIN_OPTIONS: Record<string, { value: number; text: string }> = {
  main_0: { value: 0, text: "Main engine off (0): free fall, no upward thrust." },
  main_25: { value: 0.25, text: "Main throttle 0.25: weak thrust, still accelerating downward." },
  main_50: { value: 0.5, text: "Main throttle 0.5: about hover, vertical speed held roughly constant." },
  main_75: { value: 0.75, text: "Main throttle 0.75: braking, reduces descent speed." },
  main_100: { value: 1, text: "Main throttle 1.0: full braking, strongest upward acceleration." },
};

const LATERAL_OPTIONS: Record<string, { value: number; text: string }> = {
  lat_left_full: { value: -1, text: "Lateral -1: full push LEFT (towards negative dx)." },
  lat_left_half: { value: -0.5, text: "Lateral -0.5: gentle push LEFT." },
  lat_none: { value: 0, text: "Lateral 0: no sideways thrust." },
  lat_right_half: { value: 0.5, text: "Lateral +0.5: gentle push RIGHT." },
  lat_right_full: { value: 1, text: "Lateral +1: full push RIGHT (towards positive dx)." },
};

const criteria = (opts: Record<string, { text: string }>) =>
  Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, v.text]));

const QUESTIONS = {
  main: {
    type: "choice",
    instructions:
      "You are flying the lander described in the state. Which main engine throttle should be commanded now to move towards a safe, on-pad landing without running out of fuel?",
    criteria: criteria(MAIN_OPTIONS),
  },
  lateral: {
    type: "choice",
    instructions:
      "You are flying the lander described in the state. Which lateral thrust should be commanded now to bring dx and vx towards zero, allowing for the wind?",
    criteria: criteria(LATERAL_OPTIONS),
  },
} as const;

interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface JevResponse {
  model?: string;
  answers?: Record<string, ChoiceAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function expectedValue(answer: ChoiceAnswer | undefined, opts: Record<string, { value: number }>): number | null {
  if (!answer || answer.type !== "choice" || typeof answer.probabilities !== "object") return null;
  let total = 0;
  let mass = 0;
  for (const [key, p] of Object.entries(answer.probabilities)) {
    const opt = opts[key];
    if (!opt || typeof p !== "number" || !Number.isFinite(p)) return null;
    total += p * opt.value;
    mass += p;
  }
  return mass > 0.5 ? total / mass : null;
}

/**
 * Interfaces:
 * - `throttle` (v1): the chat briefing as prose, asking Jev to pick absolute
 *   throttle and lateral levels. Probing showed Jev reads the instruments
 *   correctly but has a strong "more thrust is safer" bias whenever it is asked
 *   an action question, even while climbing.
 * - `assess` (v2): structured instrument readings, and the vertical question is
 *   framed as an assessment ("descending too fast / about right / climbing").
 *   Each answer maps to a throttle relative to hover, so the adapter supplies
 *   the hover-throttle physics that every model is told in its briefing.
 */
export type JevInterface = "throttle" | "assess";

function assessOptions(hover: number): Record<string, { value: number; text: string }> {
  return {
    far_too_fast: { value: 1, text: "Descending far too fast for this altitude; needs hard braking." },
    too_fast: { value: hover + (1 - hover) * 0.5, text: "Descending somewhat too fast for this altitude; needs more braking." },
    about_right: { value: hover, text: "Descent rate is about right for this altitude; hold it steady." },
    too_slow: { value: hover * 0.5, text: "Descending too slowly; at this rate the fuel runs out before touchdown, so it needs less upward thrust." },
    climbing: { value: 0, text: "Climbing, or about to; needs much less upward thrust." },
  };
}

const PUSH_OPTIONS: Record<string, { value: number; text: string }> = {
  push_left: { value: -1, text: "Push the lander left (towards negative dx)." },
  none: { value: 0, text: "No sideways thrust." },
  push_right: { value: 1, text: "Push the lander right (towards positive dx)." },
};

export function instrumentState(ctx: DecisionContext) {
  const o = ctx.obs;
  const s = ctx.spec;
  return {
    task: "Land the lander softly on the pad.",
    vehicle: {
      gravity_mps2: s.gravity,
      main_engine_max_up_accel_mps2: s.mainAccelMax,
      hover_throttle: Math.round((s.gravity / s.mainAccelMax) * 100) / 100,
      lateral_max_accel_mps2: s.lateralAccelMax,
      fuel_capacity: s.fuelCapacity,
      pad_half_width_m: s.padHalfWidth,
      safe_touchdown: { max_abs_vertical_speed_mps: 2, max_abs_horizontal_speed_mps: 1 },
    },
    instruments: {
      time_s: o.t,
      altitude_m: o.altitude,
      vertical_speed_mps: o.vy,
      vertical_motion: o.vy > 0.3 ? "climbing" : o.vy < -0.3 ? "descending" : "steady",
      horizontal_offset_from_pad_m: o.dx,
      side_of_pad: o.dx < -s.padHalfWidth ? "left of pad" : o.dx > s.padHalfWidth ? "right of pad" : "over pad",
      horizontal_speed_mps: o.vx,
      horizontal_motion: o.vx < -0.3 ? "moving left" : o.vx > 0.3 ? "moving right" : "steady",
      fuel_remaining: o.fuel,
      wind_accel_estimate_mps2: o.windEstimate,
      // Derived readings, as a real lander's display would show them.
      time_to_touchdown_at_current_rate_s: o.vy < -0.1 ? Math.round(o.altitude / -o.vy) : null,
      fuel_endurance_at_hover_s: Math.round(o.fuel / Math.max(0.05, s.gravity / s.mainAccelMax)),
    },
    current_command: { main_throttle: o.command.main, lateral: o.command.lateral },
    recent: ctx.recent.slice(-5).map((r) => ({
      time_s: r.obs.t,
      altitude_m: r.obs.altitude,
      vertical_speed_mps: r.obs.vy,
      horizontal_offset_from_pad_m: r.obs.dx,
      horizontal_speed_mps: r.obs.vx,
      main_throttle: r.command.main,
      lateral: r.command.lateral,
    })),
    ...(ctx.clock.mode !== "paused" && {
      timing: "The world keeps moving while you decide; your previous command stays active until your answer arrives.",
    }),
  };
}

function chosenValue(answer: ChoiceAnswer | undefined, opts: Record<string, { value: number }>): number | null {
  if (!answer || answer.type !== "choice") return null;
  return opts[answer.choice]?.value ?? null;
}

export class JevAgent implements Agent {
  readonly name: string;
  readonly consumesTime = true;

  constructor(
    private readonly model: string,
    private readonly iface: JevInterface = "throttle",
    private readonly apiKey = process.env.JEV_API_KEY,
    private readonly timeoutMs = 60_000,
  ) {
    if (!apiKey) throw new Error("JEV_API_KEY is required for Jev models");
    this.name = iface === "throttle" ? model : `${model}+${iface}`;
  }

  private request(ctx: DecisionContext) {
    if (this.iface === "throttle") {
      return {
        state: {
          briefing: systemPrompt(ctx.spec, ctx.clock).replace(/\n\nPREDICTIONS[\s\S]*$/, ""),
          telemetry: telemetryMessage(ctx),
        },
        questions: QUESTIONS,
        mainOptions: MAIN_OPTIONS,
        lateralOptions: LATERAL_OPTIONS,
      };
    }
    const mainOptions = assessOptions(ctx.spec.gravity / ctx.spec.mainAccelMax);
    return {
      state: instrumentState(ctx),
      questions: {
        main: {
          type: "choice",
          instructions:
            "Given the lander's altitude, vertical speed and remaining fuel endurance, how does its descent compare with what a soft landing on the pad needs right now? It must reach the ground before the fuel runs out, but slowly enough to brake in time.",
          criteria: criteria(mainOptions),
        },
        lateral: {
          type: "choice",
          instructions:
            "Which way should the lateral thrusters push now to bring the lander over the pad and stop its sideways motion, allowing for the wind?",
          criteria: criteria(PUSH_OPTIONS),
        },
      },
      mainOptions,
      lateralOptions: PUSH_OPTIONS,
    };
  }

  async decide(ctx: DecisionContext): Promise<Decision> {
    const hold = { ...ctx.obs.command };
    const req = this.request(ctx);
    const MAIN_OPTIONS = req.mainOptions;
    const LATERAL_OPTIONS = req.lateralOptions;
    const body = JSON.stringify({ model: this.model, state: req.state, questions: req.questions });

    let lastError = "unknown error";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const started = performance.now();
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const latencyMs = performance.now() - started;
        const text = await res.text();
        if (!res.ok) {
          // Never echo the body: it may reflect request content.
          lastError = `HTTP ${res.status}`;
          if ((res.status === 429 || res.status >= 500) && attempt < 3) {
            await Bun.sleep(1000 * 2 ** (attempt - 1));
            continue;
          }
          break;
        }
        const json = JSON.parse(text) as JevResponse;
        const usage: Usage = {
          inputTokens: json.usage?.input_tokens ?? 0,
          outputTokens: json.usage?.output_tokens ?? 0,
          reasoningTokens: 0,
        };
        // v1 averages the distribution. The assessment interface uses Jev's own choice for the
        // vertical axis: its answers there are often two-humped ("too slow" vs "too fast"), and
        // averaging those lands on hover, so the command never moves even when Jev says "descend".
        const main =
          this.iface === "assess" ? chosenValue(json.answers?.main, MAIN_OPTIONS) : expectedValue(json.answers?.main, MAIN_OPTIONS);
        const lateral = expectedValue(json.answers?.lateral, LATERAL_OPTIONS);
        if (main === null || lateral === null) {
          return { control: hold, valid: false, parseError: "malformed choice answers", usage, latencyMs };
        }
        const top = (a: ChoiceAnswer | undefined) => (a ? `${a.choice} (${Math.round(a.confidence * 100)}%)` : "?");
        return {
          control: { main: clamp(main, 0, 1), lateral: clamp(lateral, -1, 1) },
          valid: true,
          note: `${top(json.answers?.main)}, ${top(json.answers?.lateral)}`,
          usage,
          latencyMs,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.name : String(err);
        if (attempt < 3) await Bun.sleep(1000 * 2 ** (attempt - 1));
      }
    }
    return { control: hold, valid: false, infraError: lastError };
  }
}
