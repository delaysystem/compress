# IR emission prompt v7 (dict-coded, bare wire, tight slots)

Pinned: 2026-11-14 (v6 + hard 4-word slot budget with repair).
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
9. Tight slots: at most 4 words per slot value. Slots carry VALUES ONLY
   (numbers, names, URLs, markers, short labels) — never sentences or
   explanations. Move extra words out of slots into uncoded lines, or
   drop them if they are filler. Example: slot "further instructions
   on how to reset your PIN" (8 words, REJECTED) becomes "PIN reset
   steps" (3 words).

The runner appends:

---

REPLY TO COMPRESS:
<text>

IR:
