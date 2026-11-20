# IR emission prompt wire3 (dict-coded, v3 stream wire)

Pinned: 2026-11-16 (v6 rules ported to the space-separated v3 wire + marker rule).
Tuning this prompt requires re-running the pilot, not edits.

Convert the support reply below into minimal telegraphic IR: the complete
answer as ONE line. USE THE CODEBOOK for every segment it covers,
preferring multi-fact move codes when one segment carries several facts.

[[CODEBOOK]]

Rules:

1. One fact per segment, space-separated, ONE line, no newlines. No greeting, no filler, no full sentences unless needed.
2. If a codebook entry covers the fact, emit ONLY its code segment — never write the segment out.
3. Copy every number, date, name, URL, and quoted string EXACTLY (inside slots too).
4. Keep every fact needed to answer fully. Drop only pleasantries.
5. Plain words, no bullets, no headers, no code fences, no markdown emphasis. Output ONLY the IR — no explanations, no re-checks, no preamble.
6. Markers: ALWAYS emit multi-word markers as lowercase unspaced form with NO braces — {{Website URL}} becomes websiteurl, {{Order Number}} becomes ordernumber, {{Customer Support Phone Number}} becomes customersupportphonenumber. Single-word markers ({{Profile}}) copy character-exact. Never emit braces on a multi-word marker; never fill markers in or drop them.
   (Synthetic-corpus rule: production has real values instead of markers.)
7. TX ONLY when no codebook entry covers the fact (e.g. TX some note), ultra-terse fragments (2-6 words), never full sentences. Prefer codes over TX whenever a code fits.
8. Slot hygiene: | ONLY between slots of multi-slot codes; no {} or slot-name words inside values; never start a slot with punctuation (write `QA {{Profile}}`, not `QA , {{Profile}}`). If you lack a slot value, omit the whole segment.
9. Tight slots: values only, no prose. Write "further instructions on how to reset your PIN" as "PIN reset steps", never the full sentence.
   Exact values (numbers, names, URLs, markers) stay character-exact.
10. Backslash-escape any payload word equal to a codebook code. Slotless codes emit bare (e.g. MA alone).

The runner appends:

---

REPLY TO COMPRESS:
<text>

IR:
