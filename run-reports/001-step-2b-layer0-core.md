# Run report 001 — Step 2b scaffold + first units (router, completeness, wrapper, entities)

Date: 2026-11-11. Scope: PLAN.md Step 2b (repo + per-repo verification) and the
first test-covered units for Layer 0 / 0b / validator core. No Worker entry
point yet (deferred per REPO-RULES.md); no live API calls made.

## Files created

- REPO-RULES.md, .gitignore (root)
- worker/package.json, tsconfig.json, vitest.config.ts, biome.json
- worker/src/config.ts (14 pinned PLAN.md values, each with section origin)
- worker/src/router.ts (typed-envelope routing + Gemini/OpenAI adapters)
- worker/src/completeness.ts (truncation detection)
- worker/src/wrapper.ts (politeness wrap/strip, copy as config args)
- worker/src/entities.ts (extract + multiset diff with canonicalization)
- worker/test/*.test.ts (4 files, 29 tests) + fixtures/tau2-sample.json
  (message shapes from data/tau2 trajectories file, PII replaced)

## Design decisions (mechanism, not taste)

- Normalized envelope + provider adapters: router consumes
  {finishReason, toolCalls}; fromGemini reads functionCall parts, fromOpenAI
  reads tool_calls. Prevents shape confusion between Gemini production traffic
  and OpenAI-shaped fixtures/benchmarks. Mixed content+tool_calls routes to the
  tool path (whole message forwarded, PLAN.md passthrough rule).
- Priority-ordered entity extraction (url > email > date > identifier > number)
  with claimed-span skipping: each span classifies once, so "March 3rd" and
  "3/3" both yield exactly {date:03-03}. A naive overlapping extractor fails
  the plan's own canonicalization example (E8); this was corrected during
  authoring before any test ran, then locked by tests.
- Currency symbols kept in number canonical form ($50 ≠ €50); urls/emails/ids
  verbatim (no case folding — URL paths are case-sensitive).
- Wrapper copy passed as arguments, never baked in; strip removes one layer.
- Biome default style (tabs) adopted by running the formatter, not by
  configuring around it; biome.json migrated to `preset` (deprecation fix).

## Verification (observed, this machine)

- `npm install` (worker/): 48 packages in 19s. Deps and reasons: typescript
  (language), vitest (tests), @biomejs/biome (lint+format), @types/node
  (test/config types). No production dependencies yet.
- `npm run typecheck` (tsc --noEmit, strict + exactOptionalPropertyTypes +
  noUncheckedIndexedAccess): exit 0.
- `npm run lint` (biome check .): exit 0, zero diagnostics (13 format findings
  fixed by `npm run format`, then config migrated for the preset deprecation).
- `npm test` (vitest run, node env): 4 files, 29/29 passed, ~900ms.
- src/ uses only standard JS (no Node APIs) so the units stay
  Workers-compatible; vitest node env is test-time only.

## Pre-commit self-audit (no commit made — not authorized)

1. No banned literals (config values are pinned plan values with origins), no
   test-detection branches; 2. numerics named with origins; 3. no Rule-2 fixes
   this run (authoring-time design correction above, locked by tests);
4. no new error swallowing/retries/timeouts/dependency changes post-install;
5. full suite + typecheck + lint green in single deterministic runs; 6. no
   carve-outs; 7. no test hooks or security changes, fixtures carry provenance;
8. deps justified above, no hand-rolled crypto/parsers; 9. no upstream, nothing sent.

## Not run (honest list, per REPO-RULES.md)

- Workers runtime behaviour (no pool installed); wrangler deploy --dry-run
  (needs auth); live Gemini tests (none written yet; no live calls made).
- .dev.vars untouched (key names listed once for wiring; values never printed).

## Open follow-ups (not this run)

Streaming-delta reassembly unit; dictionary codec + span resolver; Gemini
client + countTokens re-measurement; Step 1 staging/dev logs (blocked on owner
pointer); CI; full SGD re-clone if needed; MSDialog email request (owner).
