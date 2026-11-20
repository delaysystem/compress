"""Merge a PEFT adapter into its base (CPU, fp16) for GGUF export.

Usage: .venv/bin/python kaggle/merge-lora-local.py <base-id-or-path> <adapter-path> <out-dir>
Keeps RAM bounded via fp16 + low_cpu_mem_usage (1.7B fits 8GB).
"""

import sys

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

base, adapt, out = sys.argv[1], sys.argv[2], sys.argv[3]
tok = AutoTokenizer.from_pretrained(base, trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained(
    base,
    torch_dtype=torch.float16,
    trust_remote_code=True,
    device_map="cpu",
    low_cpu_mem_usage=True,
)
model = PeftModel.from_pretrained(model, adapt)
model = model.merge_and_unload()
model.save_pretrained(out, safe_serialization=True)
tok.save_pretrained(out)
print("merged-ok", out, flush=True)
