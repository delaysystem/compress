// Entity extraction + multiset comparison (PLAN.md Validation: entity
// multiset-exact, FAIL on any mismatch; Step 3 canonicalization spec: normalize
// for comparison, slot values stay verbatim from tool results).
//
// Canonicalization decisions (deliberate, tested below):
// - numbers: strip separators/whitespace, keep currency symbols and %
//   ($50 and €50 must NOT compare equal).
// - dates: month names map to numbers, ordinals/commas/padding normalized, so
//   "March 3rd" and "3/3" compare equal; year-less and year-ful forms differ
//   (different precision, honestly unequal).
// - urls/emails/identifiers: verbatim (trimmed). URL paths are case-sensitive
//   and emails must survive exactly, so no case folding anywhere.
// Classes are extracted in priority order (placeholder > url > email > date >
// identifier > number) with claimed-span skipping, so each span classifies
// once. Double-brace spans (Bitext-style {{slots}}) mask first so braces never
// leak into skeletons or collide with {slot} placeholders.
// A date containing digits yields one date entity, not date-plus-numbers.
// Ordered-list markers are formatting, not facts (v1 pilot evidence, run
// 010: IR drops step numerals, expansion re-adds them): a bare integer that
// opens a line and is followed by '.' or ')' is excluded from numbers.
// Guards: digits-only raw (1.5, $5, 5% never match), value < 1000 (a
// line-leading year like 2024. is kept), mid-line ordinals kept, and the
// paren-leading "(5) stars" rating form is NOT excluded (ambiguous,
// unobserved in corpora).
// Spacing-tolerant canonicalization (tier-1 eval evidence, run 013):
// corpora space out "$ 17,500", "80 %", "November 1 , 1912" while models
// emit "$17,500", "80%", "November 1, 1912" — same facts, so the year,
// currency-symbol, and percent attachments tolerate horizontal space.
// Newlines never attach (a year on the next line is a different fact).

export type EntityClass =
	| 'placeholder'
	| 'number'
	| 'url'
	| 'email'
	| 'date'
	| 'identifier';

export interface Entity {
	class: EntityClass;
	raw: string;
	canonical: string;
	start: number;
	end: number;
}

export interface EntityDiff {
	missing: string[];
	extra: string[];
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NUMBER_RE = /(?:[$€£¥][ \t]?)?\d[\d,]*(?:\.\d+)?[ \t]*%?/g;
const DATE_RE =
	/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?(?:[ \t]*,?[ \t]*\d{4})?|\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:[ \t]*,?[ \t]*\d{4})?)\b/gi;
// Identifiers: # followed by alphanumerics (order/ticket/invoice IDs like
// #84721 and #INV-2026-0031 match whole, so multi-segment codes compare as
// one set-scoped unit; a lone # or '# ' never matches).
const ID_RE = /#[A-Za-z0-9][\w-]*/g;
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g;

// Pinned locale table (month names), not a magic value: English month spellings.
const MONTHS: Record<string, string> = {
	jan: '01',
	january: '01',
	feb: '02',
	february: '02',
	mar: '03',
	march: '03',
	apr: '04',
	april: '04',
	may: '05',
	jun: '06',
	june: '06',
	jul: '07',
	july: '07',
	aug: '08',
	august: '08',
	sep: '09',
	sept: '09',
	september: '09',
	oct: '10',
	october: '10',
	nov: '11',
	november: '11',
	dec: '12',
	december: '12',
};

function pad2(n: string): string {
	return n.length >= 2 ? n : `0${n}`;
}

function canonicalDate(raw: string): string {
	const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (iso?.[1] !== undefined && iso[2] !== undefined && iso[3] !== undefined) {
		return `${iso[1]}-${iso[2]}-${iso[3]}`;
	}
	const slashed = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
	if (slashed?.[1] !== undefined && slashed[2] !== undefined) {
		const base = `${pad2(slashed[1])}-${pad2(slashed[2])}`;
		return slashed[3] === undefined ? base : `${slashed[3]}-${base}`;
	}
	const named = raw.match(
		/^(?:([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:[ \t]*,?[ \t]*(\d{4}))?|(\d{1,2})\s+([A-Za-z]+)(?:[ \t]*,?[ \t]*(\d{4}))?)$/,
	);
	if (named !== null) {
		const monthName = (named[1] ?? named[5] ?? '').toLowerCase();
		const month = MONTHS[monthName] ?? '00';
		const day = pad2(named[2] ?? named[4] ?? '00');
		const year = named[3] ?? named[6];
		return year === undefined ? `${month}-${day}` : `${year}-${month}-${day}`;
	}
	return raw.trim().replace(/\s+/g, ' ');
}

function canonicalNumber(raw: string): string {
	return raw.replace(/[,\s]/g, '');
}

interface Span {
	start: number;
	end: number;
}

function overlaps(ranges: Span[], start: number, end: number): boolean {
	return ranges.some((r) => start < r.end && end > r.start);
}

function collectClaimed(
	claimed: Span[],
	re: RegExp,
	text: string,
	cls: EntityClass,
	canon: (s: string) => string,
): Entity[] {
	re.lastIndex = 0;
	const out: Entity[] = [];
	for (const m of text.matchAll(re)) {
		const raw = m[0] ?? '';
		const start = m.index ?? 0;
		if (raw.length === 0) {
			continue;
		}
		const end = start + raw.length;
		if (overlaps(claimed, start, end)) {
			continue;
		}
		claimed.push({ start, end });
		out.push({ class: cls, raw, canonical: canon(raw), start, end });
	}
	return out;
}

const verbatim = (s: string): string => s.trim();

// Trailing sentence punctuation is not part of the URL (LFM3 eval evidence,
// run 015: "...dfs.ny.gov. Feel..." vs "...dfs.ny.gov" mismatched and failed
// an otherwise-exact expansion). Interior punctuation is preserved.
const canonicalUrl = (s: string): string => s.trim().replace(/[.,;:!?]+$/, '');

export function extractEntities(text: string): Entity[] {
	const claimed: Span[] = [];
	const all = [
		...collectClaimed(claimed, PLACEHOLDER_RE, text, 'placeholder', verbatim),
		...collectClaimed(claimed, URL_RE, text, 'url', canonicalUrl),
		...collectClaimed(claimed, EMAIL_RE, text, 'email', verbatim),
		...collectClaimed(claimed, DATE_RE, text, 'date', canonicalDate),
		...collectClaimed(claimed, ID_RE, text, 'identifier', verbatim),
		...collectClaimed(claimed, NUMBER_RE, text, 'number', canonicalNumber),
	];
	// Marker filtering runs after collection so priority claiming is
	// unchanged (numbers claim last; nothing ranks below them).
	return all.filter(
		(e) => e.class !== 'number' || !isListMarker(text, e.start, e.end, e.raw),
	);
}

function isListMarker(
	text: string,
	start: number,
	end: number,
	raw: string,
): boolean {
	// raw may carry one trailing space (NUMBER_RE eats it before %?).
	if (!/^\d+$/.test(raw.trim()) || Number(raw) >= 1000) {
		return false;
	}
	const next = text[end];
	if (next !== '.' && next !== ')') {
		return false;
	}
	for (let i = start - 1; i >= 0; i--) {
		const c = text[i];
		if (c === '\n') {
			return true;
		}
		if (c !== ' ' && c !== '\t' && c !== '\r') {
			return false;
		}
	}
	return true;
}

function key(e: Entity): string {
	return `${e.class}:${e.canonical}`;
}

function dedupeByKey(ents: Entity[]): Entity[] {
	const seen = new Set<string>();
	return ents.filter((e) => {
		const k = key(e);
		if (seen.has(k)) {
			return false;
		}
		seen.add(k);
		return true;
	});
}

// Parity-grade diff (validator): numbers compare as multisets — repeated
// quantities can each count ($5 + $5 is not $5) — while every other class
// compares as sets: repeated mentions are emphasis, and merging them loses
// nothing (run 016 evidence: a benign {{Delivery City}} merge failed
// multiset-exact). Conservative by design: phone-number segments stay
// multiset (unobserved either way; a false fail costs a regen, a missed
// real drop costs correctness).
export function diffCountedEntities(
	reference: Entity[],
	actual: Entity[],
): EntityDiff {
	const refCounted = reference.filter((e) => e.class === 'number');
	const actCounted = actual.filter((e) => e.class === 'number');
	const refMentioned = dedupeByKey(
		reference.filter((e) => e.class !== 'number'),
	);
	const actMentioned = dedupeByKey(actual.filter((e) => e.class !== 'number'));
	const counted = diffEntities(refCounted, actCounted);
	const mentioned = diffEntities(refMentioned, actMentioned);
	return {
		missing: [...counted.missing, ...mentioned.missing].sort(),
		extra: [...counted.extra, ...mentioned.extra].sort(),
	};
}

export function diffEntities(
	reference: Entity[],
	actual: Entity[],
): EntityDiff {
	const missingCounts = new Map<string, number>();
	for (const e of reference) {
		missingCounts.set(key(e), (missingCounts.get(key(e)) ?? 0) + 1);
	}
	const extra: string[] = [];
	for (const e of actual) {
		const k = key(e);
		const left = missingCounts.get(k) ?? 0;
		if (left > 0) {
			missingCounts.set(k, left - 1);
		} else {
			extra.push(k);
		}
	}
	const missing: string[] = [];
	for (const [k, n] of missingCounts) {
		for (let i = 0; i < n; i++) {
			missing.push(k);
		}
	}
	missing.sort();
	extra.sort();
	return { missing, extra };
}
