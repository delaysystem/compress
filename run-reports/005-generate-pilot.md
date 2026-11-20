# Run report 005 — generation pilot with recorded fixtures

Date: 2026-11-11. Scope: first live generateContent call, usage accounting on
the client, recorded-shape fixtures. Closes the "generate shape unconfirmed"
item from run 003.

## Files created/changed

- worker/scripts/gemini-pilot.ts: one tiny completion (default prompt "Reply
  with exactly: ok"), prints text/finishReason/usage only, records raw
  response to data/derived/generate-sample.json. Values never logged.
- worker/src/gemini.ts: generateRaw() (raw access for recording) + usage
  extraction into GenerateResult (plan token accounting needs it).
- worker/test/fixtures/gemini-generate.json: verbatim recorded response
  (gemini-3.5-flash-lite), wrapped with provenance; unknown fields kept to
  lock parser tolerance.
- worker/test/gemini.test.ts: recorded-shape expectations incl. usage; new
  test for absent usageMetadata.

## Live usage (observed)

- 2 generateContent calls (raw record + parsed print), prompt "Reply with
  exactly: ok" on gemini-3.5-flash-lite: text "ok", STOP, 5+1=6 tokens each.
- Response shape confirmed: candidates[].content.parts[].text (+thoughtSignature,
  role), finishReason, usageMetadata{promptTokenCount, candidatesTokenCount,
  totalTokenCount}, plus modelVersion/responseId extras the parser ignores.

## Verification (observed)

- typecheck exit 0; lint exit 0 zero diagnostics; tests 9 files 72/72 pass.
- Pre-commit audit (no commit made): no new literals; no error swallowing;
  fixture carries provenance and contains no secrets (opaque ids only);
  pilot output verified names/counts-only before recording.
- Not run: Workers runtime, wrangler dry-run (unchanged).
