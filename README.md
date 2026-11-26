# compress — LLM output compressor for customer support

Cut flagship API output tokens ~10x. The flagship model emits compact
intermediate representation (IR) instead of prose; a cheap local pipeline
expands it back into a fluent customer reply. One flagship call per message,
always — zero flagship retries.

```
user turn + tool results
  -> flagship emits v3 IR (telegraphic, ~1/10th the tokens)
  -> deterministic decode + splice (codes, spans, slots)
  -> SLM expansion (local LFM3, finetuned)
  -> validator (8 blocking checks) -> ladder: direct | SLM repair | template
  -> customer reply
```

Tool calls pass through byte-exact. Anything the validator rejects is
repaired by the SLM or served from the deterministic template — never
silently shipped, never a second flagship call.

## Status

- Wire v3 IR, validator + ladder, expansion finetunes v10–v13b (LFM3-1.7B).
- Expansion quality: 88/100 direct validator passes, 100/100 end-to-end
  with ladder (6% template fallback). Fresh-key holdout: 25/25 direct.
- Runtime: Cloudflare Workers (TypeScript). SLM served from llama.cpp.

## Layout

- `worker/src/` — pipeline: `wirev3.ts` (IR codec), `dict.ts` (codebook),
  `expander.ts` (splice + SLM prompt + output cleanup), `validator.ts`
  (8 checks), `ladder.ts` (direct/repair/template), `app.ts` (Worker).
- `worker/test/` — vitest suite (380+ tests, incl. real-world agent
  scenarios in `agent-world.test.ts`).
- `worker/scripts/` — eval harness: emit (`emit-dict.ts`), expansion
  (`lfm3-expand-v3x.ts`, `groq-expand.ts`, ...), SFT builder
  (`build-sft-pairs.ts`), baselines.
- `worker/prompts/` — emit codebooks and expansion prompts.
- `kaggle/` — QLoRA finetune notebooks + local 1650 trainer
  (`train-local-1650.py`) + LoRA merge (`merge-lora-local.py`).
- `SPEC-wire-v3.md` — IR wire spec. `run-reports/` — experiment notes.
- `data/` (gitignored) — staging/dev datasets and banked eval rows.
- `vendor/` (gitignored) — models, llama.cpp builds, converters.

## Quickstart

Prerequisites: node 22+, the worker deps, and API keys in `.dev.vars`
(see `worker/test/fixtures/test-vars.env` for names; never commit it).

```bash
cd worker
npm install
npm run test:all      # unit + workers tests
npm run typecheck
npm run lint
```

Run an expansion eval against a local SLM (llama.cpp server on :9931):

```bash
node --experimental-strip-types scripts/lfm3-expand-v3x.ts \
  --input emit-v3gem100.jsonl --out lfm3-v3gem100.jsonl --force
```

Build the SFT dataset and (re)generate the finetune notebook:

```bash
node --experimental-strip-types scripts/build-sft-pairs.ts
python3 ../kaggle/gen-finetune.py   # writes kaggle/finetune-lfm3/
```

Merge a trained adapter and export GGUF (CPU, fits 8GB RAM):

```bash
.venv/bin/python kaggle/merge-lora-local.py \
  LiquidAI/LFM3-1.7B vendor/models/lfm3-expand-lora-v13 vendor/models/merged-v13
```

Serve (default — flash attention on, reasoning off; `-rea off` is required
or v13b generates to the token cap at ~110s/request):

```bash
worker/scripts/serve-expander.sh        # -rea off --jinja -fa on
# equivalent: llama-server -m lfm3-expand-v13b-q4km.gguf \
#   --port 9931 -c 2048 -ngl 99 --temp 0.0 -rea off --jinja -fa on
```

Expansion prompts use the compact rules by default
(`config.EXPANSION_PROMPT_MODE = 'compact'`, ~50 vs ~142 tokens); set it to
`'full'` to restore the verbose rules. Flash attention (`-fa on`) and compact
prompts are both default; speculative draft (`-md`), measured slower on CPU
(8.3s vs 7.6s), is not.

Measured expander p50 on 4 CPU cores: 7.6s baseline -> 6.8s `-fa on` ->
6.0s compact. Full method table: `run-reports/034-latency-methods.md`.
Re-run the controlled benchmark with `worker/scripts/latency-bench.ts`.

## Design invariants

1. One flagship call per message. No flagship regen, anywhere.
2. Validator-verified or explicit-loud: `ok: false` means escalate,
   never silent ship.
3. Staging/dev data only in evals — never production customer data.
4. Billed tokens (prompt + completion + thinking) is the deciding metric.

## Models

The latest expansion finetune (**v13b**) — PEFT LoRA adapter and merged q4km
GGUF — is published on HuggingFace at
[red-ware/lfm3-expand-v13b](https://huggingface.co/red-ware/lfm3-expand-v13b).
Base: [LiquidAI/LFM3-1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B).

Older finetunes (v11–v13) remain local under `vendor/models/` (gitignored).

## License

Business Source License 1.1 — see [LICENSE](LICENSE). Non-production use is
granted; the file states the Change Date and Change License.
