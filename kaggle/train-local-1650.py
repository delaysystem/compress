"""Local QLoRA SFT for LFM3 expansion on GTX 1650 4GB (run 057).

Same recipe as the Kaggle kernel (v13 hparams), optimized for one small GPU:
fp16 compute + AMP, gradient checkpointing, 8-bit Adam, micro-batch 2 x 8
accum (eff 16, matches Kaggle). Run from repo root:
  .venv/bin/python kaggle/train-local-1650.py
"""

import json
import os

import torch
from datasets import load_dataset
from peft import LoraConfig, prepare_model_for_kbit_training
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = 'LiquidAI/LFM3-1.7B'
DATA = os.path.join(ROOT, 'data', 'sft')
OUT = os.path.join(ROOT, 'vendor', 'models', 'lfm3-expand-lora-v13b')

assert torch.cuda.is_available(), 'need CUDA'
print('gpu', torch.cuda.get_device_name(0), flush=True)

tok = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
tok.pad_token = tok.eos_token
tok.padding_side = 'right'

MAXLEN = 1024
TEMPLATE_IDS = tok('<think></think>', add_special_tokens=False)['input_ids']
assert len(TEMPLATE_IDS) > 0


def encode(row):
    text = tok.apply_chat_template(
        row['messages'],
        tokenize=False,
        add_generation_prompt=False,
        enable_thinking=False,
    )
    ids = tok(text, add_special_tokens=False, truncation=True, max_length=MAXLEN)[
        'input_ids'
    ]
    start = -1
    for i in range(len(ids) - len(TEMPLATE_IDS) + 1):
        if ids[i : i + len(TEMPLATE_IDS)] == TEMPLATE_IDS:
            start = i + len(TEMPLATE_IDS)
            break
    assert start > 0, 'assistant prefill not found in sample'
    return {'input_ids': ids, 'labels': [-100] * start + ids[start:]}


def load_split(split):
    ds = load_dataset(
        'json', data_files=os.path.join(DATA, f'expand-{split}.jsonl'), split='train'
    )
    return ds.map(encode, remove_columns=ds.column_names)


train_ds = load_split('train')
eval_ds = load_split('eval')
lens = sorted(len(x) for x in train_ds['input_ids'])
print(
    f'data-ok train={len(train_ds)} eval={len(eval_ds)} tokp99={lens[int(len(lens) * 0.99)]}',
    flush=True,
)

bnb = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type='nf4',
    bnb_4bit_compute_dtype=torch.float16,
    bnb_4bit_use_double_quant=True,
)
model = AutoModelForCausalLM.from_pretrained(
    MODEL,
    quantization_config=bnb,
    device_map='cuda:0',
    trust_remote_code=True,
    attn_implementation='sdpa',
    torch_dtype=torch.float16,
)
model = prepare_model_for_kbit_training(model)
model.gradient_checkpointing_enable()
peft_cfg = LoraConfig(
    r=32,
    lora_alpha=64,
    lora_dropout=0.05,
    target_modules='all-linear',
    task_type='CAUSAL_LM',
)
args = SFTConfig(
    output_dir=OUT,
    num_train_epochs=4,
    per_device_train_batch_size=2,
    per_device_eval_batch_size=2,
    gradient_accumulation_steps=8,
    learning_rate=2e-4,
    lr_scheduler_type='cosine',
    weight_decay=0.01,
    optim='adamw_bnb_8bit',
    fp16=False,
    bf16=False,
    gradient_checkpointing=True,
    logging_steps=5,
    eval_strategy='epoch',
    save_strategy='epoch',
    load_best_model_at_end=True,
    metric_for_best_model='eval_loss',
    greater_is_better=False,
    save_total_limit=2,
    seed=42,
    report_to='none',
    dataset_text_field=None,
    max_length=MAXLEN,
    warmup_steps=5,
)


class PadCollator:
    def __init__(self, pad_id):
        self.pad_id = pad_id

    def __call__(self, examples):
        width = max(len(ex['input_ids']) for ex in examples)
        batch_ids, batch_mask, batch_labels = [], [], []
        for ex in examples:
            n = width - len(ex['input_ids'])
            batch_ids.append(ex['input_ids'] + [self.pad_id] * n)
            batch_mask.append([1] * len(ex['input_ids']) + [0] * n)
            batch_labels.append(ex['labels'] + [-100] * n)
        return {
            'input_ids': torch.tensor(batch_ids),
            'attention_mask': torch.tensor(batch_mask),
            'labels': torch.tensor(batch_labels),
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
import glob

ckpts = sorted(glob.glob(os.path.join(OUT, 'checkpoint-*')))
resume = ckpts[-1] if ckpts else None
print(f'resume={resume}', flush=True)
trainer.train(resume_from_checkpoint=resume)
trainer.save_model(OUT)
tok.save_pretrained(OUT)
print('EVAL-TAIL: ' + json.dumps(trainer.state.log_history[-6:])[:800], flush=True)
print('done', flush=True)
