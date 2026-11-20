# Run report 022 — Kaggle serving campaign: v1-v5, live-fetch finding

Date: 2026-11-11/12. Scope: autonomous e2e for the Kaggle Qwen setup
using the owner's token (existing CLI login worked; pasted token
never used — revoke advised). Verdict: serving stack PROVEN (server
READY, smoke asserts pass, tunnel URL mints, clean exit), but
output-fetch works ONLY on terminal kernels — live tunnel handoff
to here is impossible. Eval redesigned to run generation inside the
kernel (run 023).

## Campaign log (all GPU, bounded probes)

- v1: failed in 15 min on `libcudart.so.12` missing (CUDA wheel needs
  system runtime the image lacks). Also exposed two harness bugs:
  `!pip` failures are silent (nonzero exit ignored) and the server
  log stayed inside the kernel. Fixes: checked calls everywhere.
- CPU probe (no GPU quota): driver facts inconclusive (CPU image has
  no nvidia-smi), but sudo OK + pip CUDA index reachable. GPU facts
  came from GPU runs instead (driver 580/CUDA 13).
- v2: pip CUDA 12.4 runtime (cudart+cublas) + LD path + ldconfig
  registration + ldd/RUNPATH diagnostics + server fast-fail. Slugs:
  Kaggle derives kernel slugs from titles, not metadata ids
  (409 on mismatch) — titles now aligned.
- v3: import OK (CUDA fix works!), server died on missing
  `sse_starlette` (server-only dep, lazily imported — install checks
  can't catch lazy imports).
- v4: full server dep closure ([server] extra + explicit backstop).
- v5: READY + SMOKE OK + tunnel URL minted, 12/12 keepalives, clean
  exit. Serving path PROVEN end to end (inside the kernel).

## Key findings

- `kaggle kernels output` returns files ONLY for terminal kernels
  (COMPLETE/ERROR); RUNNING kernels yield empty dirs (3 for 3:
  v1-errored, CPU-complete, v5-completed all fetched; 2 running
  fetches empty). Consequence: no live tunnel handoff is possible —
  the URL is knowable only after the tunnel dies with the kernel.
- For INTERACTIVE use (the deliverable's purpose) nothing changes:
  the user watches cell output live. For AUTONOMOUS eval the design
  flips: generate inside the kernel (IR dataset attached), save
  replies as output files, validate locally with the TS validator
  (zero divergence risk). No tunnel needed for eval.
- No API stop exists for running kernels: every probe MUST be
  time-bounded (v1/v2/v4 self-limited; v3-window design held).
  GPU spend this campaign ≈ 1.5h of 30h weekly.
- Prompt text in notebooks must be differentially verified against
  the TS builders (byte-exact) — established as required practice.

## Files

- kaggle/{kernel-metadata.json + probe/,probe-cuda/} (push records).
- /tmp/nb_*.py throwaway patchers (not repo). Reports 021 (setup)
  and this one (campaign). Eval design executes in run 023.

## Gates

- No worker/src changes: typecheck/lint/typecheck unaffected (suite
  stands 201 + 7). Notebook cells compile-checked at every push.
  Free APIs only; values never logged; pasted token never used.
