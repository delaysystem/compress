#!/usr/bin/env python3
"""Build effort.ipynb from the proven shootout notebook + _tail.py.txt.

Run from worker/: python3 ../kaggle-cpu/effort/build.py
"""
import json

NEWMODELS = """MODELS = [
    ('gptoss', 'unsloth/gpt-oss-20b-GGUF', 'gpt-oss-20b-Q6_K.gguf'),
    ('gemma4', 'unsloth/gemma-4-26B-A4B-it-GGUF',
     'gemma-4-26B-A4B-it-UD-Q6_K.gguf'),
    ('gemma12', 'unsloth/gemma-4-12b-it-GGUF', 'gemma-4-12b-it-Q6_K.gguf'),
    ('lfm25', 'LiquidAI/LFM2.5-24B-A2B-GGUF', 'LFM2.5-24B-A2B-Q6_K.gguf'),
]
"""

nb = json.load(open('../kaggle-cpu/eval/cpu-shootout.ipynb'))
NEWTAIL = open('../kaggle-cpu/effort/_tail.py.txt').read()
n_m = n_t = 0
for c in nb['cells']:
    s = ''.join(c['source'])
    s = s.replace("KID = 'cpu-shootout'", "KID = 'cpu-effort'").replace(
        'PORT = 8080', 'PORT = 8084'
    )
    if c['cell_type'] == 'code' and s.startswith('MODELS = ['):
        i = s.index('MODELS = [')
        j = s.index(']\n', i) + 2
        s = s[:i] + NEWMODELS + s[j:]
        n_m += 1
    if c['cell_type'] == 'code' and 'def chat(prompt):' in s:
        i = s.index('def chat(prompt):')
        s = s[:i] + NEWTAIL.strip() + '\n'
        n_t += 1
    lines = s.split('\n')
    c['source'] = [ln + '\n' for ln in lines[:-1]] + ([lines[-1]] if lines[-1] else [])
assert (n_m, n_t) == (1, 1), (n_m, n_t)
for c in nb['cells']:
    if c['cell_type'] == 'code':
        compile(''.join(c['source']), 'x', 'exec')
full = json.dumps(nb)
for probe in [
    'cpu-effort',
    'PORT = 8084',
    'reasoning_effort',
    'replies-effort.jsonl',
    'unsloth/gemma-4-12b-it-GGUF',
    'LiquidAI/LFM2.5-24B-A2B-GGUF',
]:
    assert probe in full, probe
json.dump(nb, open('../kaggle-cpu/effort/effort.ipynb', 'w'))
print('effort kernel built + valid')
