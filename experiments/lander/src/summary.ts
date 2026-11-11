import { ci95, mean, round } from "@bench/core";
import type { EpisodeResult } from "./episode.ts";

export interface SummaryRow {
  agent: string;
  clock: string;
  set: string;
  episodes: number;
  /** Episodes dropped because the model endpoint failed. */
  infraErrors: number;
  meanScore: number;
  scoreCi95: number;
  landed: number;
  crashed: number;
  missedPad: number;
  timeouts: number;
  meanThinkingShare: number;
  meanDelaySeconds: number;
  outputTokensPerDecision: number;
  invalidRate: number;
  verticalSpeedMae: number | null;
  verticalSpeedMaeBeforeTwist: number | null;
  verticalSpeedMaeAfterTwist: number | null;
}

const avg = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? round(mean(v)) : null;
};

export function summarise(results: EpisodeResult[]): SummaryRow[] {
  const groups = new Map<string, EpisodeResult[]>();
  for (const r of results) {
    const key = `${r.agent}\u0000${r.clock.mode}\u0000${r.scenario.set}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((all) => {
    const first = all[0] as EpisodeResult;
    const rs = all.filter((r) => !r.infraError);
    const count = (kind: string) => rs.filter((r) => r.outcome.kind === kind).length;
    const scores = rs.map((r) => r.outcome.score);
    const decisions = rs.reduce((a, r) => a + r.metrics.decisions, 0);
    return {
      agent: first.agent,
      clock: first.clock.mode,
      set: first.scenario.set,
      episodes: rs.length,
      infraErrors: all.length - rs.length,
      meanScore: round(mean(scores)),
      scoreCi95: round(ci95(scores)),
      landed: count("landed"),
      crashed: count("crashed"),
      missedPad: count("missed-pad"),
      timeouts: count("timeout"),
      meanThinkingShare: round(mean(rs.map((r) => r.metrics.thinkingShare)), 3),
      meanDelaySeconds: round(mean(rs.map((r) => r.metrics.meanDelaySeconds))),
      outputTokensPerDecision: decisions ? Math.round(rs.reduce((a, r) => a + r.metrics.outputTokens, 0) / decisions) : 0,
      invalidRate: decisions ? round(rs.reduce((a, r) => a + r.metrics.invalidDecisions, 0) / decisions, 3) : 0,
      verticalSpeedMae: avg(rs.map((r) => r.metrics.verticalSpeedMae)),
      verticalSpeedMaeBeforeTwist: avg(rs.map((r) => r.metrics.verticalSpeedMaeBeforeTwist)),
      verticalSpeedMaeAfterTwist: avg(rs.map((r) => r.metrics.verticalSpeedMaeAfterTwist)),
    };
  });
}

export function formatTable(rows: SummaryRow[]): string {
  const header = ["agent", "clock", "set", "n", "score", "±95%", "landed", "crash", "miss", "t/o", "think%", "tok/dec", "vyMAE", "infra"];
  const body = rows.map((r) => [
    r.agent,
    r.clock,
    r.set,
    String(r.episodes),
    r.meanScore.toFixed(1),
    r.scoreCi95.toFixed(1),
    String(r.landed),
    String(r.crashed),
    String(r.missedPad),
    String(r.timeouts),
    (r.meanThinkingShare * 100).toFixed(0),
    String(r.outputTokensPerDecision),
    r.verticalSpeedMae === null ? "-" : r.verticalSpeedMae.toFixed(2),
    String(r.infraErrors),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] as string).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] as number)).join("  ");
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}
