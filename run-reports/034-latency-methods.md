# Run report 034 — expander latency: methods tried and measured

Date: 2026-11-21. Scope: local LFM3-v13b expander on the 4-core dev box
(Intel i5-4570S, no GPU). Question: which levers actually cut wall latency?

## Harness

`worker/scripts/latency-bench.ts`: fixed 20-prompt set (the `prepared` drafts
that produced `lfm3ftv13b-v3gem100.jsonl`), concurrency 1, temperature 0,
`max_tokens 512`, one warmup request per server start. Wall time measured at
the client. Percentiles use the project convention `floor(p*n)` on sorted
samples (`ireval.percentile`). Raw per-request times banked in
`/tmp/opencode/latency-results.jsonl.raw`.

A background `beam.smp` process held ~1 core throughout; baseline p50 drifted
monotonically 7.1s -> 9.8s over the session. All comparisons therefore use a
baseline re-run bracketed around the method, plus the pooled baseline.

## Result: what worked

| method | p50 ms | p95 ms | vs pooled baseline | vs bracketed baseline |
|---|---:|---:|---:|---:|
| baseline (5 runs, n=100) | 7605 | 15219 | 1.00x | 1.00x |
| **compact prompt** | 5975 | 17477 | **1.27x** | ~1.5x |
| minimal prompt (draft only) | 5993 | 15744 | **1.27x** | ~1.5x |
| short prompt (DRAFT only) | 6202 | 19637 | 1.23x | ~1.4x |
| **flash attention (`-fa on`)** | 6800 | 17303 | **1.12x** | ~1.4x |

p95 is outlier-dominated and noisy; the bracketed p95 for compact/flash
(17.5s / 17.3s) is slightly below the neighbouring baselines (18.5s / 17.6s).

## Result: what did not work

| method | p50 ms | vs baseline | verdict |
|---|---:|---:|---|
| speculative draft (`-md lfm25-230m-q40`) | 8299 | 0.92x | slower: draft overhead > acceptance gain on CPU |
| flash + kv-q8 + draft (combo) | 7883 | 0.96x | no gain over flash alone |
| `-ctk q8_0 -ctv q8_0` alone | — | — | invalid: "quantized V cache requires flash_attn" |
| v12 iq3xs | 13725 | 0.55x | slow; IQ dequant dominates |
| v12 iq2xs / q4km / q40 | 6352-7338 | ~1.0-1.2x | within noise, different model version |

## The dominant lever: `-rea off`

Without `-rea off`, the v13b model never emits EOS and generates the full
512-token cap: measured p50 80.6s / 110.4s in two pilots (512 completion
tokens). With `-rea off` it stops at ~32-81 tokens, ~7s p50. This is a
15-20x effect and dwarfs every other method. `README.md` already documents
the flag; `worker/scripts/serve-expander.sh` now pins it so it cannot be lost.

## Interpretation

On 4 CPU cores this workload is **decode-bound at ~7-14 tok/s**, not purely
prefill-bound as run-report 027 concluded for the Qwen box. Cutting the prompt
from ~142 to ~50 tokens buys 20-27% because prefill is 4-34 ms/token when the
prefix cache misses. Shrinking the *output* helps more: compact mode also
produced 69 vs 81 completion tokens, so part of its gain is shorter replies.
Flash attention is a free, quality-neutral 1.1-1.4x and is now the default in
the serve script. Speculative decoding is a loss on this hardware.

## Defaults flipped + validation (2026-11-21, late)

Both winners are now the default:
- `config.EXPANSION_PROMPT_MODE = 'compact'` (set to `'full'` to revert).
- `worker/scripts/serve-expander.sh` runs `-rea off --jinja -fa on`.

Live A/B on the same 20 prompts, sequential under heavy box load:
| config | p50 ms | p95 ms | validator direct pass |
|---|---:|---:|---:|
| old default (full prompt, `-fa off`) | 24492 | 71681 | 18/20 |
| **new default (compact, `-fa on`)** | **17499** | 68540 | 18/20 |

1.40x lower p50; quality parity (the two failures differ in class —
`no-greeting` x2 vs `entity-parity`+`no-greeting` — but pass count is equal,
and the ladder still handles any direct failure downstream). Absolute times
are inflated by a background process holding ~1 core; the earlier quiet-box
numbers (7.6s -> 6.0s) are the better estimate of steady-state.

## Changes shipped

- `worker/scripts/serve-expander.sh` — canonical server flags (`-rea off`,
  `--jinja`, `-fa on`), documents rejected flags.
- `worker/scripts/latency-bench.ts` — reproducible controlled benchmark with
  `full|compact|short|minimal` prompt modes (unset mode = config default).
- `worker/scripts/measure-p50-p95.ts` — offline p50/p95 from recorded eval rows.
- `worker/scripts/quality-check.ts` — validator pass rate over captured replies.
- `config.EXPANSION_PROMPT_MODE` + `buildExpansionPrompt(..., compact)` —
  compact rules (~50 vs ~142 prompt tokens), default `compact`.
- 380 unit + 6 worker tests pass; typecheck and lint clean.

## Next step

Run the full 100-row paired quality eval (recall + template-fallback rate, not
just direct validator pass) to confirm the compact default at production
scale. If recall regresses, revert `EXPANSION_PROMPT_MODE` to `'full'`; `-fa on`
is quality-neutral and stays.
