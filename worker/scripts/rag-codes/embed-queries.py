#!/usr/bin/env python3
"""RAG-code prototype, step 1b (local): embed held-out bitext instructions
for retrieve-eval.ts. One process, seconds.
Run from repo root: .venv/bin/python worker/scripts/rag-codes/embed-queries.py
"""
import csv
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def main() -> None:
    keys = []
    with open(os.path.join(ROOT, 'data', 'derived', 'ir-pilot-v2.jsonl')) as f:
        for line in f:
            r = json.loads(line)
            if r['arm'] == 'compress':
                keys.append(r['key'])
    keys = [k for k in keys[100:200] if k.startswith('bitext-')]
    with open(os.path.join(ROOT, 'data', 'bitext', 'bitext-27k.csv')) as f:
        rows = list(csv.DictReader(f))
    items = [(k, rows[int(k.split('-')[1])]['instruction'] or '') for k in keys]
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer('all-MiniLM-L6-v2')
    embs = model.encode([t for _, t in items], show_progress_bar=False)
    with open(os.path.join(ROOT, 'data', 'derived', 'rag-queries.jsonl'), 'w') as out:
        for (k, _), e in zip(items, embs):
            out.write(json.dumps({'id': k, 'emb': [round(float(x), 6) for x in e]}) + '\n')
    print(f'queries: {len(items)} dim={embs.shape[1]}')


main()
