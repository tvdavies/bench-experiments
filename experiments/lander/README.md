# lander: the world moves while you think

A 2D lander must touch down softly on a pad in gusty wind with limited fuel.
The twist versus ordinary game benchmarks: **thinking costs sim time**. While
the pilot reasons, its previous command keeps running.

## What it measures

| Signal | How |
| --- | --- |
| Closed-loop control | Score across seeded scenarios, compared with scripted baselines |
| **Thinking tax** | The same pilot and seeds under the `paused` clock versus the `tokens` clock. The gap is what deliberation costs when the world doesn't wait. |
| Adapting verbosity | Does the pilot shorten its reasoning once it sees each decision took 6 s? (`tokens / decision`, `time thinking`) |
| Noticing silent change | The `twist` set cuts main-engine thrust to 75% partway down, without telling anyone. Compare the `standard` and `twist` scores for the same seeds. |

## The protocol: same information, controls and wording for every pilot

Defined once in [`src/protocol.ts`](src/protocol.ts) and enforced by tests.

- **Information:** every pilot receives the identical JSON observation: task, rules (success criteria, time limit, scoring, the clock rule), coordinate conventions, vehicle spec, the controls, the current instrument readings (time, altitude, offset from the pad, horizontal and vertical speed, fuel, wind estimate), the current command, the previous decision's cost on live clocks, and the last 10 readings with the commands issued. No derived readings.
- **Controls:** every pilot chooses from the same menus: main throttle `0, 0.1 … 1.0` and lateral `-1, -0.75 … 1`. The episode loop snaps every command onto these menus, so no adapter can give a pilot finer control. Baselines included.
- **Wording:** the two questions, "Choose the main engine throttle to command now." and "Choose the lateral thrust to command now.", are written once and used verbatim by every transport.
- **Nothing extra:** no side questions (such as predictions) in the scored run, because on the live clock they would cost some pilots time that others don't pay.
- **Transports:** chat models get the observation as the user message (JSON) and answer through a `control` tool whose parameters are enums of the menus. The system prompt only explains that contract. Jev gets the same observation as `state` and the same questions as `choice` questions over the same menus. The command is the option chosen.

Tests in `test/lander.test.ts` check that chat models and Jev receive the
identical observation, the same question text and the same menus, and that
every recorded command is on the grid.

### Side experiment: Jev with assessment framing

`jev-1.13.0+assess` deliberately breaks the protocol, so it is shown
separately and never ranked. Probing Jev on hand-built states showed it reads
the instruments correctly (it knows when it's climbing) and gets lateral
direction right, but any *action* question about the main engine gets a
strong "more thrust" bias, even while climbing at 8 m/s. The side variant
gives Jev extra derived readings (time to touchdown, fuel endurance at hover)
and asks "is the descent too fast / about right / too slow?", mapped to
throttle relative to hover. It steers much better, but it judges a slow
descent "about right" while fuel is plentiful and only reacts once fuel is
already low, so it runs dry. It's a demonstration of how framing changes Jev,
not a comparable result.

## The sim

- Point mass, no rotation. Main engine gives up to `2g` upward; lateral thrusters give ±1.5 m/s².
- Gravity is 1.6–3.7 m/s². Start altitude is 350–550 m and start offset ±40–160 m, descending at 5–15 m/s.
- Wind is an Ornstein-Uhlenbeck process plus random gusts. The wind estimate is a noisy reading.
- Fuel: 45 units, burning `main + 0.5·|lateral|` per second. Hovering costs 0.5 per second, so a slow, cautious descent runs out.
- Safe landing: `|vy| ≤ 2`, `|vx| ≤ 1`, `|dx| ≤ 15`. Time limit 240 s. Physics step 50 ms.
- The pilot takes over from an autopilot holding hover throttle.
- Wind depends only on seed and sim time, so every pilot on a seed faces identical air. The `calm`, `standard` and `twist` sets share start states per seed.

## Clocks

| Clock | Sim time charged per decision |
| --- | --- |
| `paused` | 0. Classic turn-based play. |
| `tokens` | `output_tokens × ms_per_token` (default 10 ms ≈ 100 tok/s), hidden reasoning included. Provider-neutral. |
| `wall` | Real request latency × `wall_scale`. Realistic, but includes network and gateway queueing. |

After the delay, the new command is held for `--hold` seconds (default 1)
before the next readings. The rule is part of the observation, as is the
previous decision's cost. No pilot is told to be brief.

## Scoring (0–100)

- **Safe landing on the pad:** 70 + up to 15 for fuel left + up to 15 for centring.
- **Other touchdowns:** `50·exp(−severity)`, where severity sums how far `vy`, `vx` and `dx` exceeded the limits. A slightly hard landing beats a lawn dart.
- **Timeout:** 0.
- **Unusable answers** (no parseable choice) count against the pilot; the previous command is held.
- **Infrastructure failures** (four consecutive endpoint errors) abort the episode. It's reported separately and excluded from scores.

## Baselines (protocol menus, seeds 1–5)

| Agent | calm | standard | twist |
| --- | --- | --- | --- |
| `baseline:p` (trusts the spec sheet) | 87.9 (5/5) | 87.0 (5/5) | 25.8 (0/5) |
| `baseline:pi` (integral term adapts) | 87.6 (5/5) | 86.4 (5/5) | 59.9 (3/5) |
| `baseline:noop` | 0 | 0 | 0 |

The twist was tuned so that a controller that doesn't adapt almost always
crashes, while an adaptive one survives about half the time. Descending more
cautiously isn't a free fix either: it burns the fuel budget.

## Running

```bash
# Baselines (instant, no API)
bun run lander --baseline p,pi,noop --set calm,standard,twist --seeds 1-20

# Models: paused vs live clock on the same seeds
bun run lander --model claude-haiku-5-5,gpt-6.1-sol --clock paused,tokens --set standard,twist --seeds 1-5 --label v2-mine

# Jev (Typesafe systemone API, needs JEV_API_KEY); +assess is the side experiment
bun run lander --model jev-1.13.0,jev-1.13.0+assess --clock paused,tokens --seeds 1-5

# Standalone results site from run folders labelled v2 (one self-contained index.html)
bun run lander:site            # -> results/lander/site/public/index.html
bun run lander:site --match v3 # a different run label

# Older single-page report across all runs
bun run lander:report
```

The site (`site/index.html`, `site/styles.css`, `site/app.js`, built by
`src/site.ts`) has a leaderboard with paused, live and thinking-tax columns,
two charts (paused vs live, verbosity vs live), small multiples of every
flight per scenario (path, altitude or vertical speed, with linked
highlighting), and a replay theatre for up to four flights. The output is a
static `public/` folder, so it deploys as-is to myslop apps or any static host.

Output goes to `results/lander/<runId>/`. That folder holds `config.json`,
`summary.json`, and `episodes.jsonl` with full traces: every observation,
command, token count and delay, plus the true trajectory sampled every 0.25 s.

## Notes and known limits

- **History:** v1 (before the protocol) gave chat models a prose briefing with continuous controls and a prediction question, and gave Jev an adapted version of it. Results from v1 are not comparable with v2 and aren't on the site.
- **Context:** each decision is stateless. The observation carries the last 10 readings and commands, which keeps cost bounded and avoids provider-specific tool-call history formats.
- **Model calls:** `tool_choice` is `auto`, because forcing a tool disables extended thinking on some providers. A JSON object in the text is accepted as a fallback. Visible text is kept for the replay only.
- **Severity:** with 10 ms/token, verbose models can lose a flight on a single decision. That is the point, but use `--ms-per-token` to explore the curve rather than a single setting.
- **Token counts:** the token clock relies on the endpoint reporting `completion_tokens`, including reasoning. Check that your gateway does for each provider. Jev reports a fixed output count per request.
