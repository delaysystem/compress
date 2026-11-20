# Run report 024 — Validator hardening: ID widening + well-formedness

Date: 2026-11-12. Scope: close the #84721 identifier flag and the
stray-brace blind spot with measured fixes. Verdict: identifiers show
no systematic failure (5/6 preserved incl. #84721 kept); ID_RE widened
to alphanumeric codes; new 4th validator check (well-formedness)
enforces the observed meta-talk taxonomy. Zero impact on published
numbers (proven by corpus grep).

## Identifier probe (closes run-019 flag)

- 5 identifier-heavy refs through LFM3 compress: #84721 KEPT (prior
  drop not reproduced), #55610 x2 kept, #XYZ-999 x2 kept, flight
  AB1234 kept (vacuous — bare alphanumerics unextracted, blind spot
  noted not fixed), #INV-2026-0031 split into number segments
  (extractor gap, fixed below). 1 drop in 6 trials total: no
  systematic failure; flag closed as inconclusive-small-n with a
  recommendation for identifier-heavy sampling in future evals.
- Ops note: LFM3 server wedged mid-probe (health 200, inference
  sockets dying, native trace in log) — restarted, inference
  re-verified. Follow-up: health endpoint is insufficient; needs an
  inference-level watchdog.

## ID_RE widening

- `/#\d[\d-]*/` -> `/#[A-Za-z0-9][\w-]*/`: order/ticket/invoice codes
  (#84721, #INV-2026-0031) match whole as one set-scoped unit, so
  benign mention-merges pass and segments never split. Lone `#` and
  `# ` still never match. Phone segments unaffected (still numbers).
- Impact proven zero: `#[A-Za-z]` occurs 0x in Bitext 27k responses
  and 0x in MultiDoc validation utterances — all published recall /
  parity numbers stand unchanged. +3 tests.

## Well-formedness: 4th validator check (last position)

- Catches what entity checks cannot: unbalanced `{{ }}` (the
  single-brace typo is invisible otherwise) + 7 meta markers, each
  evidenced by observed output: ellipsis slug, rule/signoff/copy-rule
  recitation, prompt + header quotation, enumerated meta. Deliberately
  tight (e.g. "here's my reply" excluded — occurs legitimately).
- Contract-safe: appended last (checks[0..2] stable, ladder consumes
  names generically so the repair hint picks it up with zero changes,
  app.ts untouched). One existing test updated (names array), +4 tests.

## Gates

- typecheck 0, lint 0, 207 unit (201 + 6) + 7 pool. Local model only.
