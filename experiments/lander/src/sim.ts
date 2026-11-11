/**
 * 2D point-mass lander with gravity, gusty wind, fuel and an optional
 * silent engine failure. No rotation: the main engine pushes straight up and
 * lateral thrusters push sideways. Keeping the vehicle simple keeps the
 * benchmark focused on timing and closed-loop control rather than on parsing
 * attitude dynamics through text.
 *
 * Wind evolves as a function of sim time only (its own RNG stream, fixed
 * physics step), so every agent flying a given scenario faces the same air.
 */
import { Rng, clamp, hashSeed, noiseAt, round } from "@bench/core";

export const PHYSICS_DT = 0.05;
export const LANDING_LIMITS = { vy: 2.0, vx: 1.0 } as const;

export interface WindConfig {
  /** Mean horizontal acceleration from wind, m/s². Positive pushes right. */
  mean: number;
  /** Ornstein-Uhlenbeck stationary standard deviation, m/s². */
  sigma: number;
  /** OU correlation time, s. */
  tau: number;
  /** Expected gusts per second. */
  gustRate: number;
  gustAccelMin: number;
  gustAccelMax: number;
  gustDurationMin: number;
  gustDurationMax: number;
}

/** Hidden from the agent: main engine output drops once below an altitude. */
export interface EngineTwist {
  kind: "engine-degradation";
  belowAltitude: number;
  factor: number;
}

export interface Scenario {
  id: string;
  set: string;
  seed: number;
  gravity: number;
  mainAccelMax: number;
  lateralAccelMax: number;
  fuelCapacity: number;
  padHalfWidth: number;
  timeLimit: number;
  /** Lander position relative to the pad centre (pad is at x = 0). */
  start: { x: number; y: number; vx: number; vy: number };
  wind: WindConfig;
  twist: EngineTwist | null;
  sensorNoise: { position: number; velocity: number; wind: number };
}

/** The parts of a scenario a pilot would be told before flying. */
export interface PublicSpec {
  gravity: number;
  mainAccelMax: number;
  lateralAccelMax: number;
  fuelCapacity: number;
  padHalfWidth: number;
  timeLimit: number;
}

export function publicSpec(s: Scenario): PublicSpec {
  return {
    gravity: s.gravity,
    mainAccelMax: s.mainAccelMax,
    lateralAccelMax: s.lateralAccelMax,
    fuelCapacity: s.fuelCapacity,
    padHalfWidth: s.padHalfWidth,
    timeLimit: s.timeLimit,
  };
}

export interface Control {
  main: number;
  lateral: number;
}

export interface Observation {
  t: number;
  altitude: number;
  /** Horizontal offset from pad centre; positive = right of pad. */
  dx: number;
  vx: number;
  vy: number;
  fuel: number;
  fuelFraction: number;
  windEstimate: number;
  command: Control;
}

export interface TickSample {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuel: number;
  wind: number;
  main: number;
  lateral: number;
  engineFactor: number;
}

export interface Touchdown {
  t: number;
  dx: number;
  vx: number;
  vy: number;
}

export type OutcomeKind = "landed" | "crashed" | "missed-pad" | "timeout";

export interface Outcome {
  kind: OutcomeKind;
  score: number;
  touchdown: Touchdown | null;
  fuelRemaining: number;
  fuelFraction: number;
  simTime: number;
  twistTriggeredAt: number | null;
}

export class LanderSim {
  tick = 0;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuel: number;
  wind: number;
  engineFactor = 1;
  /** The autopilot hands over holding hover throttle, so a slow first decision isn't instantly fatal. */
  control: Control;
  done = false;
  timedOut = false;
  touchdown: Touchdown | null = null;
  twistTriggeredAt: number | null = null;
  readonly log: TickSample[] = [];

  private gustRemaining = 0;
  private gustAccel = 0;
  private readonly windRng: Rng;

  constructor(readonly scenario: Scenario) {
    this.x = scenario.start.x;
    this.y = scenario.start.y;
    this.vx = scenario.start.vx;
    this.vy = scenario.start.vy;
    this.fuel = scenario.fuelCapacity;
    this.wind = scenario.wind.mean;
    this.control = { main: clamp(scenario.gravity / scenario.mainAccelMax, 0, 1), lateral: 0 };
    this.windRng = new Rng(hashSeed("wind", scenario.seed));
    this.record();
  }

  get t(): number {
    return round(this.tick * PHYSICS_DT, 4);
  }

  setControl(c: Control): void {
    const main = Number.isFinite(c.main) ? c.main : 0;
    const lateral = Number.isFinite(c.lateral) ? c.lateral : 0;
    this.control = { main: clamp(main, 0, 1), lateral: clamp(lateral, -1, 1) };
  }

  /** Advance by whole physics steps. Returns the sim time actually elapsed. */
  advance(seconds: number): number {
    const ticks = Math.max(0, Math.round(seconds / PHYSICS_DT));
    const start = this.t;
    for (let i = 0; i < ticks && !this.done; i++) this.step();
    return round(this.t - start, 4);
  }

  observe(): Observation {
    const s = this.scenario;
    const n = (channel: string, sigma: number) => sigma * noiseAt(s.seed, this.tick, channel);
    return {
      t: round(this.t),
      altitude: round(Math.max(0, this.y + n("y", s.sensorNoise.position)), 1),
      dx: round(this.x + n("x", s.sensorNoise.position), 1),
      vx: round(this.vx + n("vx", s.sensorNoise.velocity)),
      vy: round(this.vy + n("vy", s.sensorNoise.velocity)),
      fuel: round(this.fuel, 1),
      fuelFraction: round(this.fuel / s.fuelCapacity, 3),
      windEstimate: round(this.wind + this.gustAccel + n("w", s.sensorNoise.wind)),
      command: { ...this.control },
    };
  }

  /** True state at a past sim time, from the tick log. */
  stateAt(t: number): TickSample | undefined {
    return this.log[Math.round(t / PHYSICS_DT)];
  }

  outcome(): Outcome | null {
    if (!this.done) return null;
    const s = this.scenario;
    const fuelFraction = this.fuel / s.fuelCapacity;
    const base = {
      touchdown: this.touchdown,
      fuelRemaining: round(this.fuel),
      fuelFraction: round(fuelFraction, 3),
      simTime: this.t,
      twistTriggeredAt: this.twistTriggeredAt,
    };
    if (this.timedOut || !this.touchdown) return { kind: "timeout", score: 0, ...base };
    return { ...scoreTouchdown(this.touchdown, fuelFraction, s.padHalfWidth), ...base };
  }

  private step(): void {
    const s = this.scenario;
    const w = s.wind;
    const dt = PHYSICS_DT;

    // Wind: OU process plus occasional gusts. Depends only on sim time.
    this.wind +=
      ((w.mean - this.wind) * dt) / w.tau + w.sigma * Math.sqrt((2 * dt) / w.tau) * this.windRng.normal();
    const gustRoll = this.windRng.float();
    const gustSign = this.windRng.sign();
    const gustMag = this.windRng.uniform(w.gustAccelMin, w.gustAccelMax);
    const gustLen = this.windRng.uniform(w.gustDurationMin, w.gustDurationMax);
    if (this.gustRemaining > 0) {
      this.gustRemaining -= dt;
      if (this.gustRemaining <= 0) this.gustAccel = 0;
    } else if (gustRoll < w.gustRate * dt) {
      this.gustRemaining = gustLen;
      this.gustAccel = gustSign * gustMag;
    }

    if (s.twist && this.twistTriggeredAt === null && this.y <= s.twist.belowAltitude) {
      this.engineFactor = s.twist.factor;
      this.twistTriggeredAt = this.t;
    }

    let { main, lateral } = this.control;
    const burn = (main + 0.5 * Math.abs(lateral)) * dt;
    if (burn > 0) {
      const available = Math.min(1, this.fuel / burn);
      main *= available;
      lateral *= available;
      this.fuel = Math.max(0, this.fuel - burn * available);
    }

    const ax = lateral * s.lateralAccelMax + this.wind + this.gustAccel;
    const ay = main * s.mainAccelMax * this.engineFactor - s.gravity;

    const prevX = this.x;
    const prevY = this.y;
    this.vx += ax * dt;
    this.vy += ay * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.tick++;

    if (this.y <= 0) {
      const frac = prevY > 0 ? prevY / (prevY - this.y) : 1;
      this.touchdown = {
        t: round((this.tick - 1 + frac) * dt, 3),
        dx: round(prevX + (this.x - prevX) * frac, 2),
        vx: round(this.vx, 3),
        vy: round(this.vy, 3),
      };
      this.y = 0;
      this.done = true;
    } else if (this.t >= s.timeLimit - 1e-9) {
      this.done = true;
      this.timedOut = true;
    }
    this.record();
  }

  private record(): void {
    this.log.push({
      t: this.t,
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      fuel: this.fuel,
      wind: this.wind + this.gustAccel,
      main: this.control.main,
      lateral: this.control.lateral,
      engineFactor: this.engineFactor,
    });
  }
}

/**
 * Scoring, 0-100:
 * - Safe landing on the pad: 70 base + up to 15 for fuel left + up to 15 for centring.
 * - Anything else that touches down: up to 50, decaying with how far outside the
 *   limits it was, so a slightly hard landing beats a lawn dart.
 * - Timeout: 0.
 */
export function scoreTouchdown(
  td: Touchdown,
  fuelFraction: number,
  padHalfWidth: number,
): { kind: OutcomeKind; score: number } {
  const safe = Math.abs(td.vy) <= LANDING_LIMITS.vy && Math.abs(td.vx) <= LANDING_LIMITS.vx;
  const onPad = Math.abs(td.dx) <= padHalfWidth;
  if (safe && onPad) {
    const score = 70 + 15 * fuelFraction + 15 * (1 - Math.abs(td.dx) / padHalfWidth);
    return { kind: "landed", score: round(score) };
  }
  const severity =
    Math.max(0, Math.abs(td.vy) - LANDING_LIMITS.vy) / 4 +
    Math.max(0, Math.abs(td.vx) - LANDING_LIMITS.vx) / 2 +
    Math.max(0, Math.abs(td.dx) - padHalfWidth) / 40;
  return { kind: safe ? "missed-pad" : "crashed", score: round(50 * Math.exp(-severity)) };
}
