# Run report 018 — LFM3 emitter fix: prefill + 1-shot converges it

Date: 2026-11-11. Scope: owner "fix it" on the 0/25 emitter
non-convergence. Fix: `</think>` assistant-prefill (closes deliberation
for the model) + 1-shot shape demo. Local-only, not portable.
Verdict: convergence FIXED (25/25 grounded, 25/25 compress), fidelity
high, but selectivity absent (grounded 0.12x dumps) and compression
weaker than Gemini (2.75x vs 4.51x, marker-fragile). Emitter-as-flagship
still NO; local compressor/answerer roles now exist with caveats.

## The fix (mechanism)

- 8 run-017 probes failed (caps, budgets, off-switch, short context,
  instruction, raw completion, few-shot, JSON forcing). Ranked battery
  continued: assistant-prefill `</think>\n` makes the model skip
  deliberation and answer directly (75 tokens, finish=stop) — but in
  prose. Adding a 1-shot telegraphic demo transfers the SHAPE.
- Why it works: the pathology is a non-convergent <think> loop; the
  prefill starts generation post-deliberation, the demo sets the output
  attractor. Server stays --reasoning off (fastest); technique lives in
  the harness (prefill param + strip) and prompts/ir-grounded-1shot-v1.md
  + prompts/ir-emit-1shot-v1.md (both pinned, exact tested text).

## Grounded formal (25, overlap subset, cap 256)

- 25/25 converged (vs 0/25), 0 punts, 0 empties, recall 1.000 (45/45:
  date 5, email 1, number 37, url 2), tier-1 0 fails. wallP50 19.8s.
- BUT ratio p50 0.12: outputs are exhaustive dumps (median 251 tokens,
  10/25 capped), telegraphic-ish with "/" separators but unselective.
  The model cannot prioritize relevance at 1400-token grounding.
- Verdict: faithful local ANSWERER (free, slow), not a compressor.

## Compress formal (25, Bitext spread, cap 256)

- Ratio p50 2.75 (vs Gemini 4.51): real compression at ~60% the rate.
  Recall 0.786 (14 measurable, placeholder-only evidence: 11 perfect +
  3 marker rows — 1 brace-strip benign, 1 boilerplate-drop arguably
  correct, 1 ask-drop real-partial). Echo 0.96 (handled by extraction).
- Tier-1 14 fails: 13x `{{...}}` slug (systematic meta-habit, benign),
  1 demo-leak (Fee $25 imported from the 1-shot demo — real minor),
  prompt-header quotation (see correction).
- Synthetic entity micro-probe (5 hand-made dense refs, labeled
  synthetic): 3/5 perfect incl. URL/phone/money/times; 1 dropped lead
  identifier #84721 (FLAG: identifier robustness unproven, follow-up);
  1 meta-relapse with multiset duplication. Slug 3/5.
- LFM3 failure taxonomy: think-forever (fixed), {{...}} slug (~50%),
  prompt-quotation (headers/parentheticals echoed as content),
  meta-relapse (~4-20%: rule recitation mid-output), demo-leak,
  question-echo. All visible in rows; validator/tier-1 catch the
  entity-bearing ones.

## Retrospective correction (run 017)

- "Model injects today's date" is WRONG: the `date:2026-11-11` tier-1
  flags are quotations of the prompt files' own "Pinned: 2026-11-11"
  headers (today's session date made it look like current-date
  awareness). Same prompt-quotation family as the parenthetical
  parroting. The screen was right to flag; the story was wrong.

## Role verdicts (all LFM3 evidence)

- Flagship emitter (joint answer+compress): NO — selectivity gap fatal.
- Local compressor (post-hoc): PROMISING — 2.75x, needs entity +
  identifier work + slug/echo handling in-harness (done for echo).
- Local expander: VIABLE behind validator (run 015).
- Short QA/judge: viable with prefill (this run's mechanism).

## Files

- prompts/ir-grounded-1shot-v1.md, ir-emit-1shot-v1.md (pinned).
- scripts/lfm3-emit.ts (+--shot; baseline files intact),
  scripts/lfm3-compress.ts (new), data lfm3-emit-shot.* +
  lfm3-compress.*. v1/v2/v3 runners untouched.

## Gates

- typecheck 0, lint 0, 184 unit + 7 pool (no src/ changes; scripts +
  prompt files covered by typecheck+lint). Local model only.
