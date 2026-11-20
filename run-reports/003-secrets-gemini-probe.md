# Run report 003 — secrets resolution + Gemini client + live probe

Date: 2026-11-11. Scope: key loading from `.dev.vars` (owner request), minimal
Gemini client, live ListModels + countTokens probe (free APIs only).
No generation calls made.

## Files created/changed

- worker/src/secrets.ts (+test): env-first, `.dev.vars`-file-second key
  resolution via dotenv parsing; missing-key errors name the key only;
  fixture uses fake values. Node-only (fs); Workers get env bindings.
- worker/src/gemini.ts (+test): fetch-based client (listModels, countTokens,
  generate), `x-goog-api-key` header auth (never query params), typed
  GeminiError, minimal FetchFn interface so the global fetch and test stubs
  both satisfy it without casts. Model IDs are parameters, never hardcoded.
- worker/scripts/gemini-smoke.ts: live probe; prints names/counts only.
- worker/src/config.ts: GEMINI_API_KEY_NAME (owner contract), GEMINI_BASE_URL
  (public stable endpoint, overridable) — no URLs or names scattered in logic.
- worker/test/fixtures/gemini-*.json: countTokens shape recorded live;
  generate shape per API-docs contract (UNCONFIRMED until first live generate).
- REPO-RULES.md: local-runner secret resolution documented.

## Live probe (observed, free APIs)

- Key resolved from file (`file:GOOGLE_API_KEY present=true`); values never
  printed anywhere. Usage: 5× ListModels + 6× countTokens + 2× failed (404)
  calls, all free-tier.
- ListModels returned 39 models. gemini-2.5-flash[-lite] 404 as unavailable
  to new users; API redirects to gemini-3.8-flash / gemini-3.5-flash-lite.
  The client's typed error path surfaced this correctly (status + message).
- countTokens on 3 samples, both current models: identical counts
  (2 / 25 / 14 tokens) — same tokenizer family on these samples (n=3, not a
  general claim).

## Verification (observed)

- `npm install -D dotenv`: +1 package. Reason (agents2.md Rule 5): established
  dotenv parser; hand-rolling one is prohibited.
- typecheck exit 0 (fixed one exactOptionalPropertyTypes error on a test
  helper interface by typing the property honestly). lint exit 0 zero
  diagnostics. Tests 8 files 64/64 pass, including: env-over-file precedence,
  missing-key message equality (proves no value leak), key-never-in-URL,
  JSON and non-JSON error paths, empty-key rejection.
- Fetch-boundary tests use stub + fixtures per REPO-RULES.md (stated here).

## Pre-commit self-audit (no commit made)

No banned literals (endpoint + key name live in config.ts with origins;
truncation cap named); no Rule-2 fixes (the 404s were the API's own answers,
handled by design); no error swallowing (all failures throw typed errors);
no test-environment branching; fixture values fake and labeled; secrets never
in output (verified: probe transcripts carry names/counts only).

## Not run / open

Workers runtime, wrangler dry-run (unchanged); live generate (shape
unconfirmed — first generation pilot records it); countTokens re-measurement
of the IR sample set (follows now that the client is proven).
