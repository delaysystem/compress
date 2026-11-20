import { describe, expect, it } from 'vitest';
import {
	expandShortRefs,
	formatRef,
	parseRef,
	parseShortRef,
	resolveRefs,
	type SpanStore,
	spanStoreFromJson,
} from '../src/spanref.ts';
import storeJson from './fixtures/docstore.json';

function testStore(): SpanStore {
	const documents = new Map<string, Map<string, string>>();
	for (const [docId, spans] of Object.entries(storeJson.documents)) {
		documents.set(docId, new Map(Object.entries(spans)));
	}
	return { version: storeJson.version, documents };
}

describe('resolveRefs', () => {
	it('resolves verbatim text in request order', () => {
		const r = resolveRefs(testStore(), 'kb-test-v1', [
			{ doc: 'Fees#2_0', span: '1' },
			{ doc: 'Top 5 DMV Mistakes#3_0', span: '6' },
		]);
		expect(r).toEqual({
			ok: true,
			spans: [
				{ ref: { doc: 'Fees#2_0', span: '1' }, text: 'The fee is $10.' },
				{
					ref: { doc: 'Top 5 DMV Mistakes#3_0', span: '6' },
					text: 'Report address changes within ten days.',
				},
			],
		});
	});

	it('preserves duplicate refs', () => {
		const r = resolveRefs(testStore(), 'kb-test-v1', [
			{ doc: 'Fees#2_0', span: '1' },
			{ doc: 'Fees#2_0', span: '1' },
		]);
		expect(r.ok && r.spans).toHaveLength(2);
	});

	it('fails fast on unknown doc', () => {
		const r = resolveRefs(testStore(), 'kb-test-v1', [
			{ doc: 'Nope', span: '1' },
		]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain('unknown doc');
		}
	});

	it('fails fast on unknown span', () => {
		const r = resolveRefs(testStore(), 'kb-test-v1', [
			{ doc: 'Fees#2_0', span: '99' },
		]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain('unknown span');
		}
	});

	it('fails on kb version mismatch', () => {
		const r = resolveRefs(testStore(), 'other-v2', [
			{ doc: 'Fees#2_0', span: '1' },
		]);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain('version mismatch');
		}
	});
});

describe('formatRef/parseRef', () => {
	it('round-trips ids containing # and spaces', () => {
		const ref = { doc: 'Top 5 DMV Mistakes#3_0', span: '6' };
		expect(parseRef(formatRef(ref))).toEqual(ref);
	});

	it('rejects garbage, wrong shapes, and empties', () => {
		expect(parseRef('not json')).toBeUndefined();
		expect(parseRef('[1,2]')).toBeUndefined();
		expect(parseRef('{}')).toBeUndefined();
		expect(parseRef('{"d":"","s":"1"}')).toBeUndefined();
		expect(parseRef('{"d":"x"}')).toBeUndefined();
	});
});

describe('spanStoreFromJson', () => {
	it('builds versioned stores from plain objects', () => {
		const s = spanStoreFromJson('kb1', { D: { '1': 'text one' } });
		expect(s.version).toBe('kb1');
		expect(s.documents.get('D')?.get('1')).toBe('text one');
	});

	it('rejects malformed shapes', () => {
		expect(() => spanStoreFromJson('kb1', null)).toThrow('top level');
		expect(() => spanStoreFromJson('kb1', { D: [1] })).toThrow(
			'must be an object',
		);
		expect(() => spanStoreFromJson('kb1', { D: { '1': 7 } })).toThrow(
			'must be a string',
		);
	});
});

describe('short refs', () => {
	const store: SpanStore = {
		version: 'req-test',
		documents: new Map([
			[
				'q',
				new Map([
					['12', 'Room 2316 Empire State Plaza'],
					['3', 'Albany, NY 12228'],
				]),
			],
		]),
	};

	it('parses ^12 whole-line refs into the request scope', () => {
		expect(parseShortRef('^12')).toEqual({ doc: 'q', span: '12' });
		expect(parseShortRef('  ^3  ')).toEqual({ doc: 'q', span: '3' });
		expect(parseShortRef('^x')).toBeUndefined();
		expect(parseShortRef('^1234')).toBeUndefined();
		expect(parseShortRef('see ^12 here')).toBeUndefined();
	});

	it('expands inline refs against the request map', () => {
		const r = expandShortRefs(store, 'req-test', 'Visit ^12, ^3.');
		expect(r).toEqual({
			ok: true,
			text: 'Visit Room 2316 Empire State Plaza, Albany, NY 12228.',
		});
	});

	it('fails loud on unknown numbers and version mismatch', () => {
		expect(expandShortRefs(store, 'req-test', 'go ^99').ok).toBe(false);
		expect(expandShortRefs(store, 'other', 'go ^12').ok).toBe(false);
	});

	it('leaves ref-free text untouched', () => {
		const r = expandShortRefs(store, 'req-test', 'plain line');
		expect(r.ok && r.text).toBe('plain line');
	});
});
