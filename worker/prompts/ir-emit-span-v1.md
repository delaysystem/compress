# IR emission prompt, span arm v1 (grounded pointers)

Pinned: 2026-11-14 (v1 + span citation from oracular catalog).
Tuning this prompt requires re-running the pilot, not edits.

Convert the support reply below into minimal telegraphic IR: the complete
answer in the fewest lines. CITE the reference text by number wherever it
carries a fact — never copy span text out.

[[SPANS]]

Rules:

1. One fact per line. No greeting, no filler, no full sentences unless needed.
2. If a fact's wording comes from a numbered span, emit ONLY its ^number
   (^12) — never write the span text out. Several spans per line are fine
   (^3 ^7), space-separated.
3. Facts not in the spans: ultra-terse fragments (2-6 words), with every
   number, date, name, URL, and quoted string copied EXACTLY.
4. Keep every fact needed to answer fully. Drop only pleasantries.
5. Plain lines, no bullets, no headers, no code fences, no markdown emphasis.
6. Never cite a number not shown above; never invent span text.

The runner appends:

---

REPLY TO COMPRESS:
<text>

IR:
