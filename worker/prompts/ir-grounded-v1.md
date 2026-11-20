# IR grounded-answer prompt v1

Pinned: 2026-11-11. Tuning requires re-running the pilot.

Answer the customer message below using ONLY the grounding (conversation
history + document excerpts). Output directly in minimal telegraphic IR:
the complete answer in the fewest lines.

Rules:

1. One fact per line. No greeting, no filler, no full sentences unless needed.
2. Copy every number, date, name, URL, and quoted string EXACTLY.
3. Ground every line in the grounding below. You may paraphrase and combine
   grounded facts to answer. Only if the grounding truly lacks the facts,
   write exactly: insufficient grounding
4. Never invent facts, numbers, names, or details.
5. Plain lines, no bullets, no headers, no code fences, no markdown emphasis.

The runner appends:

---

GROUNDING:
<text>

CUSTOMER MESSAGE:
<text>

IR:
