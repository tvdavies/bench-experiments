/**
 * Chat-model pilot. A pure transport for the shared protocol: the observation
 * is sent verbatim as JSON, and the `control` tool offers exactly the protocol's
 * menus with the protocol's wording. The system prompt only explains the
 * transport, the chat equivalent of Jev's API contract.
 */
import { type ModelConfig, type ToolDef, chat } from "@bench/core";
import { LATERAL_LEVELS, MAIN_LEVELS, QUESTIONS, buildObservation, isOnGrid, quantize } from "../protocol.ts";
import type { Agent, Decision, DecisionContext } from "../types.ts";

export const SYSTEM_PROMPT =
  "You are the pilot in a lander simulation. Each turn, the user message is a JSON object describing the task, rules, vehicle, controls and the current instrument readings. Respond by calling the `control` tool exactly once, choosing one option for each control.";

export const CONTROL_TOOL: ToolDef = {
  name: "control",
  description: "Set the lander's controls. Call exactly once per turn.",
  parameters: {
    type: "object",
    properties: {
      main_throttle: { type: "number", enum: MAIN_LEVELS, description: QUESTIONS.main },
      lateral: { type: "number", enum: LATERAL_LEVELS, description: QUESTIONS.lateral },
    },
    required: ["main_throttle", "lateral"],
    additionalProperties: false,
  },
};

export function userMessage(ctx: DecisionContext): string {
  return JSON.stringify(buildObservation(ctx));
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

interface ControlArgs {
  main_throttle?: unknown;
  lateral?: unknown;
}

/** Accepts a tool call, or falls back to a JSON object in the message text. */
export function parseControl(toolArgs: unknown, content: string): ControlArgs | null {
  if (toolArgs && typeof toolArgs === "object") return toolArgs as ControlArgs;
  const match = content.match(/\{[^{}]*"main_throttle"[^{}]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as ControlArgs;
  } catch {
    return null;
  }
}

export class LlmAgent implements Agent {
  readonly name: string;
  readonly consumesTime = true;

  constructor(private readonly model: ModelConfig) {
    this.name = model.reasoningEffort ? `${model.model}@${model.reasoningEffort}` : model.model;
  }

  async decide(ctx: DecisionContext): Promise<Decision> {
    const result = await chat(
      this.model,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage(ctx) },
      ],
      [CONTROL_TOOL],
    );
    const hold = { ...ctx.obs.command };
    if (result.error) {
      return { control: hold, valid: false, infraError: result.error, usage: result.usage, latencyMs: result.latencyMs };
    }
    const call = result.toolCalls.find((c) => c.name === CONTROL_TOOL.name);
    const args = parseControl(call?.arguments, result.content);
    const main = num(args?.main_throttle);
    const lateral = num(args?.lateral);
    const base = { usage: result.usage, latencyMs: result.latencyMs };
    // Visible text (if any) is kept for the replay only; the protocol never asks for it.
    const note = result.content.trim().replace(/\s+/g, " ").slice(0, 160) || undefined;
    if (main === undefined || lateral === undefined) {
      return {
        control: hold,
        valid: false,
        parseError: `no usable control (finish=${result.finishReason ?? "?"}): ${(call?.rawArguments || result.content).slice(0, 200)}`,
        ...base,
      };
    }
    const raw = { main, lateral };
    const control = quantize(raw);
    return {
      control,
      valid: true,
      ...(!isOnGrid(raw) && { offGrid: true }),
      ...(note && { note }),
      ...base,
    };
  }
}
