# Run report 023 — Qwen3.8-27B expansion eval: 0.467, deliberation disease

Date: 2026-11-12. Scope: in-kernel generation (90 replies) + local TS
validation of Qwen3.8-27B-GSQ-IQ3 as expander. Verdict: 21/45 per arm
(0.467) — every miss is deliberation exhaust (meta-reasoning quoted
into replies + cap truncation), zero content drops observed. Same
disease as LFM3, different surface (raw meta-text, no think tags).
Determinism proven (45/45 byte-identical pairs). Fix campaign (run 025)
tests /no_think, content-anchored prefill, and sampling.

## Numbers

- 90/90 rows, 0 errors. v0 21/45, strict 21/45 (arms byte-identical:
  temp-0 deterministic + prompts unified since v1 adoption).
- Fail classes: 15 completeness (MAX_TOKENS truncation), 16 entity
  extras, 2 well-formedness (slug + unbalanced braces). ZERO missing
  entities on any row: Qwen drops nothing, it drowns replies in
  deliberation ("We need answer user's request... Must start
  directly... Could say:...") that quotes entities repeatedly
  (12228x4, 273x4, 5x6) and burns the 512 cap.
- Zero greetings/signoffs (both arms). No reasoning channel to check
  (llama-server; deliberation is in-band).
- vs LFM3 (0.711/0.833 with real drops + a corruption) and Gemini
  (83/83): Qwen sits between — faithful core, unusable surface.

## Mechanism (eyeballed full reply)

- d157#8 (180-day registration): 1750-char reply is PURE deliberation
  ("We need...", "Must start directly...", "Could say:...") ending
  mid-rule-recitation at length cap. The model never transitions from
  planning to answering on rule-laden transformation prompts —
  LFM3's think-forever without the tags.
- Implication: the fix must SUPPRESS or SKIP deliberation, not tune
  around it. Candidates queued in the technique probe: native
  /no_think switch, content-anchored prefill (first draft words force
  mid-sentence continuation), temp-0.3 sampling escape.

## Files

- kaggle/eval/ (notebook + metadata), kaggle/eval-dataset/ (45 IRs +
  byte-verified prompt templates), data/derived/qwen-expand.*
  (to be written by local scoring on replies fetch — PENDING the
  technique fix rerun; this report scores the 90 fetched rows).
- Local scoring: node one-liner over /tmp/qeval/replies.jsonl with
  validator.ts (counted parity + well-formedness); row details above.

## Gates

- No worker/src changes for the eval itself: typecheck/lint clean,
  suite stands 207 + 7. Qwen rows scored by the pinned validator.
