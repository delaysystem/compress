#!/usr/bin/env python3
"""Multi-turn amortization gate (offline, free): across doc2dial +
multidoc2dial validation dials, measure what fraction of each agent turn's
entity tokens already appeared in earlier turns of the same dial. High
repetition => a conversation span store amortizes; low => turns are
independent and amortization is fantasy.
Run from repo root: .venv/bin/python worker/scripts/rag-codes/repeat-gate.py
"""
import json
import os
import re
import statistics as s

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENT = re.compile(r'\{\{[^}]+\}\}|https?://\S+|[\w.+-]+@[\w-]+\.[\w.]+|\d[\d,./:-]*\d|\d+|\$[\d,]+|"[^"]{3,}"')


def dials_of(path):
    d = json.load(open(path))['dial_data']
    out = []

    def walk(o):
        if isinstance(o, dict):
            if 'turns' in o and isinstance(o['turns'], list):
                out.append(o['turns'])
            else:
                for v in o.values():
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(d)
    return out


def main() -> None:
    files = [
        'data/doc2dial/doc2dial_dial_validation.json',
        'data/multidoc2dial/multidoc2dial/multidoc2dial_dial_validation.json',
    ]
    rep_tok = tot_tok = 0
    rep_turns = tot_turns = 0
    per_turn = []
    for f in files:
        for turns in dials_of(os.path.join(ROOT, f)):
            seen = set()
            for t in turns:
                utt = t.get('utterance') or ''
                ents = ENT.findall(utt)
                if t.get('role') == 'agent':
                    toks = sum(len(e.split()) for e in ents)
                    if toks:
                        tot_turns += 1
                        hit = sum(len(e.split()) for e in ents if e.lower() in seen)
                        tot_tok += toks
                        rep_tok += hit
                        per_turn.append(hit / toks)
                        if hit / toks >= 0.5:
                            rep_turns += 1
                for e in ents:
                    seen.add(e.lower())
    print(f'turns={tot_turns} repeatedEntityTok={rep_tok}/{tot_tok}={rep_tok / max(1, tot_tok):.0%}')
    print(f'turns>=50% repeated: {rep_turns}/{tot_turns}={rep_turns / max(1, tot_turns):.0%}')
    print(f'per-turn repeat p50={s.median(per_turn):.0%}' if per_turn else 'no measurable turns')
    print('GATE:', 'PASS' if rep_tok / max(1, tot_tok) >= 0.25 else 'FAIL')


main()
