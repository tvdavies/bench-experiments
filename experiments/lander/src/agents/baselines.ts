import { clamp } from "@bench/core";
import type { Agent, Decision, DecisionContext } from "../types.ts";

/**
 * Hand-written descent controller. Thinks instantly, so it shows what
 * "good enough" closed-loop control looks like at the same command rate the
 * models get. If a model can't beat these, it isn't flying well.
 *
 * - `p`:  proportional only. Trusts the spec sheet completely, so a silently
 *         weakened engine leaves it descending too fast. Fails the twist set.
 * - `pi`: adds an integral term on vertical speed, so it compensates for a
 *         thrust shortfall it was never told about. Shows the twist is survivable.
 */
export class ControllerAgent implements Agent {
  readonly name: string;
  readonly consumesTime = false;
  private integral = 0;

  constructor(private readonly variant: "p" | "pi") {
    this.name = `baseline:${variant}`;
  }

  async decide({ obs, spec, clock }: DecisionContext): Promise<Decision> {
    const alt = obs.altitude;
    const overPad = Math.abs(obs.dx) < spec.padHalfWidth * 0.6;

    // Descend faster when high, slow to ~1 m/s near the ground; hover low if not over the pad.
    let vyTarget = -clamp(0.12 * alt, 1.0, 18);
    if (alt < 40 && !overPad) vyTarget = 0;
    const vyError = vyTarget - obs.vy;

    if (this.variant === "pi") {
      // Anti-windup: cap the correction at half of gravity.
      this.integral = clamp(this.integral + 0.4 * vyError * clock.holdSeconds, -0.5 * spec.gravity, 0.5 * spec.gravity);
    }
    const main = clamp((spec.gravity + 0.8 * vyError + this.integral) / spec.mainAccelMax, 0, 1);

    const vxTarget = clamp(-0.08 * obs.dx, -6, 6);
    const lateral = clamp((0.8 * (vxTarget - obs.vx) - obs.windEstimate) / spec.lateralAccelMax, -1, 1);

    return { control: { main, lateral }, valid: true };
  }
}

/** Does nothing. Floor for the scoreboard. */
export class NoopAgent implements Agent {
  readonly name = "baseline:noop";
  readonly consumesTime = false;

  async decide(): Promise<Decision> {
    return { control: { main: 0, lateral: 0 }, valid: true };
  }
}
