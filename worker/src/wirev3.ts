// Wire v3 codec (run 036+): space-separated single-line IR. See
// SPEC-wire-v3.md. Parsing is total (every input yields segments);
// validity (known code, arity) is decided at decode time by dict.ts,
// mirroring the v2 split between parseCodeLine and decodeLine.
import {
	type DecodeResult,
	type Dictionary,
	decodeLine,
	findEntry,
} from './dict.ts';
import type { SlotViolation } from './expander.ts';
import type { CodeViolation } from './repair.ts';

export type V3Segment =
	| { kind: 'code'; code: string; slots: string[] }
	| { kind: 'text'; text: string };

// Uppercase by design (measured 526/676 single-token): lowercase payload
// words can never collide with separators, so common words (to/of/in)
// parse as payload with no violation, no fix, no noise. Only uppercase
// 2-letter words consult the separator set.
const SEP_SHAPE = /^[A-Z]{2}$/;

/** Escape a payload word that would parse as a separator. */
export function escapeV3Word(word: string, codes: Set<string>): string {
	return codes.has(word) ? `\\${word}` : word;
}

/** Marker restore tables: alias forms plus bare inner text, both
 * matched case-insensitively (models emit AccountType as often as
 * accounttype, and bare Tracking Number as often as either). */
interface RestoreTables {
	aliases: Record<string, string>;
	inners: Record<string, string>;
}

function buildRestore(markers: Record<string, string>): RestoreTables {
	const inners: Record<string, string> = {};
	for (const marker of Object.values(markers)) {
		inners[marker.slice(2, -2).toLowerCase()] = marker;
	}
	return { aliases: markers, inners };
}

const WRAP_RE = /^([^A-Za-z0-9]*)([A-Za-z0-9]+)([^A-Za-z0-9]*)$/;

function restoreValue(v: string, t: RestoreTables): string {
	const whole =
		t.aliases[v] ?? t.aliases[v.toLowerCase()] ?? t.inners[v.toLowerCase()];
	if (whole !== undefined) {
		return whole;
	}
	// Braced aliases (v12 bitext-9136: the emitter wraps an alias in
	// braces, {{ customersupporthours }}): collapse one brace layer and
	// restore the inner whole. Only when the inner restores to a marker —
	// unknown braced values fall through to the verbatim path below.
	const braced = /^\{\{\s*(.+?)\s*\}\}$/.exec(v);
	if (braced !== null) {
		const inner = braced[1] ?? '';
		const hit =
			t.aliases[inner] ??
			t.aliases[inner.toLowerCase()] ??
			t.inners[inner.toLowerCase()];
		if (hit !== undefined) {
			return hit;
		}
	}
	// Embedded forms (normalization writes them inside longer values):
	// restore per word, punctuation/hash attached or not. Forms-only —
	// inners need the whole value, and the file test pins that no form
	// occurs as plain prose. Verbatim {{...}} passes through untouched.
	return v
		.split(' ')
		.map((w) => {
			const m = WRAP_RE.exec(w);
			if (m === null) {
				return w;
			}
			const hit =
				t.aliases[m[2] ?? ''] ?? t.aliases[(m[2] ?? '').toLowerCase()];
			return hit === undefined ? w : `${m[1]}${hit}${m[3]}`;
		})
		.join(' ');
}

/** Split payload words into slots (v2 parseCodeLine parity: join, split
 * on |, trim, pop trailing empties only), then restore whole-value
 * markers. Table misses pass through verbatim. */
function splitSlots(words: string[], t: RestoreTables): string[] {
	const parts = words
		.join(' ')
		.split('|')
		.map((p) => p.trim());
	while (parts.length > 0 && parts[parts.length - 1] === '') {
		parts.pop();
	}
	return parts.map((p) => restoreValue(p, t));
}

export function parseV3(
	irText: string,
	dict: Dictionary,
	markers: Record<string, string>,
): V3Segment[] {
	const codes = new Set(dict.entries.map((e) => e.code));
	const restore = buildRestore(markers);
	const words = irText.split(/\s+/).filter((w) => w.length > 0);
	if (!words.some((w) => codes.has(w))) {
		return words.length === 0
			? []
			: [
					{
						kind: 'text',
						text: words.map((w) => restoreValue(w, restore)).join(' '),
					},
				];
	}
	const out: V3Segment[] = [];
	const prologue: string[] = [];
	let cur: { code: string; words: string[] } | null = null;
	const flush = (): void => {
		if (cur !== null) {
			out.push({
				kind: 'code',
				code: cur.code,
				slots: splitSlots(cur.words, restore),
			});
			cur = null;
		}
	};
	for (const w of words) {
		if (w.startsWith('\\')) {
			const lit = w.slice(1);
			if (cur === null) {
				prologue.push(lit);
			} else {
				cur.words.push(lit);
			}
		} else if (codes.has(w) || SEP_SHAPE.test(w)) {
			flush();
			cur = { code: w, words: [] };
		} else if (cur === null) {
			prologue.push(w);
		} else {
			cur.words.push(w);
		}
	}
	flush();
	if (prologue.length > 0) {
		out.unshift({
			kind: 'text',
			text: prologue.map((w) => restoreValue(w, restore)).join(' '),
		});
	}
	return out;
}

export function encodeV3(
	segments: V3Segment[],
	codes: Set<string>,
	txCode = 'TX',
): string {
	const words: string[] = [];
	for (const [i, s] of segments.entries()) {
		if (s.kind !== 'code') {
			// Non-leading text rides TX so a preceding slotless code
			// keeps its bare form on reparse; leading prologue stays
			// bare (positional, unambiguous). Falls back to bare when
			// the book has no TX.
			if (i > 0 && codes.has(txCode)) {
				words.push(txCode);
			}
			for (const w of s.text.split(/\s+/).filter((w) => w.length > 0)) {
				words.push(escapeV3Word(w, codes));
			}
			continue;
		}
		words.push(s.code);
		const body = s.slots.length <= 1 ? s.slots.join(' ') : s.slots.join(' | ');
		for (const w of body.split(/\s+/).filter((w) => w.length > 0)) {
			words.push(escapeV3Word(w, codes));
		}
	}
	return words.join(' ');
}

/** Line numbers are 1-based segment indices (prose says "segment N"). */
export function codeViolationsV3(
	segments: V3Segment[],
	dict: Dictionary,
): CodeViolation[] {
	const out: CodeViolation[] = [];
	for (let i = 0; i < segments.length; i++) {
		const s = segments[i];
		if (s === undefined || s.kind !== 'code') {
			continue;
		}
		const entry = findEntry(dict, s.code);
		if (entry === undefined) {
			out.push({
				line: i + 1,
				code: s.code,
				kind: 'unknown',
				detail: `unknown code: ${s.code}`,
			});
			continue;
		}
		if (s.slots.length !== entry.slots.length) {
			out.push({
				line: i + 1,
				code: s.code,
				kind: 'arity',
				want: entry.slots.length,
				got: s.slots.length,
			});
		}
	}
	return out;
}

export function slotViolationsV3(
	segments: V3Segment[],
	maxWords: number,
): SlotViolation[] {
	const out: SlotViolation[] = [];
	for (let i = 0; i < segments.length; i++) {
		const s = segments[i];
		if (s === undefined || s.kind !== 'code') {
			continue;
		}
		for (const v of s.slots) {
			const n = v.split(/\s+/).filter((w) => w.length > 0).length;
			if (n > maxWords) {
				out.push({ line: i + 1, code: s.code, words: n, maxWords });
			}
		}
	}
	return out;
}

/** Deterministic segment-level repair (mirrors autofixIr): unknown to
 * text, slotless surplus split, surplus merge, lone comma-split, else
 * text. Lone m/k payload words stay literal: 1-letter codes are
 * untaught in v3, so a stray means a v2-habit emission, not intent. */
export function autofixV3(
	segments: V3Segment[],
	dict: Dictionary,
	markers: Record<string, string> = {},
): { segments: V3Segment[]; fixedSegments: number } {
	const out: V3Segment[] = [];
	let fixed = 0;
	const pushText = (text: string): void => {
		if (text.trim().length > 0) {
			out.push({ kind: 'text', text });
		}
	};
	// Inverse table: verbatim marker -> smashed form. Compresses what the
	// model wrote long; decode restores byte-exact, so recall-neutral.
	const byMarker: Record<string, string> = {};
	for (const [form, marker] of Object.entries(markers)) {
		byMarker[marker] = form;
	}
	const normalize = (text: string): string =>
		text
			.replace(/\{\{([^{}]+)\}\}/g, (m) =>
				byMarker[m] === undefined ? m : ` ${byMarker[m]} `,
			)
			.replace(/ +/g, ' ')
			.trim();
	// Join skipping empties: `AX | X` must become slot X, never `, X`.
	const joinValues = (vals: string[]): string =>
		vals.filter((v) => v.trim().length > 0).join(', ');
	for (const s of segments) {
		if (s.kind !== 'code') {
			const text = normalize(s.text);
			out.push(text === s.text ? s : { kind: 'text', text });
			if (text !== s.text) {
				fixed += 1;
			}
			continue;
		}
		// Strip meaningless leading punctuation first (`, {{Profile}}`
		// habit): [,;:] can never start a real value (+ - . " {{ # kept).
		// Then normalize verbatim markers to smashed forms (exact inverse
		// of decode-time restore: recall-neutral, strictly shorter).
		const cleaned = s.slots.map((v) => normalize(v.replace(/^[,;:\s]+/, '')));
		const seg = cleaned.some((v, i) => v !== s.slots[i])
			? { kind: 'code' as const, code: s.code, slots: cleaned }
			: s;
		const entry = findEntry(dict, seg.code);
		if (entry === undefined) {
			pushText(joinValues(seg.slots));
			fixed += 1;
			continue;
		}
		const want = entry.slots.length;
		if (seg.slots.length === want) {
			out.push(seg);
			if (seg !== s) {
				fixed += 1;
			}
			continue;
		}
		fixed += 1;
		if (want === 0) {
			out.push({ kind: 'code', code: seg.code, slots: [] });
			pushText(joinValues(seg.slots));
			continue;
		}
		if (seg.slots.length > want) {
			const head = seg.slots.slice(0, want - 1);
			const tail = joinValues(seg.slots.slice(want - 1));
			out.push({ kind: 'code', code: seg.code, slots: [...head, tail] });
			continue;
		}
		if (seg.slots.length === 1) {
			const pieces = (seg.slots[0] ?? '')
				.split(',')
				.map((p) => p.trim())
				.filter((p) => p.length > 0);
			if (pieces.length === want) {
				out.push({ kind: 'code', code: seg.code, slots: pieces });
				continue;
			}
		}
		pushText(joinValues(seg.slots));
	}
	return { segments: out, fixedSegments: fixed };
}

export function decodeV3(
	segments: V3Segment[],
	dict: Dictionary,
): DecodeResult {
	const out: string[] = [];
	for (const s of segments) {
		if (s.kind === 'text') {
			out.push(s.text);
			continue;
		}
		const r = decodeLine(dict, dict.version, s.code, s.slots);
		if (!r.ok) {
			return r;
		}
		out.push(r.text);
	}
	const text = out.join('\n');
	if (text.trim() === '') {
		return { ok: false, error: 'empty IR: nothing to expand' };
	}
	return { ok: true, text };
}
