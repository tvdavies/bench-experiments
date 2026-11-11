# lander: the world moves while you think

A 2D lander must touch down softly on a pad in gusty wind with limited fuel.
The twist versus ordinary game benchmarks: **thinking costs sim time**. While
the model reasons, its previous command keeps running.

## What it measures

| Signal | How |
| --- | --- |
| Closed-loop control | Score across seeded scenarios, compared with scripted baselines |
| **Thinking tax** | The same model and seeds under the `paused` clock versus the `tokens` clock. The gap is what deliberation costs when the world doesn't wait. |
| Adapting verbosity | Does the model shorten its reasoning once it's told each decision took 6 s? (`tok/decision`, `thinking %`) |
| Noticing silent change | The `twist` set cuts main-engine thrust to 75% partway down, without telling the model. Compare vertical-speed prediction error before and after. |
| World-model accuracy | Every command carries a prediction of altitude and vy 5 s ahead, scored against the true trajectory |

## The sim

- Point mass, no rotation. Main engine gives up to `2g` upward; lateral thrusters give ±1.5 m/s².
- Gravity is 1.6–3.7 m/s². Start altitude is 350–550 m and start offset ±40–160 m, descending at 5–15 m/s.
- Wind is an Ornstein-Uhlenbeck process plus random gusts. `wind_estimate` is a noisy reading.
- Fuel: 45 units, burning `main + 0.5·|lateral|` per second. Hovering costs 0.5 per second, so a slow, cautious descent runs out.
- Safe landing: `|vy| ≤ 2`, `|vx| ≤ 1`, `|dx| ≤ 15`. Time limit 240 s. Physics step 50 ms.
- The model takes over from an autopilot holding hover throttle.
- Wind depends only on seed and sim time, so every agent on a seed faces identical air. The `calm`, `standard` and `twist` sets share start states per seed.

## Clocks

| Clock | Sim time charged per decision |
| --- | --- |
| `paused` | 0. Classic turn-based play. |
| `tokens` | `output_tokens × ms_per_token` (default 10 ms ≈ 100 tok/s), hidden reasoning included. Provider-neutral. |
| `wall` | Real request latency × `wall_scale`. Realistic, but includes network and gateway queueing. |

After the delay, the new command is held for `--hold` seconds (default 1) before
the next telemetry. The model is told the rule in its system prompt and sees
how long its last decision took. It is never told to be brief.

## Scoring (0–100)

- **Safe landing on the pad:** 70 + up to 15 for fuel left + up to 15 for centring.
- **Other touchdowns:** `50·exp(−severity)`, where severity sums how far `vy`, `vx` and `dx` exceeded the limits. A slightly hard landing beats a lawn dart.
- **Timeout:** 0.
- **Infrastructure failures** (four consecutive endpoint errors) abort the episode. It's reported separately and excluded from scores.

## Baselines (20 seeds)

| Agent | calm | standard | twist |
| --- | --- | --- | --- |
| `baseline:p` (trusts the spec sheet) | 88.2 (20/20) | 87.3 (20/20) | 24.1 (0/20) |
| `baseline:pi` (integral term adapts) | 88.0 (20/20) | 86.9 (20/20) | 54.5 (11/20) |
| `baseline:noop` | 0 | 0 | 0 |

The twist was tuned so that a controller that doesn't adapt almost always
crashes, while an adaptive one survives about half the time. Descending more
cautiously isn't a free fix either: it burns the fuel budget.

## First look (2026-11-11, `standard` set, seeds 1–3, 10 ms/token)

| Model | Paused | Tokens clock | Tokens per decision | Failure mode |
| --- | --- | --- | --- | --- |
| claude-sonnet-5-5 | **81.3** (3/3 landed) | 0.0 (0/3) | ~700–900 | Live: each decision costs 5–10 s, so corrections arrive late. It overshoots the pad by about 340 m, burns its fuel correcting, and falls. |
| claude-haiku-5-5 | 70.3 (2/3; the third touched down at vx 1.38) | 0.0 (0/3) | ~3,200–3,500 | Live: the first decision alone takes about 27 s, which is the whole flight. |
| gpt-5.6-luna | 0.0 (0/3) | 0.0 (0/3) | ~420 | Over-cautious even when paused: brakes to a hover high up, creeps down at 1–3 m/s, runs dry at 52–66 s and falls. |
| jev-1.13.0 | 0.0 (0/3) | 0.0 (0/3); wall 0.0 (0/3) | 131 (fixed), ~150 ms | Fast, but its vertical control is backwards. Lateral commands track drift sensibly (corr with vx ≈ −0.83), but main throttle averages 0.65–0.68, above the 0.5 hover, and rises slightly as it climbs. It ascends to 800–3,500 m, runs dry at about 50 s and falls. |

Three seeds is an anecdote, not a result. The point is that the experiment
separates *can fly* (paused) from *can fly in time* (tokens), and the replay
shows which failure is which. Next steps: more seeds, a sweep over
`--ms-per-token`, the `twist` set, and reasoning models at several effort levels.

## Running

```bash
# Baselines (instant, no API)
bun run lander --baseline p,pi,noop --set calm,standard,twist --seeds 1-20

# Models: paused vs live clock on the same seeds
bun run lander --model claude-haiku-5-5,gpt-5.6-luna --clock paused,tokens --set standard --seeds 1-5

# Reasoning effort, gentler token clock, the twist set
bun run lander --model gpt-6.1-sol --reasoning-effort low --clock tokens --ms-per-token 4 --set twist --seeds 1-5

# HTML report across all runs (latest result wins per agent/clock/scenario)
bun run lander:report
```

Output goes to `results/lander/<runId>/`. That folder holds `config.json`,
`summary.json`, and `episodes.jsonl` with full traces: every observation,
command, prediction, token count and delay, plus the true trajectory sampled
every 0.25 s.

## Notes and known limits

- **Replay:** `bun run lander:report` builds `results/lander/report.html`. It animates any flight against another on the same scenario, with a timeline of thinking versus acting, the model's notes, and predicted versus actual state.
- **Context:** each decision is stateless. The model gets the system prompt plus the last 10 telemetry rows and its commands. That keeps cost bounded and avoids provider-specific tool-call history formats.
- **Jev:** model ids starting `jev-` go to Typesafe's `/v1/systemone` API using `JEV_API_KEY`, not to the chat endpoint. Jev answers only probabilistic questions, so each decision asks two `choice` questions (main throttle in 0.25 steps, lateral in 0.5 steps) and commands the probability-weighted mean. It makes no 5 s predictions. Only synthetic telemetry is sent.
- **Model calls:** commands come via a `control` tool call, falling back to a JSON object in the text. `tool_choice` is `auto`, because forcing a tool disables extended thinking on some providers.
- **Severity:** with 10 ms/token, verbose models can lose a flight on a single decision. That is the point, but use `--ms-per-token` to explore the curve rather than a single setting.
- **Token counts:** the token clock relies on the endpoint reporting `completion_tokens`, including reasoning. Check that your gateway does for each provider.
