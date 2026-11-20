# Run report 009 — Worker entry point + durable breaker state + runtime tests

Date: 2026-11-11. Scope: PLAN.md Step 3 serving path: fetch entry wiring the
full pipeline, wrangler config, transactional DO breaker counters, and local
workerd tests. No cloud resources touched; no live LLM calls in tests.

## Files created/changed

- worker/wrangler.jsonc: entry, compat date, BREAKER_DO binding + migration.
  No KV yet (owner step; unconfigured path is tested, never silent).
- worker/src/env.ts, state.ts (BreakerBackend + InMemory + DO-backed),
  breaker-do.ts (transactional counters), app.ts (parse/validate/pin/spans/
  splice/ladder/wrap routing), index.ts (production wiring, bundled dict).
- worker/src/{dict,spanref}.ts: validated JSON constructors. ladder.ts: usage
  summing, nullable fullRegen (upscale re-expansion; caller-side full regen
  stays the documented follow-up). expander.ts: typed prepare errors,
  template fallback renderer.
- Tests: app/state/dict/spanref unit coverage; test/workers/ pool suite
  (routing, error taxonomy incl. real 501, DO persistence + isolation).
- REPO-RULES.md: pnpm installer (with cause), provisioning owner steps,
  two-suite gate definition, shrunk cannot-run list.

## Design decisions (mechanism)

- Secrets checked lazily: validation/version errors surface without a key;
  missing key 500s only when expansion is reached. Health never needs the key.
- Span store loads only when IR contains span lines (no KV read otherwise);
  store-version pin enforced; request values never echoed into errors.
- Usage sums across ladder attempts into the response (cost accounting).
- Registry: npm 10.9.8 crashes (internal edgesOut) resolving the vitest 4
  graph, persisting on clean state — repo standardizes on pnpm with evidence.
- Vitest 4 has no workspace files (defineWorkspace gone, file silently
  ignored): two scripts (test, test:workers) + test:all replace it.
- Deprecated pool package replaced with @cloudflare/vitest-plugin 1.6.1
  before writing any config against it.

## Verification (observed)

- `npm run test:all`: 16 unit files 132/132 + 2 pool files 7/7, all green,
  incl. real-DO persistence and real bundled-dict load inside workerd.
- typecheck exit 0; lint exit 0 zero diagnostics.
- Pre-commit audit (no commit made): no new literals (markers/versions named);
  errors typed end to end; fixtures carry provenance; pool tests touch no
  network and no secrets (key absent by design in test env).
- Not run: wrangler deploy (needs auth); live LLM in tests (by design).
