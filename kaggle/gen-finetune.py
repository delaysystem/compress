"""Generate the LFM3 QLoRA finetune notebook (run 047).

Writes kaggle/finetune-lfm3/finetune-lfm3-expand.ipynb + kernel-metadata.json.
Push: kaggle kernels push -p kaggle/finetune-lfm3/
"""

import json
import os

TRAIN_PY = '''"""QLoRA SFT for LFM3 expansion (DDP, 2x GPU). Launch via torchrun."""
import json
import os

import torch
from datasets import load_dataset
from peft import LoraConfig, prepare_model_for_kbit_training
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

MODEL = "LiquidAI/LFM3-1.7B"
DATA = "/kaggle/input/datasets/blonded2/lfm3-expand-sft"
OUT = "/kaggle/working/lfm3-lora"
WORLD = int(os.environ.get("WORLD_SIZE", "1"))
LOCAL_RANK = int(os.environ.get("LOCAL_RANK", "0"))
RANK = int(os.environ.get("RANK", "0"))

assert WORLD == 2, f"need 2 GPUs, WORLD_SIZE={WORLD}"
assert os.path.isdir(DATA), f"dataset missing: {DATA} " + str(
    os.listdir("/kaggle/input")
)
if RANK == 0:
    print("dtype-policy=fp32-no-amp", flush=True)

tok = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
tok.pad_token = tok.eos_token
tok.padding_side = "right"


MAXLEN = 1024
TEMPLATE_IDS = tok("<think></think>", add_special_tokens=False)["input_ids"]
assert len(TEMPLATE_IDS) > 0, "think-prefill template ids empty"


def encode(row):
    text = tok.apply_chat_template(
        row["messages"],
        tokenize=False,
        add_generation_prompt=False,
        enable_thinking=False,
    )
    ids = tok(text, add_special_tokens=False, truncation=True, max_length=MAXLEN)[
        "input_ids"
    ]
    start = -1
    for i in range(len(ids) - len(TEMPLATE_IDS) + 1):
        if ids[i : i + len(TEMPLATE_IDS)] == TEMPLATE_IDS:
            start = i + len(TEMPLATE_IDS)
            break
    assert start > 0, "assistant prefill not found in sample"
    return {"input_ids": ids, "labels": [-100] * start + ids[start:]}


def load_split(split):
    ds = load_dataset(
        "json", data_files=os.path.join(DATA, f"expand-{split}.jsonl"), split="train"
    )
    return ds.map(encode, remove_columns=ds.column_names)


train_ds = load_split("train")
eval_ds = load_split("eval")
if RANK == 0:
    lens = sorted(len(x) for x in train_ds["input_ids"])
    print(f"data-ok train={len(train_ds)} eval={len(eval_ds)} tokp99={lens[int(len(lens) * 0.99)]}", flush=True)

bnb = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.float32,
    bnb_4bit_use_double_quant=True,
)
model = AutoModelForCausalLM.from_pretrained(
    MODEL,
    quantization_config=bnb,
    device_map={"": LOCAL_RANK},
    trust_remote_code=True,
    attn_implementation="sdpa",
    torch_dtype=torch.float16,
)
model = prepare_model_for_kbit_training(model)
peft_cfg = LoraConfig(
    r=32,
    lora_alpha=64,
    lora_dropout=0.05,
    target_modules="all-linear",
    task_type="CAUSAL_LM",
)
args = SFTConfig(
    output_dir=OUT,
    num_train_epochs=5,
    per_device_train_batch_size=4,
    per_device_eval_batch_size=4,
    gradient_accumulation_steps=2,
    learning_rate=1e-4,
    lr_scheduler_type="cosine",
    weight_decay=0.01,
    neftune_noise_alpha=5,
    optim="adamw_torch",
    fp16=False,
    bf16=False,
    logging_steps=5,
    eval_strategy="epoch",
    save_strategy="epoch",
    load_best_model_at_end=True,
    metric_for_best_model="eval_loss",
    greater_is_better=False,
    save_total_limit=2,
    seed=42,
    report_to="none",
    ddp_find_unused_parameters=False,
    dataset_text_field=None,
    max_length=1024,
    warmup_steps=5,
)
class PadCollator:
    """Right-pad pre-tokenized batches (labels already masked in map)."""

    def __init__(self, pad_id):
        self.pad_id = pad_id

    def __call__(self, examples):
        width = max(len(ex["input_ids"]) for ex in examples)
        batch_ids, batch_mask, batch_labels = [], [], []
        for ex in examples:
            n = width - len(ex["input_ids"])
            batch_ids.append(ex["input_ids"] + [self.pad_id] * n)
            batch_mask.append([1] * len(ex["input_ids"]) + [0] * n)
            batch_labels.append(ex["labels"] + [-100] * n)
        return {
            "input_ids": torch.tensor(batch_ids),
            "attention_mask": torch.tensor(batch_mask),
            "labels": torch.tensor(batch_labels),
        }


collator = PadCollator(tok.pad_token_id)
trainer = SFTTrainer(
    model=model,
    args=args,
    train_dataset=train_ds,
    eval_dataset=eval_ds,
    peft_config=peft_cfg,
    data_collator=collator,
)
trainer.train()
trainer.save_model(OUT)
if RANK == 0:
    tok.save_pretrained(OUT)
    print("EVAL-TAIL: " + json.dumps(trainer.state.log_history[-4:])[:600], flush=True)
    print("done", flush=True)
'''

CELL_SETUP = """!nvidia-smi -L
import torch
assert torch.cuda.device_count() == 2, torch.cuda.device_count()
print('gpu-ok 2x', torch.cuda.get_device_name(0), torch.__version__, flush=True)"""

CELL_PIP = """!pip install -q trl==1.18.1 peft==0.21.3 bitsandbytes accelerate datasets
import trl, peft, bitsandbytes
assert trl.__version__ == '1.18.1', trl.__version__
print('setup-ok', trl.__version__, peft.__version__, flush=True)"""

CELL_DATA = """!find /kaggle/input -maxdepth 4 | head -20
import json
for s in ('train', 'eval'):
    p = '/kaggle/input/datasets/blonded2/lfm3-expand-sft/expand-%s.jsonl' % s
    n = sum(1 for _ in open(p))
    print('data-ok', s, n, flush=True)"""

CELL_WRITE = "%%writefile /kaggle/working/train.py\n" + TRAIN_PY

CELL_RUN = """!cd /kaggle/working && torchrun --nproc_per_node=2 --master_port=29511 train.py"""

CELL_OUT = """!ls -la /kaggle/working/lfm3-lora/ && du -sh /kaggle/working/lfm3-lora && echo ARTIFACTS-OK"""


def code_cell(source):
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": source.splitlines(keepends=True),
    }


def md_cell(source):
    return {"cell_type": "markdown", "metadata": {}, "source": source.splitlines(keepends=True)}


def main():
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "finetune-lfm3")
    os.makedirs(d, exist_ok=True)
    nb = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.10.0"},
        },
        "cells": [
            md_cell(
                "# LFM3 expansion QLoRA (2x GPU DDP)\n"
                "SFT on (expansion-prompt(draft) -> reply) pairs. No-think render. "
                "Loss on assistant tokens only. Adapter out to /kaggle/working/lfm3-lora."
            ),
            code_cell(CELL_SETUP),
            code_cell(CELL_PIP),
            code_cell(CELL_DATA),
            code_cell(CELL_WRITE),
            code_cell(CELL_RUN),
            code_cell(CELL_OUT),
        ],
    }
    with open(os.path.join(d, "finetune-lfm3-expand.ipynb"), "w") as f:
        json.dump(nb, f)
    with open(os.path.join(d, "kernel-metadata.json"), "w") as f:
        json.dump(
            {
                "id": "blonded2/lfm3-expand-qlora",
                "title": "lfm3 expand qlora",
                "code_file": "finetune-lfm3-expand.ipynb",
                "language": "python",
                "kernel_type": "notebook",
                "is_private": True,
                "enable_gpu": True,
                "enable_internet": True,
                "dataset_sources": ["blonded2/lfm3-expand-sft"],
                "kernel_sources": [],
                "competition_sources": [],
            },
            f,
        )
    print("wrote", d)


if __name__ == "__main__":
    main()
