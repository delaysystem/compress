# Run report 027 — CPU verdict + live telemetry + Groq serving

Date: 2026-11-12. Scope: pick the best quota-free CPU model, trial
LFM2.5 for speed, build live kernel telemetry, add Groq Qwen support.
Verdict: Gemma 4 (12B and 26B) is perfect on CPU at 45/45 with zero
reasoning leak — 12B Q4_K_M is the working answer (smallest, least
RAM, same quality); gpt-oss 20B viable behind a new Harmony stripper
(43/45, truncation-only); LFM2.5 terminally non-viable (0/45 + 0/10
probe, all harness levers exhausted); Groq's served Qwen3.8-27B
scores 44/45 both arms at 5.2s p50 with zero reasoning tokens.

## Shootout: gemma4-26B 45/45, gpt-oss-20B 43/45

- Single v0 arm, 45 IRs, Q6_K quants, temp 0, 512 cap. gemma4: 45/45
  stop, 259 chars mean, 27s/row wall. gpt-oss: 43/45; both fails are
  length-truncations (analysis exhausts the cap), finished answers
  entity-perfect; 1150 chars mean, 59s/row.
- gpt-oss leaks its Harmony analysis channel (rule-recitation trips
  well-formedness). Fix mirrors run 025: `stripHarmony` takes text
  after the last `<|channel|>final<|message|>` (+4 tests); `expand()`
  now chains think-then-harmony stripping. No-op for other models.
- Throughput (kernel clock): gpt-oss ~19 chars/s flat (~4.3 tok/s
  true); gemma4 ~9 chars/s (~1.7 true). Faster decode loses to 4.4x
  verbosity on wall clock.

## LFM2.5-24B: 0/45, probe 0/10, terminal

- All 45 rows length-cap on untagged deliberation (zero delimiters
  corpus-wide); 100s/row wall. Diagnose skill followed: ranked H4
  card-sampling > H1 cap-starvation > H2 shape-demo > H5 blunt > H3
  template, tested in a 5-arm x 2-row probe with in-loop control.
- All arms 0/2. cap1024 fills 1024 tokens without answering (not
  starvation — deliberation is unbounded); sampling/demo/bluntness
  change nothing; template present in GGUF (H3 unlikely).
  Non-viable as an expansion emitter; no squeeze campaign (a perfect
  CPU model already exists).

## Gemma 12B + speed run: Q4 holds 45/45, wall prefill-bound

- gemma-4-12b Q6_K: 45/45, 262 chars, 30.0s/row median.
- Tuned rerun (Q4_K_M + n_ctx 2048 + threads/batch 512 + KV q8_0 +
  mlock + flash_attn): 45/45, wall median 31.7s — unchanged.
  Q4 decodes 1.4x faster (1.32 vs 0.9 tok/s true) but decode is ~3%
  of a row; wall correlates with prompt length (prefill-bound on 4
  cores). Q4 wins on size/RAM/download, not wall.
- Flag trace (v1 failed fast by design): python server takes
  `--type_k 8` (Q8_0=8 verified in ggml.h), `--use_mlock true`,
  `--flash_attn true` (defaults False — a real lever); bool flags
  take values. Exact names asserted against `--help` in-kernel.

## Effort matrix: reasoning_effort ignored, mechanism traced

- 4 models x default/low/none x 2 rows: all 3 settings byte-identical
  per model (18/24 = baselines). Server accepts the param, honors
  nothing. temp-0 determinism reconfirmed.
- Diagnosis (source-traced): field absent from the request schema
  (extra ignored, hence 200s not 400s) -> `model_dump` forwards
  declared fields only -> zero reasoning plumbing in core or CLI.
  Conceptually the wrong channel: Harmony reads effort from the
  SYSTEM message (`Reasoning: low`), never sampler params. Fix
  direction documented; confirmation probe offered, not launched.

## Groq: qwen/qwen3.8-27b at 44/45, 5.2s p50

- Free tier (Nov 2026 docs): 30 RPM, 1k req/day, 8k TPM, 200k TPD
  per model; TPM binds (runner paced 5s). One full eval ~90 req +
  ~50k tokens (~25% of daily tokens).
- groq-expand.ts mirrors the NIM runner (config + key + Groq pacing);
  `reasoning_effort none` honored, 0 reasoning tokens on all 90
  calls. v0 + strict both 44/45; single fail drops `{{...}}` braces
  (same key both arms). Served Qwen (0.978) vs quant Qwen (0.667):
  the quant+deliberation gap is real and large.

## Infra built this run

- watch.sh: 60s poll, jq stdout/stderr split, known-cause catalog
  (server closure, flat/nested mount, budget, hang, OOM, bad file),
  stall warn; 4/4 diag tests. Replaces 5-min blind polling.
- Live phone-home: stdlib receiver + cloudflared tunnel, kernel
  hb() + chained excepthook (fatal posted pre-death), push.sh
  stamps URL/token into /tmp copies (repo never holds secrets),
  fatal-event alert armed. Proven on gemma12 + probe kernels.
- score-replies.ts: scores any replies file through the product
  prepare+strip+validate path; gained --group for matrix/probe
  tallies. Nested dataset mount
  (/kaggle/input/datasets/<owner>/<slug>/) documented; CPU kernels
  need the llama-cpp-python[server] closure (same v3 disease).

## Speed table (per-row median wall; T=true, E=chars/4 est)

- gemini 2.5 lite 2.3s ~29E; groq qwen3.8 5.1s ~13E (0 rtok);
  llama-local 1.7B 2.9s ~25E; NIM deepseek 591s n/a (queue-bound).
- qwen3.8-27B GPU-GGUF 38s ~12E; gpt-oss-20B CPU 59s 4.3T;
  gemma4-26B CPU 27s 1.7T; gemma12 Q6 30s 0.9T; gemma12 Q4 32s
  1.3T; lfm2.5 CPU 88s 5.5T (deliberation only).

## Standing owner decisions

- Production expander stays DeepSeek/NIM; Groq free tier is
  eval-only (paid tier unprobed, like NIM paid).
- gpt-oss `Reasoning: low` system-message probe: offered, awaiting
  word (~40 min kernel if wanted).
- DeepSeek top-up (43/90), flagship overlap, 1024-cap Qwen rerun:
  unchanged pendings.

## Gates

- typecheck 0, lint 0, 215 unit + 7 pool (stripHarmony +4).
  score-replies --group covered by live runs, not vitest (script
  seam). Kernels quota-free CPU except sunk GPU eval. Free APIs
  only; values never logged.
