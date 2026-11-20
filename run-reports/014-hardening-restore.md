# Run report 014 — Runner hardening + truncation incident + v3 restore

Date: 2026-11-11. Scope: run 012's hardening follow-ups + evidence recovery.
Verdict: timeouts, latched per-model backpressure trips, and an overwrite
guard landed with tests; a smoke-truncation incident destroyed the v3
row files (findings intact via rescore JSON); deterministic restore
re-ran and verified (0.787 vs 0.781).

## Hardening (all tested, all gated)

- Client timeouts (src/gemini.ts): FetchFn carries AbortSignal; unary
  calls 60s, streams 5min; Abort/Timeout maps to GeminiError 408
  (retryable per existing policy). 4 tests.
- BackpressureTrip (src/retry.ts): latched counter, trips at 10
  consecutive 429s, one instance per model (a live model must not reset
  a dead model's trip). 4 tests. Wired through v3's withRetry: tripped
  calls throw a loud quota-wall abort instead of burning ~21min budgets
  per row (v3's 11-rows/hour crawl, run 012). Inert on healthy runs
  (smoke-verified: same samples, recall 1.000).
- --force overwrite guard on v3 (below): refuses non-empty jsonl.
- Strip-types lesson: parameter properties pass tsc but crash
  --experimental-strip-types at runtime (ERR_UNSUPPORTED_TYPESCRIPT_
  SYNTAX). Convention recorded in code: erasable syntax only in src/
  (runners execute via strip-types; typecheck is blind to this).

## Truncation incident (owned)

- The trip-integration smoke (limit 2) silently truncated
  ir-pilot-v3.jsonl 100 -> 2 rows and overwrote the n=100 summary.
- Lost: row-level IR texts from the original run (no re-adjudication
  of original rows). Intact: ir-pilot-v3-rescored.json (0.781,
  byClass, missRow keys), report 012's quoted evidence, all findings.
- Guard verified refusing (1824-byte file kept); restore relaunched
  with explicit --force.

## Restore verification

- n=100 errors=0 punts=10 (vs 7: temp-0 cross-run drift) recall 0.787
  recallN=90 (vs rescored 0.781/92: delta +0.006, within drift).
  Scored with current extractor: authoritative directly, no rescore.
- byClass: date 7/8, number 124/155, email 1/1, url 2/2 — consistent.
- Tier-1 on restore rows: 0 fails / 90 (the markdown-mangle did not
  recur; screen stable, no false positives).
- Flagship still dead (lone probe 429, fails fast); overlap stays parked.

## Gates

- typecheck 0, lint 0, 181 unit (173 + 4 timeout + 4 trip) + 7 pool.
  Only free APIs + local model; values never logged.
