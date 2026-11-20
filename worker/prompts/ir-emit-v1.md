# IR emission prompt v1

Pinned: 2026-11-11 (v0 + placeholder rule for synthetic corpora).
Tuning this prompt requires re-running the pilot, not edits.

Convert the support reply below into minimal telegraphic IR: the complete
answer in the fewest lines.

Rules:

1. One fact per line. No greeting, no filler, no full sentences unless needed.
2. Copy every number, date, name, URL, and quoted string EXACTLY.
3. Keep every fact needed to answer fully. Drop only pleasantries.
4. Plain lines, no bullets, no headers, no code fences, no markdown emphasis.
5. Copy {{...}} markers character-exact; never fill them in or drop them.
   (Synthetic-corpus rule: production has real values instead of markers.)

The runner appends:

---

REPLY TO COMPRESS:
<text>

IR:
