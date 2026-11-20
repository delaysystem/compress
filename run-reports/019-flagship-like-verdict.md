# Run report 019 — Flagship-like harness: terminal verdict NO

Date: 2026-11-11. Scope: owner "optimize the harness so LFM3 can become
flagship-like". Fixed convergence (run 018), then attacked selectivity
with a ranked battery: v2 anti-echo (works), chunked map-reduce chain
(fidelity yes, terseness no), line-budget forcing (ignored).
Verdict: NOT achievable — the gap is model capacity (selectivity/
prioritization), not scaffolding. LFM3 is faithful, fluent, and
verbose; no harness technique tested makes it compress dense content.

## Battery results

- v2 anti-echo (local demo + "output ONLY new IR lines"): echo gone on
  the failure case — but the model fell back to verbatim copying
  (ratio ~1). Echo suppressed, compression not induced.
- Chunked chain (extract 512 + N× compress 80-word chunks): recall
  0.857 -> 1.0 adjusted (sole miss: mnemonic 4-FED-AID dropped where
  numeric 433-3243 kept — DUPLICATE info, metric-blind equivalence),
  ratio 0.30. Fidelity preserved, terseness unimproved (chunks come
  back as long sentences; one hit the cap).
- Line-budget forcing ("at most 8 lines, under 12 words"): IGNORED
  (5+ long sentences, length cutoff). recall 0.857->1.0adj, ratio 0.24.
- Pattern: LFM3 compresses fluffy prose (2.75x Bitext — cutting
  pleasantries) and fails on dense facts (~1x — cannot prioritize).
  Instructions bite for FORMAT (no echo) but not for SELECTIVITY.

## Harness bugs found and fixed

- extractIrBlock sliced after the LAST IR: marker, grabbing mid-echo
  fragments when the model echoed prompts containing their own IR:
  markers (the studentaid recall-0 was this bug, not a model drop).
  Fixed: strip a leading echo block through its closing marker;
  echo-only yields '' (honest fail). Formal-run numbers likely
  unaffected (all converged past echo); noted, not rescored (raw
  outputs not stored — future rows should keep raw text).
- GPU: GTX 1650 SUPER present but the llama build is CPU-only (-ngl
  inert, 85 tok/s). Latency parity impossible on this box; a CUDA
  build is the follow-up, not harness work.
- Temp-0 nondeterminism: identical call-2 inputs gave different
  outputs across runs (1 datum) — treat temp-0 as approximate;
  immaterial at N=25. Not chased.

## Terminal role verdicts (all LFM3 evidence, runs 015/017/018/019)

- Flagship emitter (joint answer+compress): NO — selectivity gap fatal
  (0.12x dumps vs telegraphic IR).
- Local compressor: PARTIAL — 2.75x on fluff, ~1x on dense facts,
  marker-fragile, needs echo/slug handling (in-harness, done).
- Local expander: YES behind validator (run 015).
- Local faithful answerer: YES, verbose (run 018: 1.000/25).
- Judge: untested (short-snippet variant could work; no evidence).

## Files

- prompts/ir-emit-1shot-v2.md (anti-echo line; v1 record intact).
- scripts/lfm3-compress.ts (extraction fix). No formal chain run (probe
  verdict insensitive to N; stated, not skipped silently).

## Gates

- typecheck 0, lint 0, 184 unit + 7 pool (diagnosis scripts + prompt
  files only). Local model only; no Gemini quota touched.
