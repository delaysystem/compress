#!/usr/bin/env python3
"""RAG-code prototype, step 1 (local): embed bitext instructions (minus eval
keys) with all-MiniLM-L6-v2 into data/derived/rag-store.jsonl.
Batched, resume-safe, crash-safe (flush per batch). ~27k rows, CPU minutes.
Run from repo root: .venv/bin/python worker/scripts/rag-codes/build-store.py [--limit N] [--force]
"""
import csv
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STORE = os.path.join(ROOT, 'data', 'derived', 'rag-store.jsonl')
BATCH = 512


def main() -> None:
    limit = None
    args = sys.argv[1:]
    if '--force' in args:
        args.remove('--force')
        if os.path.exists(STORE):
            os.remove(STORE)
    if '--limit' in args:
        limit = int(args[args.index('--limit') + 1])
    eval_keys = set()
    with open(os.path.join(ROOT, 'data', 'derived', 'ir-pilot-v2.jsonl')) as f:
        for line in f:
            r = json.loads(line)
            if r['arm'] == 'compress':
                eval_keys.add(r['key'])
    with open(os.path.join(ROOT, 'data', 'bitext', 'bitext-27k.csv')) as f:
        rows = list(csv.DictReader(f))
    items = [
        {'id': f'bitext-{i}', 'instruction': r['instruction'] or '', 'response': r['response'] or ''}
        for i, r in enumerate(rows)
        if f'bitext-{i}' not in eval_keys and (r['instruction'] or '')
    ]
    if limit:
        items = items[:limit]
    done = set()
    if os.path.exists(STORE):
        with open(STORE) as f:
            for line in f:
                if line.strip():
                    done.add(json.loads(line)['id'])
    pending = [r for r in items if r['id'] not in done]
    print(f'items: {len(pending)} (store has {len(done)})', flush=True)
    if not pending:
        return
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer('all-MiniLM-L6-v2')
    dim = None
    with open(STORE, 'a') as out:
        for i in range(0, len(pending), BATCH):
            batch = pending[i : i + BATCH]
            embs = model.encode([b['instruction'] for b in batch], show_progress_bar=False)
            if dim is None:
                dim = embs.shape[1]
            assert embs.shape[1] == dim, (embs.shape, dim)
            for b, e in zip(batch, embs):
                out.write(json.dumps({**b, 'emb': [round(float(x), 6) for x in e]}) + '\n')
            out.flush()
            print(f'batches: {i // BATCH + 1}/{(len(pending) + BATCH - 1) // BATCH} dim={dim}', flush=True)
    print('done:', STORE)


main()
