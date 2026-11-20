# Run report 008 — SSE framing + live stream recording

Date: 2026-11-11. Scope: client-side SSE parsing, streamJson on the Gemini
client, one recorded live stream promoted into fixtures. No generation beyond
the single recording call.

## Files created/changed

- worker/src/sse.ts (+test): blank-line frame splitting (\r\n|\r|\n),
  data-line joining, comment skipping, [DONE] termination, TextDecoder
  streaming for mid-character multibyte splits. Tolerant deviation, documented:
  a trailing frame without blank terminator still dispatches (providers may
  end streams without one; dropping it would lose finish chunks).
- worker/src/gemini.ts: streamJson() (streamGenerateContent SSE, typed errors
  for missing body / invalid payload JSON). FetchFn gains body stream;
  existing stubs updated.
- worker/scripts/record-stream.ts: records one tiny stream to
  data/derived/stream-sample.json (names/counts on stdout only).
- worker/test/fixtures/stream-chunks.json: geminiText replaced with 3 verbatim
  recorded frames (incl. empty-text STOP frame with thoughtSignature —
  exercises the empty-text path for real); functionCall + OpenAI stay
  doc-labeled (tools support / OpenAI key pending).

## Live usage (observed)

- 1 streamGenerateContent call (gemini-3.5-flash-lite, "Reply with exactly:
  one two three"): 3 frames ("one two" + " three" + STOP), 7+3=10 tokens.
  Text arrives split across frames — accumulation confirmed necessary, not
  theoretical. Final frame carries empty text + STOP + usageMetadata.

## Verification (observed)

- typecheck exit 0; lint exit 0 zero diagnostics; tests 14 files 109/109 pass,
  incl. mid-character multibyte splits, CRLF, unterminated trailing frames,
  [DONE] cutoff, and both streamJson error paths.
- Pre-commit audit (no commit made): no new literals; errors typed; fixture
  carries provenance and contains no secrets (opaque ids only); recording
  output verified names/counts-only.
- Not run: Workers runtime, wrangler dry-run (unchanged).
