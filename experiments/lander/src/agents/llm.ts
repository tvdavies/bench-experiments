import { type ModelConfig, type ToolDef, chat, clamp } from "@bench/core";
import type { PublicSpec } from "../sim.ts";
import type { Agent, ClockConfig, Decision, DecisionContext, Prediction } from "../types.ts";

const CONTROL_TOOL: ToolDef = {
  name: "control",
  description: "Set the lander's engine commands. Call exactly once per turn.",
  parameters: {
    type: "object",
    properties: {
      main: { type: "number", minimum: 0, maximum: 1, description: "Main engine throttle, 0..1 (upward thrust)." },
      lateral: {
        type: "number",
        minimum: -1,
        maximum: 1,
        description: "Lateral thrusters, -1..1. Positive pushes the lander right (+dx).",
      },
      predicted_altitude_5s: {
        type: "number",
        description: "Your expected altitude (m) 5 s of sim time after the telemetry you were given.",
      },
      predicted_vy_5s: {
        type: "number",
        description: "Your expected vertical speed (m/s, negative = descending) 5 s after the telemetry you were given.",
      },
      note: { type: "string", description: "Optional, very short note on your intent." },
    },
    required: ["main", "lateral"],
  },
};

function clockText(clock: ClockConfig): string {
  const hold = `held for ${clock.holdSeconds} s of sim time before the next telemetry is taken`;
  switch (clock.mode) {
    case "paused":
      return `The world is PAUSED while you think. Your command takes effect immediately and is ${hold}.`;
    case "tokens":
      return [
        "The world does NOT pause while you think.",
        `Sim time advances ${clock.msPerToken} ms for every output token you generate, hidden reasoning included`,
        `(about ${Math.round(1000 / clock.msPerToken)} tokens per sim second). Meanwhile your PREVIOUS command keeps running.`,
        `Then your new command takes effect and is ${hold}.`,
        "Each telemetry message reports how long your last decision took.",
      ].join(" ");
    case "wall":
      return [
        "The world does NOT pause while you think.",
        `Sim time advances with real elapsed time for your response (x${clock.wallScale}). Meanwhile your PREVIOUS command keeps running.`,
        `Then your new command takes effect and is ${hold}.`,
        "Each telemetry message reports how long your last decision took.",
      ].join(" ");
  }
}

export function systemPrompt(spec: PublicSpec, clock: ClockConfig): string {
  const hover = spec.gravity / spec.mainAccelMax;
  return `You are the flight computer of a small lander. Land it softly on the pad.

COORDINATES
- altitude: metres above flat ground. Up is positive.
- dx: horizontal offset from the pad centre in metres. Positive = the lander is to the RIGHT of the pad.
- vx: horizontal velocity, m/s, positive = moving right. vy: vertical velocity, m/s, positive = up, negative = descending.

VEHICLE
- Gravity: ${spec.gravity} m/s² downward.
- Main engine: throttle 0..1 gives up to ${spec.mainAccelMax} m/s² of upward acceleration. Hover is about ${hover.toFixed(2)} throttle.
- Lateral thrusters: -1..1 gives up to ${spec.lateralAccelMax} m/s² of horizontal acceleration (positive pushes right).
- Fuel: ${spec.fuelCapacity} units. Burn per second = main + 0.5 x |lateral|. With no fuel the engines stop.
- Wind pushes you sideways and changes over time, with gusts. wind_estimate is a noisy reading of the wind's current horizontal acceleration in m/s².
- Telemetry has small sensor noise.

LANDING
Touchdown happens when altitude reaches 0. It is a successful landing only if |vy| <= 2.0 m/s, |vx| <= 1.0 m/s and |dx| <= ${spec.padHalfWidth} m. Anything faster is a crash. The flight ends at ${spec.timeLimit} s; still flying then is a failure. Score: a safe landing matters most, then fuel left, then how close to the pad centre you land.

CONTROL LOOP
You take over from the autopilot, which is holding hover throttle and zero lateral thrust. Each turn you get telemetry. Respond by calling the \`control\` tool exactly once.
${clockText(clock)}

PREDICTIONS
Also fill predicted_altitude_5s and predicted_vy_5s with what you expect altitude and vy to be 5 s of sim time after the telemetry you were given. They are scored separately and don't affect the flight.`;
}

const f = (n: number, places = 2) => n.toFixed(places);

export function telemetryMessage(ctx: DecisionContext): string {
  const o = ctx.obs;
  const lines = [
    `TELEMETRY t=${f(o.t)} s`,
    `altitude ${f(o.altitude, 1)} m | dx ${f(o.dx, 1)} m | vx ${f(o.vx)} m/s | vy ${f(o.vy)} m/s`,
    `fuel ${f(o.fuel, 1)} (${Math.round(o.fuelFraction * 100)}%) | wind_estimate ${f(o.windEstimate)} m/s² | current command main ${f(o.command.main)}, lateral ${f(o.command.lateral)}`,
  ];
  if (ctx.lastDecision && ctx.clock.mode !== "paused") {
    lines.push(
      `Your last decision used ${ctx.lastDecision.outputTokens} output tokens; ${f(ctx.lastDecision.delaySeconds)} s of sim time passed before it took effect.`,
    );
  }
  if (ctx.recent.length > 0) {
    lines.push("", "RECENT TELEMETRY (oldest first) and the command you issued in response:");
    lines.push("t | altitude | dx | vx | vy | fuel | wind | -> main | lateral");
    for (const r of ctx.recent) {
      lines.push(
        [f(r.obs.t), f(r.obs.altitude, 1), f(r.obs.dx, 1), f(r.obs.vx), f(r.obs.vy), f(r.obs.fuel, 1), f(r.obs.windEstimate), `-> ${f(r.command.main)}`, f(r.command.lateral)].join(" | "),
      );
    }
  }
  return lines.join("\n");
}

interface ControlArgs {
  main?: unknown;
  lateral?: unknown;
  predicted_altitude_5s?: unknown;
  predicted_vy_5s?: unknown;
  note?: unknown;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/** Accepts a tool call, or falls back to a JSON object in the message text. */
export function parseControl(toolArgs: unknown, content: string): ControlArgs | null {
  if (toolArgs && typeof toolArgs === "object") return toolArgs as ControlArgs;
  const match = content.match(/\{[^{}]*"main"[^{}]*\}/);
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
        { role: "system", content: systemPrompt(ctx.spec, ctx.clock) },
        { role: "user", content: telemetryMessage(ctx) },
      ],
      [CONTROL_TOOL],
    );
    const hold = { ...ctx.obs.command };
    if (result.error) {
      return { control: hold, valid: false, infraError: result.error, usage: result.usage, latencyMs: result.latencyMs };
    }

    const call = result.toolCalls.find((c) => c.name === CONTROL_TOOL.name);
    const args = parseControl(call?.arguments, result.content);
    const main = num(args?.main);
    const lateral = num(args?.lateral);
    const base = { usage: result.usage, latencyMs: result.latencyMs };
    if (main === undefined || lateral === undefined) {
      return {
        control: hold,
        valid: false,
        parseError: `no usable control (finish=${result.finishReason ?? "?"}): ${(call?.rawArguments || result.content).slice(0, 200)}`,
        ...base,
      };
    }

    const prediction: Prediction = {};
    const pAlt = num(args?.predicted_altitude_5s);
    const pVy = num(args?.predicted_vy_5s);
    if (pAlt !== undefined) prediction.altitude5s = pAlt;
    if (pVy !== undefined) prediction.verticalSpeed5s = pVy;

    return {
      control: { main: clamp(main, 0, 1), lateral: clamp(lateral, -1, 1) },
      valid: true,
      ...(Object.keys(prediction).length > 0 && { prediction }),
      ...(typeof args?.note === "string" && { note: args.note }),
      ...base,
    };
  }
}
