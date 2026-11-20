import { describe, expect, it } from 'vitest';
import {
	diffCountedEntities,
	diffEntities,
	extractEntities,
} from '../src/entities.ts';

const SAMPLE =
	'Refund $49.99 for order #84721 approved Mar 12, see https://example.com/t/84721 or mail help@example.com.';

describe('extractEntities', () => {
	it('extracts every class', () => {
		const classes = new Set(extractEntities(SAMPLE).map((e) => e.class));
		expect(classes).toEqual(
			new Set(['number', 'date', 'url', 'email', 'identifier']),
		);
	});

	it('canonicalizes March 3rd and 3/3 to the same date', () => {
		const a = extractEntities('due March 3rd').filter(
			(e) => e.class === 'date',
		);
		const b = extractEntities('due 3/3').filter((e) => e.class === 'date');
		expect(a.map((e) => e.canonical)).toEqual(['03-03']);
		expect(b.map((e) => e.canonical)).toEqual(['03-03']);
	});

	it('keeps currency symbols distinct', () => {
		const vals = extractEntities('$50 and €50').map((e) => e.canonical);
		expect(vals).toContain('$50');
		expect(vals).toContain('€50');
	});

	it('strips thousand separators', () => {
		expect(extractEntities('1,000 credits').map((e) => e.canonical)).toContain(
			'1000',
		);
	});

	it('extracts double-brace placeholders as slots', () => {
		const ents = extractEntities('cancel order {{Order Number}} now');
		expect(ents.map((e) => e.class)).toEqual(['placeholder']);
		expect(ents[0]?.raw).toBe('{{Order Number}}');
	});
});

describe('diffEntities', () => {
	it('passes identical multisets', () => {
		expect(
			diffEntities(extractEntities(SAMPLE), extractEntities(SAMPLE)),
		).toEqual({ missing: [], extra: [] });
	});

	it('reports dropped entities as missing', () => {
		const d = diffEntities(
			extractEntities(SAMPLE),
			extractEntities('Refund approved, see mail help@example.com.'),
		);
		expect(d.missing).toContain('number:$49.99');
		expect(d.missing).toContain('identifier:#84721');
		expect(d.extra).toEqual([]);
	});

	it('counts duplicates as a multiset', () => {
		const d = diffEntities(
			extractEntities('$5 fee and $5 tax'),
			extractEntities('$5 fee'),
		);
		expect(d.missing).toEqual(['number:$5']);
	});

	it('accepts date rewordings with equal canonical form', () => {
		const d = diffEntities(
			extractEntities('by March 3rd'),
			extractEntities('by 3/3'),
		);
		expect(d).toEqual({ missing: [], extra: [] });
	});
});

describe('list markers', () => {
	const numbers = (text: string): string[] =>
		extractEntities(text)
			.filter((e) => e.class === 'number')
			.map((e) => e.canonical);

	it('excludes dot-style step numerals', () => {
		expect(
			numbers('Follow these steps:\n1. Open the email.\n2. Click unsubscribe.'),
		).toEqual([]);
	});

	it('excludes paren-style and indented markers', () => {
		expect(numbers('1) Open\n2) Close')).toEqual([]);
		expect(numbers('  1. Open')).toEqual([]);
	});

	it('keeps mid-line numbers and ordinals', () => {
		expect(numbers('Pay $5 for 3 items')).toEqual(['$5', '3']);
		expect(numbers('See section 2. for details')).toEqual(['2']);
	});

	it('keeps line-leading decimals and years', () => {
		expect(numbers('1.5 million users\n2024. A busy year.')).toEqual([
			'1.5',
			'2024',
		]);
	});

	it('keeps paren-leading ratings (ambiguous form, not a marker)', () => {
		expect(numbers('(5) stars')).toEqual(['5']);
	});
});

describe('spacing tolerance', () => {
	it('attaches spaced-out years to month-first dates', () => {
		const a = extractEntities('from November 1 , 1912').filter(
			(e) => e.class === 'date',
		);
		expect(a.map((e) => e.canonical)).toEqual(['1912-11-01']);
	});

	it('attaches spaced-out years to day-first dates', () => {
		const a = extractEntities('from 13 March , 2020').filter(
			(e) => e.class === 'date',
		);
		expect(a.map((e) => e.canonical)).toEqual(['2020-03-13']);
	});

	it('treats spaced currency and percent as the compact form', () => {
		expect(
			extractEntities('varies between $ 17,500 or $ 5,000').map(
				(e) => e.canonical,
			),
		).toEqual(['$17500', '$5000']);
		expect(extractEntities('predict with 80 % accuracy').map((e) => e)).toEqual(
			[expect.objectContaining({ class: 'number', canonical: '80%' })],
		);
	});

	it('never attaches a year across a line break', () => {
		const ents = extractEntities('March 3\n1912 people attended');
		expect(ents.map((e) => `${e.class}:${e.canonical}`).sort()).toEqual([
			'date:03-03',
			'number:1912',
		]);
	});

	it('strips trailing sentence punctuation from URLs', () => {
		const a = extractEntities('more info: http://www.dfs.ny.gov.');
		const b = extractEntities('see http://www.dfs.ny.gov, ok?');
		expect(a.map((e) => e.canonical)).toEqual(['http://www.dfs.ny.gov']);
		expect(b.map((e) => e.canonical)).toEqual(['http://www.dfs.ny.gov']);
	});

	it('keeps interior URL punctuation intact', () => {
		const a = extractEntities('open http://e.com/x?a=b,2 now');
		expect(a.map((e) => e.canonical)).toEqual(['http://e.com/x?a=b,2']);
	});

	it('leaves emails without trailing dots alone', () => {
		const a = extractEntities('mail me at help@example.com.');
		expect(a.map((e) => e.canonical)).toEqual(['help@example.com']);
	});
});

describe('diffCountedEntities', () => {
	it('keeps numbers multiset', () => {
		const d = diffCountedEntities(
			extractEntities('$5 fee and $5 tax'),
			extractEntities('$5 fee'),
		);
		expect(d.missing).toEqual(['number:$5']);
		expect(d.extra).toEqual([]);
	});

	it('merges repeated placeholder mentions', () => {
		const d = diffCountedEntities(
			extractEntities('from {{X}} we ship to {{X}}'),
			extractEntities('from {{X}} we ship fast'),
		);
		expect(d).toEqual({ missing: [], extra: [] });
	});

	it('still fails full drops and extras of mentions', () => {
		expect(
			diffCountedEntities(
				extractEntities('see {{X}} now'),
				extractEntities('see now'),
			).missing,
		).toEqual(['placeholder:{{X}}']);
		expect(
			diffCountedEntities(
				extractEntities('see now'),
				extractEntities('see {{Y}} now'),
			).extra,
		).toEqual(['placeholder:{{Y}}']);
	});

	it('merges repeated dates and urls', () => {
		const d = diffCountedEntities(
			extractEntities(
				'due Mar 3, see https://e.com/t/1, again Mar 3 and https://e.com/t/1.',
			),
			extractEntities('due Mar 3, see https://e.com/t/1.'),
		);
		expect(d).toEqual({ missing: [], extra: [] });
	});
});

describe('identifiers', () => {
	it('matches alphanumeric IDs whole', () => {
		const ents = extractEntities('pay invoice #INV-2026-0031 now');
		expect(ents.map((e) => `${e.class}:${e.canonical}`)).toEqual([
			'identifier:#INV-2026-0031',
		]);
	});

	it('still matches numeric IDs', () => {
		expect(extractEntities('order #84721 ok').map((e) => e.canonical)).toEqual([
			'#84721',
		]);
	});

	it('ignores lone hashes and hash-space', () => {
		expect(
			extractEntities('use # tags and # Title').filter(
				(e) => e.class === 'identifier',
			),
		).toEqual([]);
	});
});
