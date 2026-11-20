#!/usr/bin/env python3
"""Ceiling model on synthetic staging traffic: per agent turn, floor =
exact slot values + 2 tok/line overhead; ceiling = ref/floor. Reports
coverage@10x + cross-turn value-repeat rate (span amortization headroom).
Run from repo root: .venv/bin/python worker/scripts/rag-codes/synth-ceiling.py <synth-file>
"""
import json
import os
import re
import statistics as s
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
VAL = re.compile(r'ORD-\d+|INV-\d+|\$\d+\.\d\d|https?://\S+|1-800-555-\d+|2026-11-\d+|Mon-Fri 9am-5pm|24/7|Mon-Sat 8am-8pm')


def main() -> None:
    rows = [json.loads(l) for l in open(os.path.join(ROOT, 'data', 'derived', sys.argv[1]))]
    ceils = []
    amort = []
    rep = tot = 0
    for r in rows:
        seen = set()
        for t in r['turns']:
            vals = VAL.findall(t['a'])
            toks = 0
            atoks = 0
            for v in vals:
                w = len(v.split())
                toks += w
                tot += w
                if v in seen:
                    rep += w
                    # repeated value: 2-tok ref, unless inline is cheaper
                    atoks += min(w, 2)
                else:
                    atoks += w
                    seen.add(v)
            ref_tok = len(t['a'].split())
            # floor: value words + 2 tok/line overhead (moves+wire)
            nlines = max(1, len(t['moves']) if t['moves'] else 1)
            ceils.append(ref_tok / max(1, toks + 2 * nlines))
            amort.append(ref_tok / max(1, atoks + 2 * nlines))
    ceils.sort()
    amort.sort()
    print(f'turns={sum(len(r["turns"]) for r in rows)} ceilingP50={s.median(ceils):.1f}x ' f'coverage@10x={sum(1 for c in ceils if c >= 10) / len(ceils):.0%} ' f'repeatRate={rep / max(1, tot):.0%} ' f'amortP50={s.median(amort):.1f}x')


main()
