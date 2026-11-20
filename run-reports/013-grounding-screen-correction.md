# Run report 013 — LFM3 fallback live + tier-1 grounding screen + 012 correction

Date: 2026-11-11. Scope: grounding-entailment precondition + local-model
fallback per owner instruction (Gemini first, LFM3 when limited, LFM3 in
the big-LLM slot).
Verdict: tier-1 entity screen built, evaluated, and fixed to 100%
precision (1/92 fails, a true positive). Run 012's "ungrounded phone
emission" finding is RETRACTED (verification-grep error); the plan
precondition is right-sized accordingly. v3 recall rescored 0.781.

## LFM3 fallback (owner instruction)

- llama.cpp server (`llama` umbrella binary on PATH) serving
  kaitchup/LFM3-1.7B-GSQ-GGUF:Q6_K_RCO on 127.0.0.1:9931, ctx 8192,
  --reasoning-effort low (default effort burned the whole token budget
  on reasoning traces, returning empty content). Model cached under
  /tmp/hf-cache (sandbox-contained). Smoke: "ok", finish=stop.
- Operational note: `pkill -f 'llama serve'` matches the caller's own
  command line and kills the shell too; use the `[l]lama serve` bracket
  form. Server relaunched cleanly after the mishap.
- Role: quota-fallback big LLM for subsequent eval/judge work. No
  product wiring (execution tool, not architecture).

## Tier-1 screen + eval

- worker/src/grounding.ts checkEntityGrounding: every DISTINCT IR entity
  must appear in grounding (set semantics; repetition is emphasis).
  5 tests. Eval scripts/eval-grounding-v3.ts over frozen v3 rows
  (corpus reassembly + per-row word assert): 92 rows, 292 entities.
- First run: 5 fails. Adjudication: 4 date-class false positives from
  corpus-vs-model spacing ("November 1 , 1912" vs "November 1, 1912"
  split canonicals) + 1 TRUE POSITIVE: IR mangled "2001" into
  "2**001**" (markdown bold leaked mid-number, also a prompt-rule
  violation) — the screen caught a genuine emission defect.

## Run 012 correction (retraction)

- The "SERIOUS ungrounded phone emission" verdict was wrong. The v3
  verification grepped dashed forms ('327-0022') while the corpus AND
  the IR both carry spaced forms ('327 - 0022'); concordance review
  shows the IR reproduced all hotline numbers verbatim from grounding
  with identical labels. Cause: grep-form mismatch, same spacing-
  artifact family that bit the extractor. The extractor's segment
  matching was right; my check was wrong.
- Standing correction: zero fabrication evidenced in 92 grounded rows.
  (v1's ungrounded-mode hallucinations remain real but are a different
  mode.) No phone-unit extractor change needed.

## Spacing-tolerance fix (entities.ts)

- DATE_RE + canonicalDate attach years across horizontal space
  ("1 , 1912", "1,1912"); NUMBER_RE tolerates "$ 17,500" and "80 %";
  newlines never attach (tested). Regression caught by suite: naive
  `[ \t]?` let matches start with whitespace and broke indented list
  markers — fixed via grouped `(?:[$€£¥][ \t]?)?` + raw trim in
  isListMarker. 4 new spacing tests.
- Tier-1 re-eval: exactly the 1 true positive (100% precision).
- v3 rescore (scripts/rescore-v3.ts, zero API calls): recall
  0.763 -> 0.781, recallN still 92, missRows 24 -> 23. New file
  ir-pilot-v3-rescored.json is AUTHORITATIVE; old summary superseded
  for recall (conservative direction).

## Plan right-sizing (Step 5)

- Floor 0.70 stands (observed now 0.781 lower bound).
- Precondition revised: tier-1 entity screen REQUIRED (cheap,
  deterministic, proven true positive); tier-2 LLM entailment
  sampling DOWNGRADED to recommended — no live grounded-mode
  fabrication evidence (v1 ungrounded hallucinations keep the topic
  open, not blocking).

## Gates

- typecheck 0, lint 0, 173 unit (164 + 5 grounding + 4 spacing) + 7
  pool. Only free APIs + local model; values never logged.
