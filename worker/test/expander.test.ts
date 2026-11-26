import { describe, expect, it } from 'vitest';
import type { Dictionary } from '../src/dict.ts';
import {
	buildExpansionPrompt,
	classifyLine,
	expand,
	normalizeModelBraces,
	parseCodeLine,
	prepareExpansion,
	slotViolations,
	stripAnchorParrot,
	stripHarmony,
	stripThinkBlocks,
} from '../src/expander.ts';
import { type FetchFn, GeminiClient } from '../src/gemini.ts';
import type { SpanStore } from '../src/spanref.ts';
import storeJson from './fixtures/docstore.json';

const DICT: Dictionary = {
	version: 'test-v1',
	entries: [
		{
			code: 's',
			template: 'offer escalate if missing by {date:1}',
			slots: ['date:1'],
		},
	],
};

function testStore(): SpanStore {
	const documents = new Map<string, Map<string, string>>();
	for (const [docId, spans] of Object.entries(storeJson.documents)) {
		documents.set(docId, new Map(Object.entries(spans)));
	}
	return { version: storeJson.version, documents };
}

const INPUTS = {
	dict: DICT,
	dictVersion: 'test-v1',
	store: testStore(),
	kbVersion: 'kb-test-v1',
};

describe('classifyLine', () => {
	it('classifies all four kinds', () => {
		expect(classifyLine(':s|Mar 26')).toBe('code');
		expect(classifyLine('@span:{"d":"Fees#2_0","s":"1"}')).toBe('span');
		expect(classifyLine('plain telegraphic line')).toBe('text');
		expect(classifyLine(':')).toBe('malformed');
		expect(classifyLine('@span:{bad')).toBe('malformed');
		expect(classifyLine('@nope')).toBe('malformed');
	});

	it('locks the : code charset (1-2 lowercase letters)', () => {
		expect(classifyLine(':ab|x')).toBe('code');
		expect(classifyLine(':abc|x')).toBe('malformed');
		expect(classifyLine(':S|x')).toBe('malformed');
		expect(classifyLine(':20 off')).toBe('malformed');
	});

	it('treats % mid-line as text', () => {
		expect(classifyLine('save 20% today')).toBe('text');
		expect(classifyLine('20% off')).toBe('text');
	});

	it('forgives bare codes (dropped prefix)', () => {
		expect(classifyLine('w|name|email address')).toBe('code');
		expect(classifyLine('r|leave a comment')).toBe('code');
		expect(classifyLine('toolong|a')).toBe('text');
		expect(classifyLine('no pipes here')).toBe('text');
	});

	it('classifies short span refs', () => {
		expect(classifyLine('^12')).toBe('span');
		expect(classifyLine('^x')).toBe('text');
		expect(classifyLine('see ^12 here')).toBe('text');
	});
});

describe('parseCodeLine', () => {
	it('parses codes with and without slots', () => {
		expect(parseCodeLine(':s|Mar 26|x')).toEqual({
			code: 's',
			slotValues: ['Mar 26', 'x'],
		});
		expect(parseCodeLine(':s')).toEqual({ code: 's', slotValues: [] });
	});

	it('returns undefined for non-code lines', () => {
		expect(parseCodeLine('plain text')).toBeUndefined();
		expect(parseCodeLine(':')).toBeUndefined();
	});

	it('parses bare codes without eating the code letter', () => {
		expect(parseCodeLine('w|name|email address')).toEqual({
			code: 'w',
			slotValues: ['name', 'email address'],
		});
	});

	it('drops trailing empty slots but keeps middle ones', () => {
		expect(parseCodeLine(':w|a|b|')).toEqual({
			code: 'w',
			slotValues: ['a', 'b'],
		});
		expect(parseCodeLine(':w|a||b')).toEqual({
			code: 'w',
			slotValues: ['a', '', 'b'],
		});
	});
});

describe('slotViolations', () => {
	it('flags slot values over budget with line numbers', () => {
		const v = slotViolations('a|ok\nb|one two three four five', 4);
		expect(v).toEqual([{ line: 2, code: 'b', words: 5, maxWords: 4 }]);
	});

	it('passes tight slots and ignores text lines', () => {
		expect(slotViolations('a|ok\nplain line here', 4)).toEqual([]);
		expect(slotViolations(':k', 4)).toEqual([]);
	});

	it('counts words split on whitespace', () => {
		expect(slotViolations('a|  spaced   out  x  y ', 4)).toEqual([]);
		expect(slotViolations('a|one two three four five', 4)).toEqual([
			{ line: 1, code: 'a', words: 5, maxWords: 4 },
		]);
	});
});

describe('prepareExpansion', () => {
	it('splices codes and spans inline in order', () => {
		const r = prepareExpansion(
			['refund update', ':s|Mar 26', '@span:{"d":"Fees#2_0","s":"1"}'].join(
				'\n',
			),
			INPUTS,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) {
			return;
		}
		expect(r.value.expandedIr).toBe(
			[
				'refund update',
				'offer escalate if missing by Mar 26',
				'The fee is $10.',
			].join('\n'),
		);
		expect(r.value.appliedCodes).toEqual(['s']);
		expect(r.value.appliedSpans).toEqual([{ doc: 'Fees#2_0', span: '1' }]);
	});

	it('resolves short refs whole-line and inline', () => {
		const inputs = {
			...INPUTS,
			store: {
				version: 'kb-test-v1',
				documents: new Map([
					[
						'q',
						new Map([
							['12', 'Room 2316'],
							['3', 'Albany NY'],
						]),
					],
				]),
			},
		};
		const r = prepareExpansion(':s|^12\n^3', inputs);
		expect(r.ok).toBe(true);
		if (!r.ok) {
			return;
		}
		expect(r.value.expandedIr).toBe(
			'offer escalate if missing by Room 2316\nAlbany NY',
		);
	});

	it('fails loud on unknown short refs', () => {
		const inputs = {
			...INPUTS,
			store: {
				version: 'kb-test-v1',
				documents: new Map([['q', new Map([['12', 'Room 2316']])]]),
			},
		};
		expect(prepareExpansion('^99', inputs).ok).toBe(false);
		expect(prepareExpansion(':s|^99', inputs).ok).toBe(false);
	});

	it('fails fast with line numbers', () => {
		expect(prepareExpansion('ok\n:zz', INPUTS).ok).toBe(false);
		const bad = prepareExpansion('ok\n:zz', INPUTS);
		if (!bad.ok) {
			expect(bad.error.message).toContain('line 2');
			expect(bad.error.kind).toBe('resolve');
		}
		expect(prepareExpansion('@span:{"d":"Nope","s":"1"}', INPUTS).ok).toBe(
			false,
		);
		const malformed = prepareExpansion('@bogus line', INPUTS);
		expect(malformed.ok).toBe(false);
		if (!malformed.ok) {
			expect(malformed.error.kind).toBe('malformed');
		}
	});

	it('rejects dict version mismatch', () => {
		const r = prepareExpansion(':s|Mar 26', {
			...INPUTS,
			dictVersion: 'other',
		});
		expect(r.ok).toBe(false);
	});
});

describe('buildExpansionPrompt', () => {
	it('embeds the draft and rules, hint only when given', () => {
		const p = buildExpansionPrompt('some draft');
		expect(p).toContain('some draft');
		expect(p).toContain('character-exact');
		expect(p).toContain('NEVER open with a greeting');
		expect(p).not.toContain('REPAIR:');
		expect(buildExpansionPrompt('d', 'fix x')).toContain('REPAIR: fix x');
	});

	it('anchors draft entities as must-include values (run 046)', () => {
		const p = buildExpansionPrompt(
			'Provide {{Tracking Number}} or {{Order Number}}',
		);
		expect(p).toContain(
			'Must include these exact values: {{Tracking Number}}, {{Order Number}}.',
		);
		expect(p.endsWith('REPLY:')).toBe(true);
	});

	it('omits the anchor line when the draft has no entities', () => {
		const p = buildExpansionPrompt('some draft');
		expect(p).not.toContain('Must include these exact values');
	});

	it('keeps anchor with repair hints', () => {
		const p = buildExpansionPrompt('Visit {{Website URL}} today', 'fix x');
		expect(p).toContain('REPAIR: fix x');
		expect(p).toContain('Must include these exact values: {{Website URL}}.');
		expect(p.endsWith('REPLY:')).toBe(true);
	});

	it('defaults to compact rules', () => {
		const p = buildExpansionPrompt('some draft');
		expect(p).toBe(buildExpansionPrompt('some draft', undefined, true));
		expect(p.length).toBeLessThan(
			buildExpansionPrompt('some draft', undefined, false).length,
		);
	});

	it('compact mode keeps rules, draft, anchor and repair hint', () => {
		const p = buildExpansionPrompt(
			'Visit {{Website URL}} today',
			'fix x',
			true,
		);
		expect(p).toContain('character-exact');
		expect(p).toContain('NEVER open with a greeting');
		expect(p).toContain('Visit {{Website URL}} today');
		expect(p).toContain('Must include these exact values: {{Website URL}}.');
		expect(p).toContain('REPAIR: fix x');
		expect(p.endsWith('REPLY:')).toBe(true);
		expect(p.length).toBeLessThan(
			buildExpansionPrompt('Visit {{Website URL}} today', 'fix x', false)
				.length,
		);
	});
});

describe('expand', () => {
	it('posts the built prompt and returns text, finish, usage', async () => {
		let seenBody = '';
		let seenUrl = '';
		const fetchFn: FetchFn = (url, init) => {
			seenUrl = url;
			seenBody = typeof init?.body === 'string' ? init.body : '';
			return Promise.resolve({
				ok: true,
				status: 200,
				statusText: 'OK',
				body: null,
				json: () =>
					Promise.resolve({
						candidates: [
							{
								content: { parts: [{ text: 'Fluent reply.' }] },
								finishReason: 'STOP',
							},
						],
						usageMetadata: {
							promptTokenCount: 50,
							candidatesTokenCount: 10,
							totalTokenCount: 60,
						},
					}),
			});
		};
		const r = await expand(
			new GeminiClient({ apiKey: 'k', fetchFn }),
			'm',
			'telegraphic draft',
			'fix x',
		);
		expect(r.text).toBe('Fluent reply.');
		expect(r.finishReason).toBe('STOP');
		expect(r.usage).toEqual({
			promptTokens: 50,
			candidatesTokens: 10,
			totalTokens: 60,
		});
		expect(seenBody).toContain('telegraphic draft');
		expect(seenBody).toContain('REPAIR: fix x');
		expect(seenUrl).toContain(':generateContent');
	});
});

describe('stripThinkBlocks', () => {
	it('keeps text after the last closing tag', () => {
		expect(stripThinkBlocks('We need x.</think>\n\nFluent reply.')).toBe(
			'Fluent reply.',
		);
	});

	it('passes tagless text through trimmed', () => {
		expect(stripThinkBlocks('  Fluent reply.  ')).toBe('Fluent reply.');
	});

	it('yields empty when nothing follows the tag', () => {
		expect(stripThinkBlocks('We need x.</think>')).toBe('');
	});
});

describe('stripHarmony', () => {
	it('keeps text after the last final marker', () => {
		expect(
			stripHarmony(
				'<|channel|>analysis<|message|>We need x.<|end|><|start|>assistant<|channel|>final<|message|>Fluent reply.',
			),
		).toBe('Fluent reply.');
	});

	it('passes markerless text through trimmed', () => {
		expect(stripHarmony('  Fluent reply.  ')).toBe('Fluent reply.');
	});

	it('strips trailing channel tokens', () => {
		expect(
			stripHarmony('<|channel|>final<|message|>Fluent reply.<|end|>'),
		).toBe('Fluent reply.');
	});

	it('yields empty when nothing follows the marker', () => {
		expect(stripHarmony('<|channel|>final<|message|>')).toBe('');
	});
});

describe('stripAnchorParrot', () => {
	it('drops reworded must-include sentences (v12 bitext-12836)', () => {
		expect(
			stripAnchorParrot(
				'We can ship to {{Delivery City}} in 7-10 business days. ' +
					'Please note that this service must include the exact values: ' +
					'{{Delivery City}}, 7, 10.',
			),
		).toBe('We can ship to {{Delivery City}} in 7-10 business days.');
	});

	it('drops singular must-include parrots mid-reply', () => {
		expect(
			stripAnchorParrot(
				'Locate bill # {{Invoice Number}}. Please note that this must ' +
					'include the exact value of {{Invoice Number}} as specified. Done.',
			),
		).toBe('Locate bill # {{Invoice Number}}. Done.');
	});

	it('passes normal replies through trimmed', () => {
		expect(stripAnchorParrot('  Fluent reply.  ')).toBe('Fluent reply.');
	});

	it('preserves internal newlines so list markers stay markers', () => {
		const list = 'Steps:\n1. Visit the site.\n2. Click new account.';
		expect(stripAnchorParrot(list)).toBe(list);
	});

	it('keeps the original when nothing would remain', () => {
		const only = 'Please note that this must include the exact value of X.';
		expect(stripAnchorParrot(only)).toBe(only);
	});
});

describe('normalizeModelBraces', () => {
	it('unwraps draft-word braces the model added (v12 bitext-1633)', () => {
		expect(
			normalizeModelBraces(
				'We received your order for {{Product Details}} today.',
				'Describe {{Order Number}}, product details',
			),
		).toBe('We received your order for Product Details today.');
	});

	it('keeps invented placeholders the draft cannot ground', () => {
		const out = 'Your invoice for {{Amount}} is ready.';
		expect(normalizeModelBraces(out, 'invoice {{Invoice Number}}')).toBe(out);
	});

	it('collapses stacked braces onto the draft marker (v12 bitext-9136)', () => {
		expect(
			normalizeModelBraces(
				'Hours: {{{{Customer Support Hours}}}}.',
				'Support hours: {{Customer Support Hours}}',
			),
		).toBe('Hours: {{Customer Support Hours}}.');
	});

	it('leaves draft-identical markers byte-identical', () => {
		const out = 'Locate bill # {{Invoice Number}}.';
		expect(normalizeModelBraces(out, 'locate bill # {{Invoice Number}}')).toBe(
			out,
		);
	});
});

describe('expand deliberation handling', () => {
	it('strips deliberation before returning', async () => {
		const fetchFn = () =>
			Promise.resolve({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: () =>
					Promise.resolve({
						candidates: [
							{
								content: {
									parts: [
										{
											text: 'We need x, deliberating.</think>\n\nFluent reply.',
										},
									],
								},
								finishReason: 'STOP',
							},
						],
					}),
				body: null,
			});
		const r = await expand(
			new GeminiClient({ apiKey: 'k', fetchFn }),
			'm',
			'telegraphic draft',
		);
		expect(r.text).toBe('Fluent reply.');
	});
});
