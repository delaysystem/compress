import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get_encoding } from 'tiktoken';
import { describe, expect, it } from 'vitest';
import { type Dictionary, dictFromJson } from '../src/dict.ts';
import {
	autofixV3,
	codeViolationsV3,
	decodeV3,
	encodeV3,
	escapeV3Word,
	parseV3,
	slotViolationsV3,
} from '../src/wirev3.ts';

const DICT: Dictionary = {
	version: 'v3test',
	entries: [
		{ code: 'AX', template: 'Need {item}', slots: ['item'] },
		{ code: 'WB', template: 'need {a} and {b}', slots: ['a', 'b'] },
		{ code: 'MC', template: 'Pickup available', slots: [] },
		{ code: 'TX', template: '{t}', slots: ['t'] },
	],
};
const CODES = new Set(DICT.entries.map((e) => e.code));
const MARKERS = {
	websiteurl: '{{Website URL}}',
	trackingnumber: '{{Tracking Number}}',
};

describe('parseV3', () => {
	it('splits a stream at separators', () => {
		expect(parseV3('AX widget WB a | b', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['widget'] },
			{ kind: 'code', code: 'WB', slots: ['a', 'b'] },
		]);
	});

	it('forgives trailing pipes like v2', () => {
		expect(parseV3('WB a |', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'WB', slots: ['a'] },
		]);
	});

	it('parses slotless separators alone', () => {
		expect(parseV3('AX foo MC', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['foo'] },
			{ kind: 'code', code: 'MC', slots: [] },
		]);
	});

	it('treats lowercase words as payload, never separators', () => {
		expect(parseV3('AX buy a car to go', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['buy a car to go'] },
		]);
	});

	it('parses unknown uppercase pairs as code (dict fails downstream)', () => {
		expect(parseV3('AX fine QX bad WB single', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['fine'] },
			{ kind: 'code', code: 'QX', slots: ['bad'] },
			{ kind: 'code', code: 'WB', slots: ['single'] },
		]);
	});

	it('unescapes backslashed separators into payload', () => {
		expect(parseV3('AX say \\AX now', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['say AX now'] },
		]);
	});

	it('keeps a leading prologue as text', () => {
		expect(parseV3('hello AX foo', DICT, MARKERS)).toEqual([
			{ kind: 'text', text: 'hello' },
			{ kind: 'code', code: 'AX', slots: ['foo'] },
		]);
	});

	it('decodes separator-free input as one text segment', () => {
		expect(parseV3('insufficient grounding', DICT, MARKERS)).toEqual([
			{ kind: 'text', text: 'insufficient grounding' },
		]);
		expect(parseV3('', DICT, MARKERS)).toEqual([]);
	});

	it('restores marker aliases on whole values', () => {
		expect(parseV3('AX websiteurl', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['{{Website URL}}'] },
		]);
	});

	it('collapses aliases the emitter wrapped in braces (v12 bitext-9136)', () => {
		expect(parseV3('AX {{ websiteurl }}', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['{{Website URL}}'] },
		]);
	});

	it('passes canonical markers through byte-exact', () => {
		expect(parseV3('AX {{Tracking Number}}', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['{{Tracking Number}}'] },
		]);
	});

	it('passes unknown braced values through verbatim', () => {
		expect(parseV3('AX {{ Something Unknown }}', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['{{ Something Unknown }}'] },
		]);
	});

	it('passes unknown smashed forms through verbatim', () => {
		expect(parseV3('AX livechaturl', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['livechaturl'] },
		]);
	});

	it('tolerates newlines as spaces', () => {
		expect(parseV3('AX foo\nWB a | b', DICT, MARKERS)).toEqual(
			parseV3('AX foo WB a | b', DICT, MARKERS),
		);
	});
});

describe('encodeV3', () => {
	it('round-trips parsed segments', () => {
		const cases = [
			'AX widget WB a | b MC',
			'hello AX foo',
			'insufficient grounding',
			'AX say \\AX now',
			'TX some free text here',
		];
		for (const c of cases) {
			const once = parseV3(c, DICT, MARKERS);
			expect(parseV3(encodeV3(once, CODES), DICT, MARKERS)).toEqual(once);
		}
	});

	it('escapes colliding payload words', () => {
		expect(escapeV3Word('AX', CODES)).toBe('\\AX');
		expect(escapeV3Word('hello', CODES)).toBe('hello');
		expect(escapeV3Word('QX', CODES)).toBe('QX');
	});

	it('wraps non-leading text in TX so slotless codes stay bare', () => {
		expect(
			encodeV3(
				[
					{ kind: 'code', code: 'MC', slots: [] },
					{ kind: 'text', text: 'foo bar' },
				],
				CODES,
			),
		).toBe('MC TX foo bar');
	});

	it('keeps leading text bare (prologue re-parses unambiguously)', () => {
		expect(
			encodeV3(
				[
					{ kind: 'text', text: 'hello' },
					{ kind: 'code', code: 'AX', slots: ['foo'] },
				],
				CODES,
			),
		).toBe('hello AX foo');
	});

	it('round-trips TX-wrapped text through decode identically', () => {
		const ir = encodeV3(
			[
				{ kind: 'code', code: 'MC', slots: [] },
				{ kind: 'text', text: 'foo bar' },
			],
			CODES,
		);
		const r = decodeV3(parseV3(ir, DICT, MARKERS), DICT);
		expect(r).toEqual({ ok: true, text: 'Pickup available\nfoo bar' });
	});
});

describe('decodeV3', () => {
	it('expands parsed segments through the dict', () => {
		const segs = parseV3('AX widget MC', DICT, MARKERS);
		expect(decodeV3(segs, DICT)).toEqual({
			ok: true,
			text: 'Need widget\nPickup available',
		});
	});

	it('fails loud on unknown codes like v2', () => {
		const segs = parseV3('AX fine QX bad WB single', DICT, MARKERS);
		const r = decodeV3(segs, DICT);
		expect(r.ok).toBe(false);
	});

	it('fails loud on arity mismatch like v2', () => {
		const segs = parseV3('WBLONELY', DICT, MARKERS);
		expect(segs).toEqual([{ kind: 'text', text: 'WBLONELY' }]);
		const bad = parseV3('WB single', DICT, MARKERS);
		expect(decodeV3(bad, DICT).ok).toBe(false);
	});

	it('fails on empty decode (empty IRs must never ship silently)', () => {
		expect(decodeV3([], DICT)).toEqual({
			ok: false,
			error: 'empty IR: nothing to expand',
		});
		expect(decodeV3(parseV3('   ', DICT, MARKERS), DICT).ok).toBe(false);
		expect(decodeV3([{ kind: 'text', text: '  ' }], DICT).ok).toBe(false);
	});
});

describe('codeViolationsV3', () => {
	it('flags unknown and arity issues by segment index', () => {
		const segs = parseV3('AX fine QX bad WB single', DICT, MARKERS);
		expect(codeViolationsV3(segs, DICT)).toEqual([
			{ line: 2, code: 'QX', kind: 'unknown', detail: 'unknown code: QX' },
			{ line: 3, code: 'WB', kind: 'arity', want: 2, got: 1 },
		]);
	});

	it('passes clean streams and skips text', () => {
		expect(
			codeViolationsV3(parseV3('hello AX foo MC', DICT, MARKERS), DICT),
		).toEqual([]);
	});
});

describe('slotViolationsV3', () => {
	it('flags over-budget slots by segment index', () => {
		const segs = parseV3('AX one two three four five WB a | b', DICT, MARKERS);
		expect(slotViolationsV3(segs, 4)).toEqual([
			{ line: 1, code: 'AX', words: 5, maxWords: 4 },
		]);
	});
});

describe('autofixV3', () => {
	it('converts unknown segments to text', () => {
		const { segments, fixedSegments } = autofixV3(
			parseV3('AX fine QX bad stuff', DICT, MARKERS),
			DICT,
		);
		expect(segments).toEqual([
			{ kind: 'code', code: 'AX', slots: ['fine'] },
			{ kind: 'text', text: 'bad stuff' },
		]);
		expect(fixedSegments).toBe(1);
	});

	it('splits slotless surplus into bare code plus text', () => {
		const { segments } = autofixV3(
			parseV3('MC extra bits', DICT, MARKERS),
			DICT,
		);
		expect(segments).toEqual([
			{ kind: 'code', code: 'MC', slots: [] },
			{ kind: 'text', text: 'extra bits' },
		]);
	});

	it('merges surplus slots like v2', () => {
		const { segments } = autofixV3(
			parseV3('AX Monday | Tuesday', DICT, MARKERS),
			DICT,
		);
		expect(segments).toEqual([
			{ kind: 'code', code: 'AX', slots: ['Monday, Tuesday'] },
		]);
	});

	it('comma-splits a lone short value or drops to text', () => {
		const split = autofixV3(parseV3('WB alpha, beta', DICT, MARKERS), DICT);
		expect(split.segments).toEqual([
			{ kind: 'code', code: 'WB', slots: ['alpha', 'beta'] },
		]);
		const dropped = autofixV3(parseV3('WB details', DICT, MARKERS), DICT);
		expect(dropped.segments).toEqual([{ kind: 'text', text: 'details' }]);
	});

	it('leaves lone m/k payload words literal (untaught in v3)', () => {
		const { segments, fixedSegments } = autofixV3(
			parseV3('AX see m here', DICT, MARKERS),
			DICT,
		);
		expect(segments).toEqual([
			{ kind: 'code', code: 'AX', slots: ['see m here'] },
		]);
		expect(fixedSegments).toBe(0);
	});

	it('output always decodes with entities preserved', () => {
		const bad = parseV3(
			'WB need this, and that MC downtown QX extra',
			DICT,
			MARKERS,
		);
		const { segments, fixedSegments } = autofixV3(bad, DICT);
		expect(fixedSegments).toBe(3);
		const r = decodeV3(segments, DICT);
		expect(r.ok).toBe(true);
		if (r.ok) {
			for (const keep of [
				'need this',
				'and that',
				'Pickup available',
				'downtown',
				'extra',
			]) {
				expect(r.text).toContain(keep);
			}
		}
	});
});

describe('wire v3 files', () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const derived = join(here, '..', '..', 'data', 'derived');
	const enc = get_encoding('cl100k_base');

	it('ships 47 single-token separators with v2-identical intents', () => {
		const v3 = dictFromJson(
			JSON.parse(readFileSync(join(derived, 'dict-ir-v3.json'), 'utf8')),
		);
		expect(v3.entries).toHaveLength(47);
		for (const e of v3.entries) {
			expect(enc.encode(` ${e.code}`).length).toBe(1);
		}
		const tx = v3.entries.find((e) => e.code === 'TX');
		expect(tx?.template).toBe('{t}');
		expect(tx?.slots).toEqual(['t']);
		const v2 = dictFromJson(
			JSON.parse(readFileSync(join(derived, 'dict-ir-v2.json'), 'utf8')),
		);
		const map = JSON.parse(
			readFileSync(join(derived, 'v2-to-v3.json'), 'utf8'),
		) as Record<string, string>;
		for (const old of v2.entries) {
			const neu = v3.entries.find((e) => e.code === map[old.code]);
			expect(neu?.template).toBe(old.template);
			expect(neu?.slots).toEqual(old.slots);
		}
		enc.free();
	});

	it('marker table restores every alias distinctly', () => {
		const tab = JSON.parse(
			readFileSync(join(derived, 'marker-v3.json'), 'utf8'),
		) as { aliases: Record<string, string>; verbatim: string[] };
		const forms = Object.keys(tab.aliases);
		expect(new Set(forms).size).toBe(forms.length);
		expect(forms.length).toBeGreaterThan(0);
		for (const [form, marker] of Object.entries(tab.aliases)) {
			expect(marker).toMatch(/^\{\{.+\}\}$/);
			expect(form).toBe(marker.slice(2, -2).toLowerCase().replace(/ /g, ''));
		}
	});

	it('marker inners are distinct (bare-inner restore is unambiguous)', () => {
		const tab = JSON.parse(
			readFileSync(join(derived, 'marker-v3.json'), 'utf8'),
		) as { aliases: Record<string, string> };
		const inners = Object.values(tab.aliases).map((m) =>
			m.slice(2, -2).toLowerCase(),
		);
		expect(new Set(inners).size).toBe(inners.length);
	});

	it('no alias form occurs as a plain prose word (per-word restore is safe)', () => {
		const tab = JSON.parse(
			readFileSync(join(derived, 'marker-v3.json'), 'utf8'),
		) as { aliases: Record<string, string> };
		const forms = new Set(Object.keys(tab.aliases));
		const refs = readFileSync(join(derived, 'ir-pilot-v2.jsonl'), 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l).reference as string);
		for (const ref of refs) {
			const plain = ref.replace(/\{\{[^}]+\}\}/g, ' ');
			for (const w of plain.split(/\s+/)) {
				const bare = w.replace(/^[.,;:!?"'()[\]]+|[.,;:!?"'()[\]]+$/g, '');
				expect(forms.has(bare.toLowerCase())).toBe(false);
			}
		}
	});
});

describe('marker restore', () => {
	it('matches alias forms case-insensitively', () => {
		expect(parseV3('AX WebsiteURL', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['{{Website URL}}'] },
		]);
	});

	it('restores bare inner text to the full marker', () => {
		expect(parseV3('AX Tracking Number', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['{{Tracking Number}}'] },
		]);
	});

	it('restores forms inside text segments per word', () => {
		expect(parseV3('hello websiteurl AX foo', DICT, MARKERS)).toEqual([
			{ kind: 'text', text: 'hello {{Website URL}}' },
			{ kind: 'code', code: 'AX', slots: ['foo'] },
		]);
	});

	it('restores embedded forms inside slots per word', () => {
		expect(parseV3('AX see websiteurl today', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['see {{Website URL}} today'] },
		]);
	});

	it('restores punct- and hash-attached forms', () => {
		expect(parseV3('AX (websiteurl), ok', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['({{Website URL}}), ok'] },
		]);
		expect(parseV3('AX #websiteurl', DICT, MARKERS)).toEqual([
			{ kind: 'code', code: 'AX', slots: ['#{{Website URL}}'] },
		]);
	});

	it('normalizes adjacent markers with separating spaces', () => {
		const { segments } = autofixV3(
			parseV3('AX {{Website URL}}{{Tracking Number}}', DICT, MARKERS),
			DICT,
			MARKERS,
		);
		expect(segments).toEqual([
			{ kind: 'code', code: 'AX', slots: ['websiteurl trackingnumber'] },
		]);
	});
});

describe('leading punctuation strip', () => {
	it('strips leading commas from slots and counts the fix', () => {
		const { segments, fixedSegments } = autofixV3(
			parseV3('AX , foo WB a | , b', DICT, MARKERS),
			DICT,
		);
		expect(segments).toEqual([
			{ kind: 'code', code: 'AX', slots: ['foo'] },
			{ kind: 'code', code: 'WB', slots: ['a', 'b'] },
		]);
		expect(fixedSegments).toBe(2);
	});

	it('keeps meaningful leading characters', () => {
		const { segments, fixedSegments } = autofixV3(
			parseV3('AX +1-800 AX -5 TX .5 dear', DICT, MARKERS),
			DICT,
		);
		expect(segments).toEqual([
			{ kind: 'code', code: 'AX', slots: ['+1-800'] },
			{ kind: 'code', code: 'AX', slots: ['-5'] },
			{ kind: 'code', code: 'TX', slots: ['.5 dear'] },
		]);
		expect(fixedSegments).toBe(0);
	});

	it('joins only non-empty values (no , X artifacts)', () => {
		const { segments } = autofixV3(parseV3('AX | X', DICT, MARKERS), DICT);
		expect(segments).toEqual([{ kind: 'code', code: 'AX', slots: ['X'] }]);
		const mid = autofixV3(parseV3('WB a | | b', DICT, MARKERS), DICT);
		expect(mid.segments).toEqual([
			{ kind: 'code', code: 'WB', slots: ['a', 'b'] },
		]);
		const unk = autofixV3(parseV3('AX x QX | foo', DICT, MARKERS), DICT);
		expect(unk.segments).toEqual([
			{ kind: 'code', code: 'AX', slots: ['x'] },
			{ kind: 'text', text: 'foo' },
		]);
		const alone = autofixV3(parseV3('QX | foo', DICT, MARKERS), DICT);
		expect(alone.segments).toEqual([{ kind: 'text', text: 'QX | foo' }]);
	});
});

describe('marker normalization', () => {
	it('compresses verbatim markers to forms in slots', () => {
		const { segments, fixedSegments } = autofixV3(
			parseV3('AX see {{Website URL}} today', DICT, MARKERS),
			DICT,
			MARKERS,
		);
		expect(segments).toEqual([
			{ kind: 'code', code: 'AX', slots: ['see websiteurl today'] },
		]);
		expect(fixedSegments).toBe(1);
	});

	it('compresses verbatim markers in text segments', () => {
		const { segments, fixedSegments } = autofixV3(
			parseV3('visit {{Website URL}} AX foo', DICT, MARKERS),
			DICT,
			MARKERS,
		);
		expect(segments).toEqual([
			{ kind: 'text', text: 'visit websiteurl' },
			{ kind: 'code', code: 'AX', slots: ['foo'] },
		]);
		expect(fixedSegments).toBe(1);
	});

	it('leaves singles and invented markers verbatim', () => {
		const { segments, fixedSegments } = autofixV3(
			parseV3('AX {{Profile}} and {{email}}', DICT, MARKERS),
			DICT,
			MARKERS,
		);
		expect(segments).toEqual([
			{ kind: 'code', code: 'AX', slots: ['{{Profile}} and {{email}}'] },
		]);
		expect(fixedSegments).toBe(0);
	});
});
