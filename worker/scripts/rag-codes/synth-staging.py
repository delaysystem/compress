#!/usr/bin/env python3
"""Synthetic staging-like traffic (offline): formulaic multi-turn support
conversations with controllable repeat rate. Agent replies compose from
book moves (bookAdherence share) plus free variation; values come from
pools (small pool = high cross-turn repeat). Labeled MODELLED, not measured.
Run from repo root: .venv/bin/python worker/scripts/rag-codes/synth-staging.py [--pool 50] [--adh 0.7] [--n 200]
"""
import json
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# Intent -> 4-6 ir-v2 moves + free fallbacks, calibrated to bitext reply
# shape (~100 words/agent turn). adh controls book coverage (the knob
# under test); carry controls cross-turn value persistence.
INTENTS = {
    'cancel_order': {
        'qs': ['Cancel order {order}.', 'I want to cancel {order}.', 'Please cancel my order {order}.', 'How do I cancel {order}?'],
        'moves': ['k', 'n', 'o', 'h', 'aa', 'd'],
        'free': ['Done, {order} is cancelled.', 'Your order {order} has been cancelled.'],
    },
    'track_refund': {
        'qs': ['Where is my refund for {order}?', 'Check refund status for {order}.', 'Has my refund for {order} arrived?'],
        'moves': ['ac', 'af', 'z', 'd', 'p'],
        'free': ['Refund of {amount} is on its way.', 'Still processing the {amount} refund.'],
    },
    'recover_password': {
        'qs': ['I forgot my password.', 'Reset my password.', 'Cannot log in, need a reset.'],
        'moves': ['g', 'h', 'ag', 'ae', 'ah'],
        'free': ['A reset link is on its way.', 'Check your inbox for the reset link.'],
    },
    'contact_human': {
        'qs': ['Let me talk to a human.', 'I need a live agent.', 'Connect me to support.'],
        'moves': ['b', 'c', 'd', 'af', 'aj'],
        'free': ['An agent will join shortly.', 'Connecting you now.'],
    },
    'check_invoice': {
        'qs': ['Send me invoice {inv}.', 'Where is invoice {inv}?', 'I need a copy of {inv}.'],
        'moves': ['u', 'y', 'ae', 'w', 'af'],
        'free': ['Invoice {inv} is attached.', 'Here is {inv}.'],
    },
    'shipping': {
        'qs': ['Where is my package {order}?', 'Track {order}.', 'Delivery status for {order}?'],
        'moves': ['w', 'e', 's', 'y', 'l'],
        'free': ['Arriving {date}.', 'Out for delivery, {date}.'],
    },
}

FILLER = [
    'Sure, I can help with that!',
    'Thanks for reaching out to us today.',
    'I understand how important this is to you.',
    'Let me know if you need anything else.',
    'Happy to help with this.',
    'Your satisfaction is our top priority.',
]

GENERIC_FILL = ['the issue', 'your request', 'the details', 'that order', 'the account']
SLOT_POOLS = {'hours': 'hours', 'phone': 'phone', 'url': 'url', 'email': 'email', 'amount': 'amount', 'date': 'date', 'inv': 'inv', 'order': 'order', 'id': 'order', 'loc': 'url'}


def val(pool, kind, rng):
    return rng.choice(pool[kind])


def main() -> None:
    args = sys.argv[1:]
    pool_n = int(args[args.index('--pool') + 1]) if '--pool' in args else 50
    adh = float(args[args.index('--adh') + 1]) if '--adh' in args else 0.7
    carry = float(args[args.index('--carry') + 1]) if '--carry' in args else 0.7
    n = int(args[args.index('--n') + 1]) if '--n' in args else 200
    seed = int(args[args.index('--seed') + 1]) if '--seed' in args else 7
    rng = random.Random(seed)
    import re  # noqa: E402  (kept local: single-file script)

    book = {e['code']: e['template'] for e in json.load(open(os.path.join(ROOT, 'data/derived/dict-ir-v2.json')))['entries']}
    pool = {
        'order': [f'ORD-{10000 + i}' for i in rng.sample(range(90000), pool_n)],
        'amount': [f'${rng.randint(5, 500)}.00' for _ in range(pool_n)],
        'url': [f'https://support.example.com/{rng.choice(["chat", "help", "portal"])}' for _ in range(20)],
        'hours': ['Mon-Fri 9am-5pm', '24/7', 'Mon-Sat 8am-8pm'],
        'phone': [f'1-800-555-{1000 + i}' for i in rng.sample(range(9000), 20)],
        'inv': [f'INV-{20000 + i}' for i in rng.sample(range(80000), pool_n)],
        'date': [f'2026-11-{rng.randint(1, 28)}' for _ in range(28)],
    }
    out = []
    names = list(INTENTS)
    for c in range(n):
        intent = names[c % len(names)]
        spec = INTENTS[intent]
        turns = []
        nturns = rng.choice([2, 3, 3, 4])
        carried = {}  # topic continuity: values persist across turns

        def fill(tpl):
            def pick(k):
                if k in carried and rng.random() < carry:
                    return carried[k]
                v = val(pool, k, rng)
                carried[k] = v
                return v

            for k in ('order', 'amount', 'url', 'hours', 'phone', 'inv', 'date'):
                tpl = tpl.replace('{' + k + '}', pick(k))
            return tpl

        for t in range(nturns):
            q = fill(rng.choice(spec['qs']))
            agent_moves = []
            agent_text = rng.sample(FILLER, 2)
            for code in spec['moves']:
                if rng.random() < adh:
                    agent_moves.append(code)
                    tpl = book[code]
                    for slot in re.findall(r'\{(\w+)\}', tpl):
                        pk = SLOT_POOLS.get(slot)
                        v = fill('{' + pk + '}') if pk else rng.choice(GENERIC_FILL)
                        tpl = tpl.replace('{' + slot + '}', v, 1)
                    agent_text.append(tpl)
                else:
                    agent_text.append(fill(rng.choice(spec['free'])))
            agent_text += rng.sample(FILLER, 2)
            turns.append({'q': q, 'a': ' '.join(agent_text), 'moves': agent_moves})
        out.append({'conv': c, 'intent': intent, 'turns': turns})
    tag = f"pool{pool_n}-adh{adh}-carry{carry}-n{n}"
    with open(os.path.join(ROOT, 'data', 'derived', f'staging-synth-{tag}.jsonl'), 'w') as f:
        for r in out:
            f.write(json.dumps(r) + '\n')
    print(f'wrote staging-synth-{tag}.jsonl: {n} convs')


main()
