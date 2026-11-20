# Run report 020 — Provider switch to DeepSeek + caveat fixes

Date: 2026-11-11. Scope: owner "fix the caveats, drop Gemini, use
DeepSeek 4.1 Flash non-reasoning via NIM". Verdict: switch
code-complete (client, config, docs, runner); parity caveat FIXED
(all flips benign, zero regressions); lexical check honestly
DEFERRED (no threshold exists); DeepSeek eval partial at 43 rows
(NIM tier too flaky to finish: 29% transport-fail, 10-min calls) but
directionally perfect (42/43, lone miss benign). Campaign resumable.

## Provider switch (done)

- Model discovered live: `deepseek-ai/deepseek-v4.1-flash` (84 NIM
  models listed). Non-reasoning via top-level `reasoning_effort:
  "none"` (probed: 0 reasoning tokens vs 13 default);
  `extra_body.chat_template_kwargs.enable_thinking` 400s (Qwen key).
- New generic OpenAIChatClient (Bearer, chat/completions, 60s default
  + per-instance override, finish normalization STOP/MAX_TOKENS,
  reasoning-token capture, content-block join). 9 tests. Retry policy
  extended to OpenAIError (same status rules).
- Config: NIM_API_KEY_NAME + NIM_BASE_URL. PLAN/CONTEXT/REPO-RULES
  repointed with provenance. Tokenizer consequence recorded: NIM has
  no countTokens — next ratio measurement must pin a local tokenizer;
  prior Gemini-token ratios stand as non-comparable evidence.
- scripts/nim-expand.ts: same 45 IRs x v0+strict, pacer + per-model
  trip + --force + --resume (added this run), reasoning capture.

## Parity fix (done, caveat 2)

- Validator: numbers multiset (amounts count), all other classes set
  (mentions merge) — diffCountedEntities + 6 tests + PLAN mandate
  amended with evidence. Rationale: only numbers change meaning by
  repetition; phone segments stay multiset (conservative, unobserved).
- Offline rescore (zero API): Gemini 82/83 -> 83/83 (benign merge);
  LFM3 base 23/30 -> 25/30, strict 25/30 -> 26/30, v3 9/15 -> 10/15
  (URL-dot fix taking effect + benign merges). ZERO pass->fail flips.
- New blind spot found (follow-up, not fixed): single-brace typos
  (`{{X)}`) extract as NO entity — invisible to every check.

## Lexical coverage (measured, deferred — caveat 1)

- Content-word recall distributions: v2-good p50 0.30 (p05 0.09),
  v3-good p50 0.78 (p05 0.06), known-bad v1 rows 0.02-0.12. OVERLAP:
  no threshold separates bad compression from good aggressive
  compression (telegraphic IR drops 70% of words by design). NOT
  implemented as a gate — would false-positive routinely. Entity-blind
  drops still need semantic checks (plan's NLI/judge, future work).
  Entity-bearing drops were already covered (validator + ladder).

## DeepSeek eval (partial 43/90, tier-blocked)

- Two aborts (error budget on transport flakiness, then quota-wall
  trip design verified earlier): 10 + 7 fetch-fails (~29%), all
  `fetch failed` transport drops, zero 429s. Calls take 250s-13min
  when the tier degrades. Campaign resumable in a better window.
- On 43 clean rows: v0 20/20, strict 22/23, zero leaks, zero
  reasoning tokens (non-reasoning held everywhere). Lone miss:
  brace-strip on tracking/order ask (content intact — benign,
  same class as Gemini's v2 misses). TRUE content fidelity 43/43.
- vs Gemini (83/83 rescored): statistical tie on quality; latency
  incomparable (free-tier queueing vs 2s). Switch QUALITY-CLEARED,
  reliability pending a usable tier (paid or recovered window).

## Harness bugs fixed (both clients + runner)

- Timeout mapping missed undici's HeadersTimeoutError (name check too
  narrow) — sick calls mislabeled as generic fetch failures. Now
  /timeout/i + AbortError, both clients, +2 tests.
- Runner timeout configurable per instance; NIM runs at 600s (250s+
  successes observed). Error budget tolerates 1 failure on tiny runs
  (no statistical meaning; 10% still binds at scale).
- --resume support (keep clean, retry errors, whole-file summary).

## Gates

- typecheck 0, lint 0, 201 unit (184 + 17: client/retry/timeout/parity)
  + 7 pool. Free APIs only (NIM + local); values never logged.
