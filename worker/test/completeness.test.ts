import { describe, expect, it } from 'vitest';
import { checkComplete } from '../src/completeness.ts';

describe('checkComplete', () => {
	it('passes clean stopped text', () => {
		expect(checkComplete('Your refund is on its way.', 'STOP')).toEqual({
			complete: true,
			reasons: [],
		});
	});

	it('fails MAX_TOKENS authoritatively', () => {
		const v = checkComplete('Your refund is on its', 'MAX_TOKENS');
		expect(v.complete).toBe(false);
		expect(v.reasons.join(' ')).toContain('MAX_TOKENS');
	});

	it('fails OpenAI length as well', () => {
		expect(checkComplete('Your refund is on its', 'length').complete).toBe(
			false,
		);
	});

	it('fails empty text', () => {
		expect(checkComplete('   ', 'STOP').complete).toBe(false);
	});

	it('fails unbalanced code fences', () => {
		expect(checkComplete('Run this:\n```js\nfoo()', 'STOP').complete).toBe(
			false,
		);
	});

	it('passes balanced code fences', () => {
		expect(checkComplete('Run this:\n```js\nfoo()\n```', 'STOP').complete).toBe(
			true,
		);
	});
});
