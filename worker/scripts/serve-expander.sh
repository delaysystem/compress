#!/bin/bash
# Canonical local expander server (latency-tuned, measured 2026-11-21).
# Run from repo root: worker/scripts/serve-expander.sh [model.gguf]
#
# Flags that matter for latency on the 4-core dev box:
#   -rea off   REQUIRED. Without it LFM3-v13b never emits EOS and generates to
#              max_tokens (measured ~110s/request vs ~7s with it on).
#   --jinja    applies the model chat template; pairs with -rea off.
#   -fa on     flash attention: measured 6.8s vs 9.2-9.8s bracketed baseline.
#   -c 2048    expander prompts are ~50-180 tokens, replies <512; larger ctx
#              only grows the KV pool.
# Not worth it here: -md speculative draft (230M draft overhead, measured
# 8.3s vs 7.6s baseline), -ctk/-ctv q8 (requires -fa, no extra gain).
set -eu
cd "$(dirname "$0")/../.."
MODEL="${1:-vendor/models/lfm3-expand-v13b-q4km.gguf}"
exec vendor/llama-old/b12000-vk/llama-b12000/llama-server \
  -m "$MODEL" \
  --port 9931 -c 2048 -t 4 -ngl 0 \
  --jinja --temp 0 -rea off -fa on
