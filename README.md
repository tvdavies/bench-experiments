# bench-experiments

A monorepo of small, unusual LLM benchmarks: simulators and environments that
measure things static Q&A benchmarks don't. Examples are closed-loop control,
the cost of thinking time, noticing that the world has quietly changed, and
long-horizon judgement.

Each experiment is small, deterministic given a seed, provider-neutral, and
paired with dumb hand-written baselines. A model's score is only meaningful
next to "what does a 20-line controller get?".

## Experiments

| Experiment | Measures | Status |
| --- | --- | --- |
| [`lander`](experiments/lander) | Real-time control when **the world keeps moving while the model thinks**, plus silent engine failure and predictive accuracy | v0.1 |

## Layout

```text
packages/
  core/            shared: OpenAI-compatible model client, seeded RNG, results IO, stats
experiments/
  <name>/
    src/           sim, agents, CLI, report
    test/          bun tests (no network)
    README.md      what it measures, scoring, how to run, findings
results/           gitignored run output: results/<experiment>/<runId>/
```

## Setup

```bash
bun install
cp .env.example .env     # set BENCH_BASE_URL and BENCH_API_KEY
bun test
bun run typecheck
```

Models are called through any **OpenAI-compatible Chat Completions** endpoint
(`BENCH_BASE_URL`, default `http://127.0.0.1:8317/v1`). That can be a local
gateway such as CLIProxyAPI or LiteLLM, or OpenRouter, vLLM, LM Studio and so
on. Model ids are whatever that endpoint accepts. Bun loads `.env`
automatically.

## Adding an experiment

1. Create `experiments/<name>/` with a `package.json` depending on `"@bench/core": "workspace:*"`.
2. Make the world **deterministic from a seed**, using `Rng`, `hashSeed` and `noiseAt` from core. Different agents on the same seed must face the same world.
3. Ship **baselines** (scripted, no model) and a **floor** (do-nothing or random).
4. Treat **infrastructure errors as distinct from agent failures**. Drop the episode and report it; don't score it as a loss.
5. Write raw traces to `results/<name>/<runId>/episodes.jsonl` and a `summary.json`, using `resultsDir`, `JsonlWriter` and `writeJson`.
6. Add tests that run without network access, using scripted agents in place of models.
7. Add a root `package.json` script and a row in the table above.

## Design principles

- **Unmemorisable.** Scenarios are procedurally generated, so there's no answer to recall.
- **Continuous scores.** Partial credit beats pass/fail for telling models apart.
- **Measure the interface, not just the outcome.** Log tokens, latency, invalid outputs and predictions. The interesting finding is often *why* a model lost.
- **Don't let the text encoding be the test.** Keep observations compact and unambiguous.
- **Several seeds, with confidence intervals.** Single episodes are anecdotes.
