# Run report 021 — Kaggle Qwen3.8-27B serving setup + worker wiring

Date: 2026-11-11. Scope: owner "script and folder for running Qwen 27B
in a Kaggle notebook instead of DeepSeek for faster inference", worked
autonomously. Model resolved to `Qwen/Qwen3.8-27B` (Aug 2026, Apache
2.0, dense 27.78B — verified via HF API, not assumed); serving file
per owner link is ISTA-DASLab GSQ-RCO-GGUF IQ3_S (~12 GB).
Verdict: setup delivered and mechanically verified as far as possible
from here; end-to-end serving awaits the owner launching the notebook.

## Deliverable: kaggle/ folder

- `qwen3_8_27b_server.ipynb` (11 cells: settings checklist, GPU check,
  config, pip CUDA install, HF download with hf_transfer, llama-server
  launch + health wait, smoke asserts, cloudflared tunnel + URL parse,
  handoff with exact export line, keepalive, fallbacks).
- `README.md`: Kaggle setup, worker wiring, security posture (tunnel
  URL is the credential; eval-only, no prod data), costs/quotas,
  troubleshooting table, upgrade paths, honest verification limits.
- Stack decisions (autonomous, recorded): llama-server over vLLM
  (GGUF-native; AWQ quants are random third-party uploads); IQ3_S
  default (fits single T4/P100 fully offloaded; Q4/Q6 + MTP documented
  as one-line upgrades); cloudflared over ngrok (no token);
  T4 x2 required in settings, P100 workable.

## Worker wiring (no new client needed)

- `nim-expand.ts` honors `QWEN_BASE_URL`: endpoint + model label +
  key handling + `qwen-expand.*` outputs all switch (NIM evidence
  never mixes); no-auth (dummy key, server ignores it); no-think
  extraBody sent to NIM only. 12 edits, typecheck+lint clean.
- Verified without quota: dead-endpoint run proved routing (endpoint
  line, no secret lookup), file separation (2 error rows in
  qwen-expand.jsonl), error taxonomy, and budget math — then cleaned.
- Security note: tunnel URL is a bearer credential; README forbids
  committing it (also expires with the kernel).

## Verification limits (honest)

- Notebook JSON/schema valid; all 9 code cells compile; pip/URL/flag
  names reviewed against upstream docs; runner override proven
  against a dead endpoint. NOT e2e-tested (no Kaggle credentials
  here; needs a phone-verified GPU account). The notebook is
  self-verifying (GPU/import/health/smoke/tunnel asserts) — first
  failure mode is a loud cell error, and the handoff cell prints the
  exact export line. First live Qwen eval (smoke 2 IRs) is the
  owner's next command after launch (in README).

## Gates

- typecheck 0, lint 0 (82 files). No src/test changes: suite untouched
  at 201 unit + 7 pool (last green stands; no re-run per the
  unchanged-check rule). No live API calls for this deliverable.
