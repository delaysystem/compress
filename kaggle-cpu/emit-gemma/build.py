#!/usr/bin/env python3
"""Regenerate emit-gemma.ipynb cell 2 from _main.py.txt.

PROMPT_HEAD is preserved verbatim from the current notebook. REFS are
preserved verbatim by default (same 100-row experiment); with
--subset-missing <rows.jsonl>, only refs whose keys are absent from that
rows file are stamped (resume a parked campaign on the kernel).
__ARITIES__ is stamped fresh from data/derived/dict-ir-v2.json.
Run from repo root, e.g.:
  python3 kaggle-cpu/emit-gemma/build.py
  python3 kaggle-cpu/emit-gemma/build.py --subset-missing data/derived/emit-dict.jsonl
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))

ap = argparse.ArgumentParser()
ap.add_argument('--subset-missing', default=None)
args = ap.parse_args()

nb_path = os.path.join(HERE, 'emit-gemma.ipynb')
nb = json.load(open(nb_path))
cell = nb['cells'][2]
assert cell['cell_type'] == 'code', cell['cell_type']
old_src = ''.join(cell['source'])
head_line = next(
    l for l in old_src.split('\n') if l.startswith('PROMPT_HEAD = ')
)
refs_line = next(l for l in old_src.split('\n') if l.startswith('REFS = '))
assert '__HEAD__' not in head_line and '__REFS__' not in refs_line

if args.subset_missing:
    banked = {
        json.loads(l)['key']
        for l in open(os.path.join(ROOT, args.subset_missing))
        if l.strip()
    }
    inner = (
        refs_line[len("REFS = json.loads('") : -2]
        .replace('\\\\', '\\')
        .replace("\\'", "'")
    )
    preserved = json.loads(inner)
    v2 = [
        json.loads(l)
        for l in open(os.path.join(ROOT, 'data', 'derived', 'ir-pilot-v2.jsonl'))
    ]
    held = [(r['key'], r['reference']) for r in v2 if r['arm'] == 'compress'][
        100:200
    ]
    assert [r['key'] for r in preserved] == [k for k, _ in held], (
        'REFS key drift'
    )
    assert all(
        r['reference'] == ref for r, (_k, ref) in zip(preserved, held)
    ), 'REFS content drift'
    refs = [r for r in preserved if r['key'] not in banked]
    assert refs, 'subset empty: nothing pending'
    print('subset:', len(refs), 'pending of', len(preserved))
    refs_line = (
        "REFS = json.loads('"
        + json.dumps(refs).replace('\\', '\\\\').replace("'", "\\'")
        + "')"
    )

# End-to-end stamp check: execute the two lines exactly as the kernel
# will, so a quoting bug fails here instead of on Kaggle.
probe = {}
exec(head_line, {}, probe)
exec(refs_line, {'json': json}, probe)
print('stamp check: head', len(probe['PROMPT_HEAD']), 'refs', len(probe['REFS']))

tmpl = open(os.path.join(HERE, '_main.py.txt')).read()
assert 'PROMPT_HEAD = __HEAD__' in tmpl
assert 'REFS = json.loads(__REFS__)' in tmpl
assert 'ARITIES = json.loads(__ARITIES__)' in tmpl

book = json.load(open(os.path.join(ROOT, 'data', 'derived', 'dict-ir-v2.json')))
arities = {e['code']: len(e['slots']) for e in book['entries']}
ar_line = f"ARITIES = json.loads('{json.dumps(arities)}')"
print('arities:', len(arities))

new_src = tmpl.replace('PROMPT_HEAD = __HEAD__', head_line)
new_src = new_src.replace('REFS = json.loads(__REFS__)', refs_line)
new_src = new_src.replace('ARITIES = json.loads(__ARITIES__)', ar_line)
assert '__HEAD__' not in new_src and '__REFS__' not in new_src
assert '__ARITIES__' not in new_src
compile(new_src, 'emit-gemma-cell2', 'exec')

lines = new_src.split('\n')
cell['source'] = [ln + '\n' for ln in lines[:-1]] + (
    [lines[-1]] if lines[-1] else []
)
cell['outputs'] = []
cell['execution_count'] = None
json.dump(nb, open(nb_path, 'w'))
print('rebuilt + valid:', nb_path)
