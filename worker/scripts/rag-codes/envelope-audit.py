#!/usr/bin/env python3
"""10x envelope audit (offline): how much of each reference is (a) covered
by book moves (skeleton match), (b) novel values vs instruction-echoed
values. Floor = novel values + 2 tok/line + uncovered words in full.
Reports ceiling p50 + coverage@10x: the number that decides the build.
Run from repo root: .venv/bin/python worker/scripts/rag-codes/envelope-audit.py
"""
import csv
import json
import os
import re
import statistics as s

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
VAL = re.compile(r'\{\{[^}]+\}\}|https?://\S+|[\w.+-]+@[\w-]+\.[\w.]+|\d[\d,./:-]*\d|\d+|\$[\d,]+')


def skel(t):
    # Drop placeholders AND values: skeletons carry move shape only.
    t = re.sub(r'\{\{[^}]+\}\}|\{[^}]+\}', ' ', t.lower())
    t = re.sub(r'https?://\S+|[\w.+-]+@[\w-]+\.[\w.]+|\d[\d,./:-]*', ' ', t)
    t = re.sub(r'[^a-z\s]', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()


def sents(t):
    return [x.strip() for x in re.split(r'(?<=[.!?])\s+', t) if len(x.strip()) > 8]


def main() -> None:
    book = [e['template'] for e in json.load(open(os.path.join(ROOT, 'data/derived/dict-ir-v2.json')))['entries']]
    bsk = [skel(t) for t in book]
    rows = [json.loads(l) for l in open(os.path.join(ROOT, 'data/derived/ir-pilot-v2.jsonl')) if json.loads(l)['arm'] == 'compress']
    rd = list(csv.DictReader(open(os.path.join(ROOT, 'data/bitext/bitext-27k.csv'))))
    ceils, covs = [], []
    for r in rows:
        ref = r['reference']
        m = re.match(r'bitext-(\d+)$', r['key'])
        instr = rd[int(m.group(1))]['instruction'].lower() if m else ''
        floor = 0
        covered = total = 0
        for sent in sents(ref):
            total += 1
            # containment: template content words present in the sentence?
            swords = set(skel(sent).split())
            best = 0.0
            for b in bsk:
                bw = b.split()
                if bw:
                    best = max(best, sum(1 for w in bw if w in swords) / len(bw))
            vals = VAL.findall(sent)
            novel = [v for v in vals if v.lower() not in instr]
            if best >= 0.6:
                covered += 1
                floor += 2 + sum(len(v.split()) for v in novel)
            else:
                floor += len(sent.split())
        ceils.append(len(ref.split()) / max(1, floor))
        covs.append(covered / max(1, total))
    ceils.sort()
    print(f'rows={len(ceils)} moveCoverP50={s.median(covs):.0%} ceilingP50={s.median(ceils):.1f}x ' f'coverage@10x={sum(1 for c in ceils if c >= 10) / len(ceils):.0%}')
    print('ceiling p10/p25/p75/p90:', [f'{ceils[int(len(ceils) * q)]:.1f}x' for q in (0.1, 0.25, 0.75, 0.9)])


main()
