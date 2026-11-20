# Wire v3 spec (run 036+)

Space-separated single-line IR. Verified 1-token separators double as
expansion codes; newlines and single-slot pipes are gone. Same 46
intents as v2 — only the wire changes.

## Measured motivation (v8 corpus, 100 rows, ~1850 IR tokens)

| spend | tokens | v3 verdict |
| pipes (303) + newlines (156) | 459 | ELIMINATE (keep ~60 intra-line pipes) |
| `{{markers}}` (108 occ, ~4.5 tok avg) | 481 | compositional rule, saves ~163 |
| commas (11) | 11 | KEEP (list-flag machinery cut, ROI 0.6%) |
| `'s` (3) | 3 | KEEP (cut, unmeasurable) |
| digit+dash slots (8) | ~30 | pattern codes DEFERRED to v3.1 (~1.7%) |
| merges (`dateofbirth`) | 0 saved | CUT (proven zero saving) |
| suffix morphology (`ajb`) | fails 16/46 | CUT, flat assignment instead |

Projected IR cut ≈ 563/1850 ≈ 30%. Prompt grows ~130 tokens
(wire rules + marker rule), so v3 pays off behind cached prompts
(breakeven ~17:1 uncached); verify cache behavior in the pilot.

## Grammar

```
stream   := segment*
segment  := SEP payload-words* | text-run
SEP      := one of the 46 assigned codes (exact, lowercase, 2-letter)
```

- The parser scans whitespace-separated words. A word in the SEP set
  opens a new segment; anything else extends the current payload (or a
  leading text run, decoded verbatim).
- Payload words are joined with single spaces, then split on `|` for
  arity (v2 semantics). Emitters print `|` only between slots of
  multi-slot codes (57/256 v8 lines); anything else arity-fails and
  the autofix merges it (comma-join, current tested rule).
- Separators are UPPERCASE 2-letter codes (526/676 single-token):
  lowercase payload words (to/of/in) can never collide, so common
  words parse as payload with no violation, no fix, no noise.
  Single-letter words can never be separators either: strays are
  impossible by construction. Slotless codes emit their SEP alone
  (m->`MA`, k->`KA`).
- Text travels via the `TX` identity code (template `{t}`) or as a
  leading prologue (words before the first SEP, decoded verbatim).
  Input with no SEP at all decodes as one text segment (punt-safe).
  Mid-stream bare words always belong to the running payload.
- Unknown SEP-shaped words (uppercase 2-letter, unassigned): decode
  FAILS loud (v2 philosophy); autofix converts the segment to text.
- A payload word equal to an assigned SEP MUST be backslash-escaped
  (`\AX`); unescaped occurrences re-segment the stream (silent
  meaning change — the one failure class the decoder cannot catch).
  Assign-time exclusions (corpus uppercase pairs, common capped pairs)
  keep real collisions near zero; the emitter prompt teaches the rule;
  pilots spot-check replies for stray template words.

## Separators

`data/derived/dict-ir-v3.json`: same 46 templates/slots as v2, new
codes, e.g. `a->AB w->WA m->MA k->KA aj->AP aa->AD`, plus a 47th
`TX` identity entry (template `{t}`) carrying free text.
`data/derived/v2-to-v3.json` records the map. Assigned by
`worker/scripts/assign-v3-separators.ts` (deterministic, re-runnable):
526 cl100k-verified UPPERCASE candidates, 51 excluded, 476 survivors,
same-first-letter preference with sorted fallback. Reuse `dict.ts`
decode unchanged.

## Markers

Rule (one prompt line): multi-word `{{Two Words}}` markers emit as
lowercase unspaced form (`twowords`); the decoder restores via
`data/derived/marker-v3.json` (32 entries). Single-word markers
(`{{Profile}}`) stay verbatim (4 in corpus). Matching is
whole-value, case-insensitive, and also accepts bare inner text
(`Tracking Number` restores: models emit it as often as the form).
Text segments restore per word. Table miss (including the 5 observed
model-invented variants) passes through verbatim — never normalized,
never dropped. Decoder table is code-side: zero prompt cost beyond
the rule.

## What did not make it (measured, do not re-litigate)

- List-flag codes: 11 commas corpus-wide; multi-word items make
  decoder-placed commas lossy. Keep commas.
- `'s` dropping: 3 occurrences; extractor ignores possessives anyway.
- Dash/unit patterns (`ic 3 7`): 8 slots; sketch kept for v3.1.
- Blind merges and suffix morphology: proven zero/negative.

## Emitter contract deltas (v3 prompt)

1. One line, space-separated, no newlines; `|` only between slots.
2. Marker rule (above).
3. Escape SEP-shaped payload words with backslash.
4. Slotless codes emit bare SEP.
(Terse rules target: ≤100 tokens over the v2 prompt.)

## Codec

New `src/wirev3.ts`: `parseV3(text, dict)` -> segments
(`{kind:'code',code,slots} | {kind:'text',text}`),
`encodeV3(segments)` inverse, marker restore inside value mapping.
Decode reuses `dict.ts` per code line. Totality: every input parses;
validity (known SEP, arity, marker-table) is checked after, mirroring
the v2 split between `parseCodeLine` and decode.

## Ports (plan steps 4-5)

- autofix (`autofixV3`, implemented + tested): same rules per segment
  + unknown-SEP segment-to-text. Lone `m`/`k` payload words stay
  literal by design (1-letter codes untaught; revisit on pilot
  evidence). No post-split escape repair is possible (collisions
  surface as arity feedback to the LLM loop instead).
- validator/rescore: v3-aware decode path; `--dict dict-ir-v3` selects
  book and wire together (v3 dict implies v3 parser).
- Pilot gates unchanged: tokenizer-verified transforms, compliance
  pilot go/no-go (codeUse ≥ 0.85), full pilot rescore (ratio gain,
  recall ≥ 0.80, 0 fails, ≤ 2% repairs).

## v3-x: compressed cache-optimized prompt (run 037+)

Same wire, cheaper head: book lines render `XX:Template` (no
`means "` wrappers, newlines kept — measured 432 vs 484 tokens
against joined forms), rules rewritten terse, header/footer
boilerplate removed. Head: 1076 → 790 tokens (-27%, tokenizer
verified). Layout keeps the static prefix byte-identical across
requests (rules + book first, reference last) for prefix caching;
`buildEmitPrompt` + unit test pin the invariant. Measured (ling-25
paired): 8.83x vs 8.02x, 0 fails, 0 repairs — compression held.
Economics assume 50% cached-input discount, 2h TTL (Groq terms,
verified against docs; note Groq caching is GPT-OSS-models-only,
so treat this as provider-agnostic design with per-provider terms).
Validated (ling-25 paired): 8.67x vs 8.02x, recall 0.979 (parity),
0 fails, 1 repair, marker adoption 48%. A first wording (ALWAYS)
taught invented smashed blobs on 2 rows; the shipped rule (prefer +
smash-only-table + braces fallback) closed it.
