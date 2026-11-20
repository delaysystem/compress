# Run report 031 — Span pointers: +3.8x relative, 95.7% e2e

Date: 2026-11-14. Scope: prove span-refs compress slots (the 80%
of IR tokens nothing else touches). Verdict: proven relatively
and end-to-end — span-IR 5.00 p50 vs bare 1.33 on identical
grounded turns (+3.8x), recall 1.000, zero decode fails, and
90/94 expansions validate (95.7%). Absolute 10x on long-form
replies remains extrapolated: doc2dial answers run ~21 words,
so pointers save absolutely but the denominator is small.

## Emit (100 doc2dial turns x bare+span, Gemini, oracle spans)

- span: p50 5.00 / mean 5.79, recall 1.000 (N=23), 168 refs
  used, 0 decode fails. bare: p50 1.33 (mean Infinity from a
  single empty-IR flake; finite-filter added, p50 robust).
- Request-scoped ^N wire (additive; durable JSON kept) with
  whole-line + inline resolution; unknown refs fail loud.
  Per-row request maps; retrieval deliberately out of scope
  (oracle isolates the compression question).
- Dup-key bug: doc#turn collides across dials sharing a doc
  (100 rows, 97 unique). Emit numbers stand (per-job maps,
  no key joins); expansion rescored on 94 unambiguous rows.
  Fixed with dial-scoped keys for all future runs.

## Expansion end-to-end (store-backed prepare + validator)

- 90/94 pass (95.7%). All 4 fails are entity-parity (dropped
  values in rendering); ladder repair (proven live in run 029
  traces) would recover them in prod, which this pilot omits
  by design (direct-pass measurement).
- 1 bare empty-IR emit flake (0 tokens, recall unmeasurable):
  model-side, 1/200 calls. No punt, no hang.

## What this means for 10x

- Pointers replace values losslessly (exact by construction):
  the only lever that touches the 52-80% slot floor. The
  bitext lossy track (6.87x, report 030) and this track are
  complementary, not competing: codes compress boilerplate,
  spans compress values.
- Unproven combination: book + spans on long grounded replies
  is the true 10x test and needs a long-form grounded corpus
  (doc2dial turns are short; FEDI or staging logs are the
  candidates). Not run.
- Prod plumbing gap: per-request span maps need KV-backed
  slices by kbVersion (pilot holds maps in-process). Noted,
  not built.

## Provider status

- Gemini free quota walled mid-rerun (~600 calls today):
  BackpressureTrip aborted cleanly, resume-safe state kept
  (94 rows banked). Groq still 403/1010.
- Gates: 232 unit + 7 pool, typecheck 0, lint 0.
