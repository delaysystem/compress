# Run report 025 — Deliberation stripper: Qwen 0.467 -> 0.667

Date: 2026-11-12. Scope: fix Qwen's deliberation exhaust (run 023)
after the technique probe failed 0/3 (suffix ignored, prefill ignored,
sampling persists). Discovery: Qwen delimits with `</think>` before a
clean answer — strip everything through the last tag. Rescore: 42/90
-> 60/90 with zero regressions. Remaining fails are ALL truncation
(deliberation exceeding budget before answering).

## Mechanism (eyeballed full replies)

- Every Qwen reply opens with raw deliberation ("We need answer
  user's request... Could say:...") and — when it fits — closes with
  `</think>` followed by a short, fluent, faithful answer. 62/90 rows
  contain the tag (median 129 post-tag chars); post-tag samples are
  clean expansions with entities exact.
- 28 rows never reach the tag (512 cap burns on deliberation): no
  answer exists, completeness fails them correctly.
- Contrast LFM3 (0/25 tags, unbounded) vs Qwen (62/90 tags, bounded
  ~200-400 deliberation tokens, then answers). Deliberation discipline
  differs by model; the strip exploits Qwen's delimiter, not LFM3's.

## Fix: stripThinkBlocks in expand()

- `stripThinkBlocks` (expander.ts): text after the LAST `</think>`,
  else unchanged. Wired into `expand()` so the ladder validates
  exactly what ships (usage still counts deliberation tokens:
  honest cost). No-op for non-deliberating models (Gemini verified
  83/83 tag-free). +4 tests.
- Rescore (offline, zero API): 60/90 (0.667), 18 flips all false->true
  (deliberation-quote extras gone, clean answers underneath).
- Residual fails: 30 completeness (truncated, no answer) + 12 parity
  (ALL co-occurring with truncation — zero parity fails among
  finished answers) + 2 well-formedness. Completed Qwen answers are
  entity-perfect; the sole failure mode is deliberation length.
- Recommended next measurement (not run): 1024 cap rerun should
  convert most truncated rows (deliberation is bounded); costs one
  GPU kernel (~1.5h). Owner call.

## Technique-probe postmortem (0/3, all informative)

- /no_think: model notices the suffix ("likely wants no thinking?")
  and keeps deliberating — compulsive, not controllable.
- Content-anchored prefill: ignored (llama-server chat template
  doesn't honor trailing assistant prefill for untagged flow).
- temp 0.3: persists (attractor, not greedy artifact).

## Gates

- typecheck 0, lint 0, 211 unit (207 + 4) + 7 pool. No live calls.
