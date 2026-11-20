# Run report 026 — Trip rework + top-up 90/90 + production cutover

Date: 2026-11-12. Scope: finish the top-up, fix the trip design the
top-up broke, and cut production serving to DeepSeek. Verdict: Gemini
baseline complete at 90/90 (both arms 1.000); trip is now time-window
+ per-call-latency (count-trips proven unable to separate throttles
from dead quota); app/index/env serve NIM through a provider-neutral
client interface; live end-to-end expansion verified (200, all 4
checks green).

## Trip rework (run 014 design invalidated by evidence)

- The count-10 trip misfired on a recovering lite throttle (16 clean
  rows, then abort with zero row-errors). Analysis: counts cannot
  separate a 60s full outage (100+ consecutive 429s at 4 workers) from
  a dead quota, and successes reset any count (v3's 11-rows/hour crawl
  would never trip). Only time distinguishes.
- New design: 5-min zero-success window trip (dead quota) + 10-min
  per-call burn ceiling (slow-sick crawl). Known hole, documented:
  limping quota (all calls slow-but-successful) trips neither —
  symptom is a very slow run. BackpressureTrip reworked with fake-timer
  tests; v3/nim/gemini runners converted (messages, latency check).
- gemini-expand gained --resume (mirrors nim): clean rows kept, errors
  retried, whole-file summary.

## Top-up: 90/90

- Relaunch completed clean: v0 45/45, strict 45/45, zero leaks, p50
  ~2.2s. The trip never fired (quota healthy). Combined with run 016:
  Gemini expander 90/90 rescored-perfect. Lite quota fully recovered.

## Production cutover (serving path)

- `ExpanderClient` structural interface (both clients satisfy via
  method bivariance); usage unified on TokenUsage vocabulary at the
  OpenAI boundary (completion→candidates mapping, documented).
- app.ts: `deps.gemini` -> `deps.llm`, NIM secret, non-reasoning
  extraBody on expand + regen paths. index.ts builds OpenAIChatClient
  from `NIM_API_KEY`; env.ts binding renamed. app tests converted to
  scripted OpenAI fixtures (1 expectation updated for the rename).
- Latent find: state.ts had the repo's only remaining parameter
  property (rejected by strip-types) — fixed with explicit field.
- LIVE PROOF: real handleExpand through NIM (162s tier): 200, direct
  path, all 4 checks pass, usage counters flow in unified vocabulary.

## Gates

- typecheck 0, lint 0, 211 unit + 7 pool (retry rewrite net zero).
  Free APIs only; values never logged.
