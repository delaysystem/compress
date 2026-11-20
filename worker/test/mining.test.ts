import { describe, expect, it } from 'vitest';
import {
	coverageCurve,
	exactDuplicates,
	maskEntities,
	mineTemplates,
	splitSentences,
} from '../src/mining.ts';

describe('splitSentences', () => {
	it('splits on sentence boundaries', () => {
		expect(splitSentences('Hello! How are you? Fine.')).toEqual([
			'Hello',
			'How are you',
			'Fine',
		]);
	});

	it('returns [] for empty text', () => {
		expect(splitSentences('   ')).toEqual([]);
	});
});

describe('maskEntities', () => {
	it('masks the differing span to a typed slot', () => {
		const m = maskEntities('offer escalate if missing by Feb 25');
		expect(m.skeleton).toBe('offer escalate if missing by {date:1}');
		expect(m.slotNames).toEqual(['date:1']);
		expect(m.fixedWords).toBe(5);
	});

	it('masks double-brace spans to placeholder slots', () => {
		const m = maskEntities('cancel order {{Order Number}} now');
		expect(m.skeleton).toBe('cancel order {placeholder:1} now');
		expect(m.slotNames).toEqual(['placeholder:1']);
		expect(m.fixedWords).toBe(3);
	});
});

describe('mineTemplates', () => {
	it('merges sentences differing only in entity spans', () => {
		const ts = mineTemplates(
			[
				'offer escalate if missing by Feb 25',
				'offer escalate if missing by Mar 26',
			],
			{
				minSupport: 2,
			},
		);
		expect(ts).toHaveLength(1);
		const t = ts[0];
		expect(t?.count).toBe(2);
		expect(t?.skeleton).toContain('{date:1}');
		expect(t?.savedWords).toBeGreaterThan(0);
	});

	it('keeps scope-differing paraphrases split', () => {
		const ts = mineTemplates(
			['I want a refund', 'I want a refund for someone else'],
			{ minSupport: 1 },
		);
		expect(ts).toHaveLength(2);
	});

	it('keeps negation pairs split', () => {
		const ts = mineTemplates(['I do want that', 'I do not want that'], {
			minSupport: 1,
		});
		expect(ts).toHaveLength(2);
	});

	it('drops single-word templates and enforces minSupport', () => {
		expect(mineTemplates(['Hi', 'Hi', 'Hi'], { minSupport: 2 })).toEqual([]);
		expect(
			mineTemplates(['see you soon friend', 'see you soon friend'], {
				minSupport: 3,
			}),
		).toEqual([]);
	});

	it('ranks by saved words descending', () => {
		const ts = mineTemplates(
			[
				'short reply here',
				'a much longer reply with many words inside',
				'a much longer reply with many words inside',
			],
			{ minSupport: 1 },
		);
		expect(ts[0]?.count).toBe(2);
	});
});

describe('coverageCurve', () => {
	it('computes cumulative coverage over k', () => {
		const ts = mineTemplates(
			['alpha beta gamma delta', 'alpha beta gamma delta'],
			{ minSupport: 1 },
		);
		const pts = coverageCurve(ts, 100, [1, 10]);
		expect(pts[0]).toEqual({
			k: 1,
			entries: 1,
			coverage: 6 / 100,
			grossSavedWords: 6,
		});
		expect(pts[1]?.entries).toBe(1);
	});
});

describe('exactDuplicates', () => {
	it('groups case-insensitive duplicates and drops singles', () => {
		const gs = exactDuplicates(['Hello there', 'hello there', 'unique line']);
		expect(gs).toEqual([{ text: 'Hello there', count: 2 }]);
	});
});
