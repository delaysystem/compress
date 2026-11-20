#!/usr/bin/env python3
"""Span pilot sample builder (offline): select 100 doc2dial validation agent
turns with cited spans; emit per-turn request maps (oracle-cited spans
enumerated ^1..^N) + question + native reference.
Retrieval is out of scope (oracle isolates the compression question).
Run from repo root: .venv/bin/python worker/scripts/rag-codes/span-sample.py
"""
import json
import os
import random

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
N = 100


def main() -> None:
    dials = json.load(open(os.path.join(ROOT, 'data/doc2dial/doc2dial_dial_validation.json')))['dial_data']
    docs = json.load(open(os.path.join(ROOT, 'data/doc2dial/doc2dial_doc.json')))['doc_data']
    flat = {}
    for group in docs.values():
        for doc_id, doc in group.items():
            flat[doc_id] = doc
    cands = []
    for domain in dials.values():
        for group in domain.values():
            for dial in group:
                doc = flat.get(dial['doc_id'], {})
                spans = doc.get('spans', {}) if isinstance(doc, dict) else {}
                turns = dial['turns']
                for i, turn in enumerate(turns):
                    if turn['role'] != 'agent' or turn['da'] != 'respond_solution':
                        continue
                    cited = []
                    for r in turn.get('references', []):
                        t = (spans.get(r['sp_id'], {}) or {}).get('text_sp', '').strip()
                        if t:
                            cited.append(t)
                    if not cited:
                        continue
                    q = ''
                    for prev in reversed(turns[:i]):
                        if prev['role'] == 'user':
                            q = prev['utterance']
                            break
                    # dedupe spans, keep order
                    seen, uniq = set(), []
                    for t in cited:
                        if t not in seen:
                            seen.add(t)
                            uniq.append(t)
                    cands.append({
                        # dial_id-scoped: doc_id#turn collides across dials sharing a doc
                        'key': f"{dial['dial_id']}#{turn['turn_id']}",
                        'doc_id': dial['doc_id'],
                        'question': q,
                        'reference': turn['utterance'],
                        'spans': uniq,
                    })
    random.seed(7)
    sample = random.sample(cands, min(N, len(cands)))
    with open(os.path.join(ROOT, 'data/derived/span-sample.jsonl'), 'w') as out:
        for r in sample:
            out.write(json.dumps(r) + '\n')
    print(f'candidates: {len(cands)}, sampled: {len(sample)}')


main()
