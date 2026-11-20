#!/usr/bin/env python3
"""Cap the vector store: stratified sample (100/intent, 27 intents = 2700
rows) replacing the full build. The small store is the canonical artifact;
the full file is regenerable and deleted to honor the footprint budget.
Run from repo root: .venv/bin/python worker/scripts/rag-codes/prune-store.py
"""
import csv
import json
import os
import random
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STORE = os.path.join(ROOT, 'data', 'derived', 'rag-store.jsonl')
PER_INTENT = 100
MAX_ROWS = 3000


def main() -> None:
    with open(os.path.join(ROOT, 'data', 'bitext', 'bitext-27k.csv')) as f:
        intents = [r['intent'] for r in csv.DictReader(f)]
    by_intent = defaultdict(list)
    with open(STORE) as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            n = int(r['id'].split('-')[1])
            by_intent[intents[n]].append(r)
    random.seed(7)
    kept = []
    for intent, rows in sorted(by_intent.items()):
        kept += random.sample(rows, min(PER_INTENT, len(rows)))
    assert len(kept) <= MAX_ROWS, len(kept)
    tmp = STORE + '.small'
    with open(tmp, 'w') as out:
        for r in kept:
            out.write(json.dumps(r) + '\n')
    os.replace(tmp, STORE)
    size = os.path.getsize(STORE)
    print(f'store: {len(kept)} rows, {size / 1e6:.1f} MB (cap {MAX_ROWS})')


main()
