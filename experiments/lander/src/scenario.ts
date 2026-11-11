/**
 * Procedural scenarios. The same seed gives the same start state, gravity and
 * wind in every set, so comparing sets isolates the thing the set changes:
 *
 * - calm:     no wind, no twist. Sanity check: can the agent fly at all?
 * - standard: gusty wind.
 * - twist:    gusty wind plus a silent main-engine degradation during the
 *             descent. The agent is never told. Does it notice and adapt?
 */
import { Rng, hashSeed, round } from "@bench/core";
import type { Scenario } from "./sim.ts";

export const SCENARIO_SETS = ["calm", "standard", "twist"] as const;
export type ScenarioSet = (typeof SCENARIO_SETS)[number];

export function isScenarioSet(value: string): value is ScenarioSet {
  return (SCENARIO_SETS as readonly string[]).includes(value);
}

export function makeScenario(set: ScenarioSet, seed: number): Scenario {
  const rng = new Rng(hashSeed("lander", seed));
  const gravity = round(rng.uniform(1.6, 3.7));
  const start = {
    x: round(rng.sign() * rng.uniform(40, 160), 1),
    y: round(rng.uniform(350, 550), 1),
    vx: round(rng.uniform(-8, 8)),
    vy: round(-rng.uniform(5, 15)),
  };
  const windMean = round(rng.uniform(-0.4, 0.4));

  const twistRng = new Rng(hashSeed("lander-twist", seed));
  const twist =
    set === "twist"
      ? {
          kind: "engine-degradation" as const,
          // Tuned so a spec-trusting P controller almost always crashes and an
          // adaptive PI controller survives about half the time.
          belowAltitude: round(twistRng.uniform(180, 320), 1),
          factor: 0.75,
        }
      : null;

  const calm = set === "calm";
  return {
    id: `${set}-${seed}`,
    set,
    seed,
    gravity,
    mainAccelMax: round(gravity * 2),
    lateralAccelMax: 1.5,
    fuelCapacity: 45,
    padHalfWidth: 15,
    timeLimit: 240,
    start,
    wind: {
      mean: calm ? 0 : windMean,
      sigma: calm ? 0 : 0.25,
      tau: 6,
      gustRate: calm ? 0 : 1 / 20,
      gustAccelMin: 0.4,
      gustAccelMax: 0.8,
      gustDurationMin: 2,
      gustDurationMax: 5,
    },
    twist,
    sensorNoise: { position: 0.5, velocity: 0.1, wind: 0.15 },
  };
}
