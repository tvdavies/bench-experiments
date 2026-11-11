import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Repository root, so every experiment writes to the same results/ tree. */
export const REPO_ROOT = resolve(import.meta.dir, "../../..");

export function resultsDir(experiment: string, runId: string): string {
  const dir = resolve(REPO_ROOT, "results", experiment, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Sortable, filesystem-safe run id, e.g. 2026-11-11T14-03-22-label. */
export function makeRunId(label?: string): string {
  const stamp = new Date().toISOString().replace(/\..+$/, "").replace(/:/g, "-");
  return label ? `${stamp}-${slug(label)}` : stamp;
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export class JsonlWriter {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }

  write(record: unknown): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Parse "1-5", "1,3,9" or "1-3,10" into a list of integers. */
export function parseSeeds(spec: string): number[] {
  const seeds: number[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      for (let s = lo; s <= hi; s++) seeds.push(s);
    } else if (/^\d+$/.test(part)) {
      seeds.push(Number(part));
    } else {
      throw new Error(`Bad seed spec: ${part}`);
    }
  }
  return seeds;
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Run async tasks with bounded concurrency, preserving result order. */
export async function pool<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await (tasks[index] as () => Promise<T>)();
    }
  });
  await Promise.all(workers);
  return results;
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const round = (value: number, places = 2): number => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};
