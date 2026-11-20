import { describe, expect, it } from 'vitest';
import { extractEntities } from '../src/entities.ts';
import {
	groundedRecall,
	percentile,
	recallByClass,
	scoreGroundedSample,
	scoreSample,
	summarize,
	wordDiff,
} from '../src/ireval.ts';

describe('scoreSample', () => {
	it('computes ratio and full recall', () => {
		const s = scoreSample(
			'Refund $49.99 approved Mar 12',
			'refund $49.99 ok Mar 12',
			20,
			10,
		);
		expect(s.ratio).toBe(2);
		expect(s.recall).toBe(1);
		expect(s.missing).toEqual([]);
		expect(s.emptyIr).toBe(false);
	});

	it('reports partial recall with the missing keys', () => {
		const s = scoreSample(
			'Refund $49.99 approved Mar 12',
			'refund $49.99 approved',
			20,
			4,
		);
		expect(s.recall).toBe(0.5);
		expect(s.missing).toEqual(['date:03-12']);
	});

	it('marks empty IR with infinite ratio and null-safe recall', () => {
		const s = scoreSample('Refund $49.99', '   ', 20, 0);
		expect(s.emptyIr).toBe(true);
		expect(s.ratio).toBe(Number.POSITIVE_INFINITY);
	});

	it('returns null recall when the reference has no entities', () => {
		const s = scoreSample('hello there friend', 'hi', 6, 1);
		expect(s.recall).toBeNull();
	});

	it('does not penalize deduplication of repeats', () => {
		const s = scoreSample(
			'Send $5 to Ann and $5 to Bob',
			'Send $5 to Ann and Bob',
			20,
			10,
		);
		expect(s.recall).toBe(1);
		expect(s.missing).toEqual([]);
	});
});

describe('recallByClass', () => {
	it('breaks recall down per entity class', () => {
		const ref = extractEntities(
			'Refund $49.99 approved Mar 12, see https://example.com/t/1.',
		);
		const out = recallByClass(ref, ['number:$49.99']);
		const byClass = Object.fromEntries(out.map((c) => [c.class, c]));
		expect(byClass.number).toMatchObject({
			total: 1,
			missing: 1,
			recall: 0,
		});
		expect(byClass.date).toMatchObject({ total: 1, missing: 0, recall: 1 });
		expect(byClass.url).toMatchObject({ total: 1, missing: 0, recall: 1 });
	});

	it('counts distinct entities once', () => {
		const ref = extractEntities('Pay $5 now and $5 later');
		expect(recallByClass(ref, ['number:$5'])).toEqual([
			{ class: 'number', total: 1, missing: 1, recall: 0 },
		]);
		expect(recallByClass(ref, [])).toEqual([
			{ class: 'number', total: 1, missing: 0, recall: 1 },
		]);
	});

	it('counts all reference entities without grounding', () => {
		const rows = recallByClass(extractEntities('Pay $5 on Mar 3'), [
			'date:03-03',
		]);
		expect(rows).toEqual([
			{ class: 'date', total: 1, missing: 1, recall: 0 },
			{ class: 'number', total: 1, missing: 0, recall: 1 },
		]);
	});

	it('excludes ungrounded classes from totals with grounding', () => {
		const rows = recallByClass(
			extractEntities('Pay $5 on Mar 3'),
			['date:03-03'],
			extractEntities('the bill is $5'),
		);
		expect(rows).toEqual([
			{ class: 'number', total: 1, missing: 0, recall: 1 },
		]);
	});
});

describe('percentile', () => {
	it('returns order statistics and clamps', () => {
		expect(percentile([1, 2, 3, 4], 0.5)).toBe(3);
		expect(percentile([1, 2, 3], 0)).toBe(1);
		expect(percentile([1, 2, 3], 1)).toBe(3);
		expect(() => percentile([], 0.5)).toThrow('empty set');
	});
});

describe('summarize', () => {
	it('aggregates ratios over non-empty IRs and recall over entity-bearing refs', () => {
		const s = summarize([
			{
				fullTokens: 20,
				irTokens: 10,
				ratio: 2,
				recall: 1,
				missing: [],
				emptyIr: false,
			},
			{
				fullTokens: 30,
				irTokens: 10,
				ratio: 3,
				recall: 0.5,
				missing: ['number:$5'],
				emptyIr: false,
			},
			{
				fullTokens: 10,
				irTokens: 0,
				ratio: Number.POSITIVE_INFINITY,
				recall: null,
				missing: [],
				emptyIr: true,
			},
		]);
		expect(s).toEqual({
			n: 3,
			emptyIr: 1,
			meanRatio: 2.5,
			p50Ratio: 3,
			meanRecall: 0.75,
			recallN: 2,
		});
	});
});

describe('groundedRecall', () => {
	it('scores only reference entities also present in grounding', () => {
		const ref = extractEntities('Pay $5 on Mar 3');
		const ground = extractEntities('Your bill: pay $5 on Mar 3, plus a $9 fee');
		const ir = extractEntities('pay $5 done');
		const g = groundedRecall(ref, ir, ground);
		// Measurable: $5, Mar 3 (both grounded). $9 is grounding-only, ignored.
		expect(g.measuring).toBe(2);
		expect(g.recall).toBe(0.5);
		expect(g.missing).toEqual(['date:03-03']);
	});

	it('excludes ungrounded reference entities instead of blaming the model', () => {
		const ref = extractEntities('Pay $5, confirmation ZQ-42');
		const ground = extractEntities('Pay $5');
		const ir = extractEntities('pay $5 done');
		const g = groundedRecall(ref, ir, ground);
		expect(g.measuring).toBe(1);
		expect(g.recall).toBe(1);
		expect(g.missing).toEqual([]);
	});

	it('returns null recall when nothing is measurable', () => {
		const g = groundedRecall(
			extractEntities('hello there'),
			extractEntities('hi'),
			extractEntities('something else entirely'),
		);
		expect(g.recall).toBeNull();
		expect(g.measuring).toBe(0);
	});
});

describe('scoreGroundedSample', () => {
	it('reduces to plain scoring when grounding equals the reference', () => {
		const plain = scoreSample('Refund $49.99 Mar 12', 'refund ok', 20, 10);
		const grounded = scoreGroundedSample(
			'Refund $49.99 Mar 12',
			'refund ok',
			'Refund $49.99 Mar 12',
			20,
			10,
		);
		expect(grounded).toEqual(plain);
	});
});

describe('wordDiff', () => {
	it('is zero for identical text', () => {
		expect(
			wordDiff(
				'Please provide your order number',
				'Please provide your order number',
			),
		).toBe(0);
	});

	it('ignores case and surrounding punctuation', () => {
		expect(wordDiff('Hello, World!', 'hello world')).toBe(0);
	});

	it('counts one substitution as one', () => {
		expect(wordDiff('your order number', 'your reference number')).toBe(1);
	});

	it('counts insertions and deletions', () => {
		expect(wordDiff('provide number', 'please provide your number')).toBe(2);
		expect(wordDiff('please provide your number', 'provide number')).toBe(2);
	});

	it('measures the 3-word budget boundary', () => {
		const a = 'one two three four five six';
		expect(wordDiff(a, 'one two three FOUR five six')).toBe(0);
		expect(wordDiff(a, 'one 2 three 4 five 6')).toBe(3);
		expect(wordDiff(a, '1 2 3 4 5 6')).toBe(6);
	});
});
