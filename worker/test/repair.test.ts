import { describe, expect, it } from 'vitest';
import type { Dictionary } from '../src/dict.ts';
import { prepareExpansion } from '../src/expander.ts';
import { autofixIr, codeViolations } from '../src/repair.ts';

const DICT: Dictionary = {
	version: 'repair-test',
	entries: [
		{ code: 'w', template: 'need {a} and {b}', slots: ['a', 'b'] },
		{ code: 'm', template: 'done', slots: [] },
		{ code: 's', template: 'by {date}', slots: ['date'] },
	],
};

const EMPTY_STORE = {
	version: 'eval-empty',
	documents: new Map(),
	kbVersion: 'eval-empty',
};

describe('codeViolations', () => {
	it('accepts exact-arity codes and skips text', () => {
		expect(
			codeViolations('w|a|b\nm\nJust a plain line\ns|Monday', DICT),
		).toEqual([]);
		expect(codeViolations(':m', DICT)).toEqual([]);
		expect(codeViolations('m|', DICT)).toEqual([]);
	});

	it('flags arity want-2-got-1 with the line number', () => {
		expect(codeViolations('w|only-one', DICT)).toEqual([
			{ line: 1, code: 'w', kind: 'arity', want: 2, got: 1 },
		]);
	});

	it('flags arity want-0-got-1', () => {
		expect(codeViolations('m|extra', DICT)).toEqual([
			{ line: 1, code: 'm', kind: 'arity', want: 0, got: 1 },
		]);
	});

	it('counts middle-empty slots but forgives trailing pipes', () => {
		expect(codeViolations('w|a||b', DICT)).toEqual([
			{ line: 1, code: 'w', kind: 'arity', want: 2, got: 3 },
		]);
		expect(codeViolations('w|a|', DICT)).toEqual([
			{ line: 1, code: 'w', kind: 'arity', want: 2, got: 1 },
		]);
	});

	it('flags unknown codes once per line (no double arity flag)', () => {
		expect(codeViolations('zz|a|b|c', DICT)).toEqual([
			{
				line: 1,
				code: 'zz',
				kind: 'unknown',
				detail: 'unknown code: zz',
			},
		]);
	});

	it('flags malformed lines', () => {
		const v = codeViolations(':W|shouty', DICT);
		expect(v).toHaveLength(1);
		expect(v[0]).toMatchObject({ line: 1, kind: 'malformed' });
	});

	it('reports every bad line across the IR', () => {
		const v = codeViolations('w|a|b\nw|one\ns|Monday\nm|extra', DICT);
		expect(v.map((x) => x.line)).toEqual([2, 4]);
	});
});

describe('repair trigger matches decode', () => {
	it('flags exactly what prepareExpansion rejects', () => {
		const bad = 'w|only-one';
		const badPrep = prepareExpansion(bad, {
			dict: DICT,
			dictVersion: DICT.version,
			store: EMPTY_STORE,
			kbVersion: 'eval-empty',
		});
		expect(badPrep.ok).toBe(false);
		expect(codeViolations(bad, DICT)).toHaveLength(1);

		const good = 'w|a|b\nm';
		const goodPrep = prepareExpansion(good, {
			dict: DICT,
			dictVersion: DICT.version,
			store: EMPTY_STORE,
			kbVersion: 'eval-empty',
		});
		expect(goodPrep.ok).toBe(true);
		expect(codeViolations(good, DICT)).toEqual([]);
	});
});

describe('autofixIr', () => {
	it('leaves clean IR byte-identical', () => {
		expect(autofixIr('w|a|b\n:m\nplain text', DICT)).toEqual({
			ir: 'w|a|b\n:m\nplain text',
			fixedLines: 0,
		});
	});

	it('splits a single comma value into the exact slots', () => {
		expect(autofixIr('w|error messages, account info', DICT)).toEqual({
			ir: 'w|error messages|account info',
			fixedLines: 1,
		});
	});

	it('drops an unsplittable shortfall to a text line', () => {
		expect(autofixIr('w|details', DICT)).toEqual({
			ir: 'details',
			fixedLines: 1,
		});
	});

	it('merges surplus slots into the last slot', () => {
		expect(autofixIr('s|Monday|Tuesday', DICT)).toEqual({
			ir: 's|Monday, Tuesday',
			fixedLines: 1,
		});
	});

	it('emits slotless codes prefixed and extras as text', () => {
		expect(autofixIr('m|downtown store', DICT)).toEqual({
			ir: ':m\ndowntown store',
			fixedLines: 1,
		});
	});

	it('converts unknown codes to text', () => {
		expect(autofixIr('zz|a|b', DICT)).toEqual({ ir: 'a, b', fixedLines: 1 });
	});

	it('salvages malformed lines with a Note prefix', () => {
		expect(autofixIr(':W|shouty', DICT)).toEqual({
			ir: 'Note: :W|shouty',
			fixedLines: 1,
		});
	});

	it('drops lines with nothing to preserve', () => {
		expect(autofixIr('w||', DICT)).toEqual({ ir: '', fixedLines: 1 });
	});

	it('is idempotent', () => {
		const bad = 'w|only\nm|x\nzz|q\n:W|z\ns|a|b';
		const once = autofixIr(bad, DICT);
		const twice = autofixIr(once.ir, DICT);
		expect(twice.ir).toBe(once.ir);
		expect(twice.fixedLines).toBe(0);
	});

	it('output always decodes with entities preserved', () => {
		const fixed = autofixIr(
			'w|need this, and that\nm|downtown\nzz|extra',
			DICT,
		);
		expect(fixed.fixedLines).toBe(3);
		const prep = prepareExpansion(fixed.ir, {
			dict: DICT,
			dictVersion: DICT.version,
			store: EMPTY_STORE,
			kbVersion: 'eval-empty',
		});
		expect(prep.ok).toBe(true);
		if (prep.ok) {
			for (const keep of [
				'need this',
				'and that',
				'done',
				'downtown',
				'extra',
			]) {
				expect(prep.value.expandedIr).toContain(keep);
			}
		}
	});
});
