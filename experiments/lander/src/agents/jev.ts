/**
 * Jev (Typesafe "systemone") pilot.
 *
 * Jev is not a chat model: it takes a `state` and typed questions and answers
 * each with probabilities (`noul` = P(yes), `choice` = a distribution over named
 * options). Only synthetic sim telemetry is sent. Requires JEV_API_KEY.
 *
 * Interfaces:
 * - `protocol` (the scored entry): a pure transport for the shared protocol.
 *   `state` is the same observation object the chat models receive, the two
 *   questions are the protocol's questions word for word, the options are the
 *   protocol's menus, and the command is the option Jev chooses.
 * - `assess` (side experiment, not comparable): its own structured state with
 *   extra derived readings, and the vertical question reframed as an assessment
 *   ("descending too fast / about right / climbing") mapped to throttle relative
 *   to hover. It breaks the same-information/same-wording rule on purpose, to
 *   test whether framing changes Jev's behaviour.
 */
import type { Usage } from "@bench/core";
import { LATERAL_LEVELS, MAIN_LEVELS, QUESTIONS, buildObservation } from "../protocol.ts";
import type { Agent, Decision, DecisionContext } from "../types.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export type JevInterface = "protocol" | "assess";

type Options = Record<string, { value: number; text: string }>;

/** Protocol menus as Jev choice options. Keys are ids; the text is just the value. */
const menu = (prefix: string, levels: readonly number[]): Options =>
  Object.fromEntries(levels.map((v) => [`${prefix}_${String(v).replace("-", "neg").replace(".", "_")}`, { value: v, text: String(v) }]));
export const PROTOCOL_MAIN = menu("main", MAIN_LEVELS);
export const PROTOCOL_LATERAL = menu("lateral", LATERAL_LEVELS);

const criteria = (opts: Options) => Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, v.text]));

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

function chosenValue(answer: ChoiceAnswer | undefined, opts: Options): number | null {
  if (!answer || answer.type !== "choice") return null;
  return opts[answer.choice]?.value ?? null;
}

function expectedValue(answer: ChoiceAnswer | undefined, opts: Options): number | null {
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

// ---------- side experiment: assessment framing ----------

function assessOptions(hover: number): Options {
  return {
    far_too_fast: { value: 1, text: "Descending far too fast for this altitude; needs hard braking." },
    too_fast: { value: hover + (1 - hover) * 0.5, text: "Descending somewhat too fast for this altitude; needs more braking." },
    about_right: { value: hover, text: "Descent rate is about right for this altitude; hold it steady." },
    too_slow: { value: hover * 0.5, text: "Descending too slowly; at this rate the fuel runs out before touchdown, so it needs less upward thrust." },
    climbing: { value: 0, text: "Climbing, or about to; needs much less upward thrust." },
  };
}

const PUSH_OPTIONS: Options = {
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

// ---------- agent ----------

export class JevAgent implements Agent {
  readonly name: string;
  readonly consumesTime = true;

  constructor(
    private readonly model: string,
    private readonly iface: JevInterface = "protocol",
    private readonly apiKey = process.env.JEV_API_KEY,
    private readonly timeoutMs = 60_000,
  ) {
    if (!apiKey) throw new Error("JEV_API_KEY is required for Jev models");
    this.name = iface === "protocol" ? model : `${model}+${iface}`;
  }

  request(ctx: DecisionContext) {
    if (this.iface === "protocol") {
      return {
        state: buildObservation(ctx),
        questions: {
          main: { type: "choice", instructions: QUESTIONS.main, criteria: criteria(PROTOCOL_MAIN) },
          lateral: { type: "choice", instructions: QUESTIONS.lateral, criteria: criteria(PROTOCOL_LATERAL) },
        },
        mainOptions: PROTOCOL_MAIN,
        lateralOptions: PROTOCOL_LATERAL,
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
        // The command is the option Jev chooses, like any other pilot. (The side experiment
        // keeps a probability-weighted lateral, as it was run.)
        const main = chosenValue(json.answers?.main, req.mainOptions);
        const lateral =
          this.iface === "protocol" ? chosenValue(json.answers?.lateral, req.lateralOptions) : expectedValue(json.answers?.lateral, req.lateralOptions);
        if (main === null || lateral === null) {
          return { control: hold, valid: false, parseError: "malformed choice answers", usage, latencyMs };
        }
        const label = (a: ChoiceAnswer | undefined, opts: Options) =>
          a ? `${this.iface === "protocol" ? opts[a.choice]?.text : a.choice} (${Math.round(a.confidence * 100)}%)` : "?";
        return {
          control: { main, lateral },
          valid: true,
          note: `main ${label(json.answers?.main, req.mainOptions)}, lateral ${label(json.answers?.lateral, req.lateralOptions)}`,
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
