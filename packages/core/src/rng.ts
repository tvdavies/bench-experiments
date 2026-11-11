/**
 * Deterministic randomness. Every experiment should derive all of its
 * randomness from a seed so that runs are reproducible and different
 * agents face exactly the same world.
 */

/** FNV-1a 32-bit hash over the string form of the parts. */
export function hashSeed(...parts: Array<number | string>): number {
  const text = parts.join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small, fast, good-enough PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  float(): number {
    return this.next();
  }

  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Inclusive integer range. */
  int(min: number, max: number): number {
    return Math.floor(this.uniform(min, max + 1));
  }

  sign(): 1 | -1 {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick() on empty array");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Standard normal via Box-Muller. */
  normal(): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/**
 * Stateless standard-normal noise keyed by its inputs. Useful for sensor
 * noise that should depend only on (seed, time, channel), not on how many
 * times an agent happened to look.
 */
export function noiseAt(...parts: Array<number | string>): number {
  return new Rng(hashSeed(...parts)).normal();
}
