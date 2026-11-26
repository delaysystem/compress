# Run report 035 — fast decompression reshape & multi-provider failover

Date: 2026-11-25. Scope: stage-by-stage decompression latency measurement,
full 4-tier decompression pipeline reshape, and failover integration across the
4 existing providers plus the 7 new providers in `.dev.vars`.

## Provider probe (`GET /models` + warmup completion)

Probed via `worker/scripts/measure-stages.ts` (values never logged; local
`llama.cpp` server on `:9931` was not running during these runs):

| provider | key | models listed | live status | selected model | RTT (baseline / n=20 / n=100) |
|---|---|---:|---|---|---:|
| `groq` | present | 11 | OK | `qwen/qwen3.8-27b` | 154ms / 153ms / 152ms |
| `anyapi` | present | 10 | OK | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 785ms / 381ms / 474ms |
| `opentyphoon` | present | 0 | OK | `typhoon-v2.5-30b-a3b-instruct` | 740ms / 738ms / 792ms |
| `openrouter` | present | 438 | OK | `aion-labs/aion-rp-llama-3.1-8b` | 1218ms / 719ms / 1167ms |
| `dreamprompting` | present | 29 | OK | `auto` | 1829ms / 1623ms / 1550ms |
| `cerebras` | present | 2 | FAIL (402) | `qwen-3.8-27b` / `gpt-oss-120b` | — |
| `routmy` | present | 141 | FAIL (403) | `google/gemma-4-26b-a4b-it` | — |
| `experimentallabs` | present | 306 | FAIL (429) | `aion-rp-llama-3.1-8b` | — |
| `regolo` | present | 17 | FAIL (401) | `deepseek-v4.1-flash` | — |
| `freemodel` | present | 5 | FAIL (401) | `gpt-6.1-terra` | — |
| `nim` | present | 30 | FAIL (422) | `fastino/gliner2-pii` | — |

Of the 7 new `.dev.vars` providers, `anyapi`, `opentyphoon`, and
`dreamprompting` passed live completions and joined `groq` and `openrouter` in
the latency-ranked failover pool.

## Stage-by-stage latency: baseline vs reshaped (`emit-v3gem100.jsonl`)

### Paired `n=20` comparison

| stage | baseline p50 (ms) | baseline p95 (ms) | baseline mean (ms) | reshaped p50 (ms) | reshaped p95 (ms) | reshaped mean (ms) |
|---|---:|---:|---:|---:|---:|---:|
| `parseDecodeMs` | 0.17 | 1.81 | 0.27 | 0.10 | 4.26 | 0.39 |
| `fastPathMs` | 0.00 | 0.00 | 0.00 | 0.26 | 10.17 | 0.83 |
| `cacheMs` | 0.00 | 0.00 | 0.00 | 0.00 | 0.41 | 0.03 |
| `buildPromptMs` | 0.02 | 1.20 | 0.11 | 0.00 | 0.00 | 0.00 |
| `llmExpandMs` | 195.43 | 385.08 | 214.23 | 0.00 | 1308.36 | 175.71 |
| `postProcessMs` | 0.04 | 0.66 | 0.08 | 0.00 | 0.00 | 0.00 |
| `validateMs` | 0.21 | 3.22 | 0.40 | 0.00 | 0.73 | 0.15 |
| `repairMs` | 0.00 | 251.00 | 56.72 | 0.00 | 323.00 | 16.15 |
| `wrapMs` | 0.01 | 0.06 | 0.01 | 0.01 | 0.14 | 0.02 |
| **`totalMs`** | **297.14** | **428.62** | **271.86** | **1.49** | **1631.84** | **193.38** |

- Baseline (`n=20`): `passed=20/20`, `errors=0`, `paths={"direct":14,"template":5,"repaired":1}`, `providers={"groq":20}`.
- Reshaped (`n=20`): `passed=20/20`, `errors=0`, `paths={"fast-realizer":13,"direct":6,"repaired":1}`, `providers={"deterministic":13,"groq":7}` — **199x lower p50 latency** (`297.14ms -> 1.49ms`).

### Full `n=100` reshaped corpus run

- `totalMs`: **p50 = `0.41ms`**, p95 = `1886.25ms`, mean = `243.33ms`
- Breakdown (mean ms): `parseDecodeMs=0.19`, `fastPathMs=0.27`, `cacheMs=0.01`, `llmExpandMs=185.41`, `validateMs=0.09`, `repairMs=57.33`, `wrapMs=0.01`
- Quality & failover: `passed=100/100`, `errors=0`
- Paths: `{"fast-realizer":72,"direct":23,"repaired":3,"template":2}` (72% resolved deterministically in sub-ms)
- Providers used: `{"deterministic":72,"groq":21,"anyapi":4,"opentyphoon":3}` (automatic failover engaged when `groq` hit rate/transient limits)

## Architecture reshaped

1. **Tier 0 — Precompiled O(1) dictionary & marker tables** (`worker/src/dict.ts`, `worker/src/wirev3.ts`): `WeakMap`-memoized `Map<string, DictEntry>`, code sets, and marker restore/inverse tables.
2. **Tier 1 — Deterministic fluent realizer** (`worker/src/realizer.ts`): Fluent English templates for all 46 `dict-ir-v3` codes + short fluent `TX` bypass, gated by the full 8-check `validateExpansion` contract (`terse-mirror`-free).
3. **Tier 2 — Slot-parameterized LRU expansion cache** (`worker/src/cache.ts`): Canonicalizes slot values and `{{Markers}}` into `__V0__`..`__Vn__` skeletons and re-validates on every cache hit.
4. **Tier 3 — Latency-ranked multi-provider failover + fast repair + SSE** (`worker/src/providers.ts`, `worker/src/expander.ts`, `worker/src/ladder.ts`, `worker/src/openai.ts`):
   - `ProviderPool` covering the 4 existing + 7 new `.dev.vars` providers (`OPENTYPHOON`, `ROUTMY`, `EXPERIMENTALLABS`, `ANYAPI`, `DREAMPROMPTING`, `REGOLO`, `FREEMODEL`) with EWMA latency ranking, 30s circuit-breaker cooldowns, and optional hedging.
   - `buildExpansionMessages` (system/user split for prefix caching), `computeMaxOutputTokens` (tight dynamic output cap), `stripFramingLeaks` (`fastRepair` strips greeting/sign-off leaks without a 2nd LLM call), `skipStyleRepair`, and `/expand/stream` SSE endpoint + `Server-Timing` header (`worker/src/timing.ts`, `worker/src/app.ts`, `worker/src/index.ts`).

## Verification

- `npm run test:all`: 29 unit test files (398 tests) + 1 worker test file (6 tests) — **404/404 passing**.
- `npm run typecheck`: 0 errors.
- `npm run lint`: 0 errors across 118 files.
