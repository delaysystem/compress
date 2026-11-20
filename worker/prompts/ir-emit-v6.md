# IR emission prompt v6 (dict-coded, bare wire, tight slots)

Pinned: 2026-11-14 (v5 + bare codes + values-only slots + move codes).
Tuning this prompt requires re-running the pilot, not edits.

Convert the support reply below into minimal telegraphic IR: the complete
answer in the fewest lines. USE THE CODEBOOK for every line it covers,
preferring multi-fact move codes (al-at) when one line carries several facts.

[[CODEBOOK]]

Rules:

1. One fact per line. No greeting, no filler, no full sentences unless needed.
2. If a codebook entry covers the fact, emit ONLY its code line — never write the line out.
3. Copy every number, date, name, URL, and quoted string EXACTLY (inside slots too).
4. Keep every fact needed to answer fully. Drop only pleasantries.
5. Plain lines, no bullets, no headers, no code fences, no markdown emphasis.
6. Copy {{...}} markers character-exact; never fill them in or drop them.
   (Synthetic-corpus rule: production has real values instead of markers.)
7. Uncoded lines: ultra-terse fragments (2-6 words), never full sentences.
8. Slot hygiene: no trailing |, no {} or slot-name words inside values, no
   | inside values. If you lack a slot value, omit the whole line.
9. Tight slots: values only, no prose. Write "further instructions on how
   to reset your PIN" as "PIN reset steps", never the full sentence.
   Exact values (numbers, names, URLs, markers) stay character-exact.

The runner appends:

---

REPLY TO COMPRESS:
<text>

IR:
