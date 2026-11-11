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

export class JevAgent implements Agent {
  readonly name: string;
  readonly consumesTime = true;

  constructor(
    private readonly model: string,
    private readonly apiKey = process.env.JEV_API_KEY,
    private readonly timeoutMs = 60_000,
  ) {
    if (!apiKey) throw new Error("JEV_API_KEY is required for Jev models");
    this.name = model;
  }

  async decide(ctx: DecisionContext): Promise<Decision> {
    const hold = { ...ctx.obs.command };
    const state = {
      briefing: systemPrompt(ctx.spec, ctx.clock).replace(/\n\nPREDICTIONS[\s\S]*$/, ""),
      telemetry: telemetryMessage(ctx),
    };
    const body = JSON.stringify({ model: this.model, state, questions: QUESTIONS });

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
        const main = expectedValue(json.answers?.main, MAIN_OPTIONS);
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
