#!/usr/bin/env python3
"""Span-KB gate (offline, free): for doc2dial agent turns, measure what
fraction of answer content words (and entities) appear verbatim in the
turn's own cited spans. PASS (>=60%) means a span-IR could carry pointers
instead of values; below that the track stops before any pilot.
Run from repo root: .venv/bin/python worker/scripts/rag-codes/span-gate.py
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
STOP = set(
    'the a an and or but of to in on for with is are was were be been it its this that these those you your we our they their he she him her i me my as at by from will would can could should have has had do does did not no yes if then than so such no yes ok okay please thank thanks hello hi'.split()
)
ENT = re.compile(r'\{\{[^}]+\}\}|https?://\S+|[\w.+-]+@[\w-]+\.[\w.]+|\d[\d,./:-]*\d|\d+|\$[\d,]+')


def words(t):
    return [w for w in re.sub(r'[^a-z0-9\s]', ' ', t.lower()).split() if w not in STOP and len(w) > 3]


def main() -> None:
    dials = json.load(open(os.path.join(ROOT, 'data/doc2dial/doc2dial_dial_validation.json')))['dial_data']
    docs = json.load(open(os.path.join(ROOT, 'data/doc2dial/doc2dial_doc.json')))['doc_data']
    flat_docs = {}
    for group in docs.values():
        for doc_id, doc in group.items():
            flat_docs[doc_id] = doc
    cov_words = cov_den = 0
    ent_hit = ent_tot = 0
    turns = 0
    for domain in dials.values():
        for group in domain.values():
            for dial in group:
                doc = flat_docs.get(dial['doc_id'], {})
                spans = doc.get('spans', {}) if isinstance(doc, dict) else {}
                for turn in dial['turns']:
                    if turn['role'] != 'agent' or turn['da'] != 'respond_solution':
                        continue
                    cited = ' '.join(
                        (spans.get(r['sp_id'], {}) or {}).get('text_sp', '') for r in turn.get('references', [])
                    ).lower()
                    if not cited.strip():
                        continue
                    turns += 1
                    for w in words(turn['utterance']):
                        cov_den += 1
                        if w in cited:
                            cov_words += 1
                    for e in ENT.findall(turn['utterance']):
                        ent_tot += 1
                        if e.lower() in cited:
                            ent_hit += 1
    print(f'turns={turns} wordCoverage={cov_words}/{cov_den}={cov_words / max(1, cov_den):.0%} ' f'entityCoverage={ent_hit}/{ent_tot}={ent_hit / max(1, ent_tot):.0%}')
    print('GATE:', 'PASS' if cov_words / max(1, cov_den) >= 0.6 else 'FAIL')


main()
