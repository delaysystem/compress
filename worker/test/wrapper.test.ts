import { describe, expect, it } from 'vitest';
import { stripWrapper, wrapReply } from '../src/wrapper.ts';

// Example copy only (test fixture, not product strings).
const COPY = {
	greeting: 'Hi there, thanks for reaching out!',
	signoff: 'Let me know if you need anything else.',
};

describe('wrapReply', () => {
	it('joins greeting, core, and signoff with blank lines', () => {
		expect(wrapReply('Your order shipped.', COPY)).toBe(
			'Hi there, thanks for reaching out!\n\nYour order shipped.\n\nLet me know if you need anything else.',
		);
	});

	it('skips empty parts', () => {
		expect(
			wrapReply('Your order shipped.', { greeting: '', signoff: '' }),
		).toBe('Your order shipped.');
	});
});

describe('stripWrapper', () => {
	it('inverts wrapReply exactly', () => {
		expect(stripWrapper(wrapReply('Your order shipped.', COPY), COPY)).toBe(
			'Your order shipped.',
		);
	});

	it('leaves bare cores untouched', () => {
		expect(stripWrapper('Your order shipped.', COPY)).toBe(
			'Your order shipped.',
		);
	});

	it('ignores copy appearing mid-text', () => {
		expect(
			stripWrapper('Note: Hi there, thanks for reaching out! was said.', COPY),
		).toBe('Note: Hi there, thanks for reaching out! was said.');
	});
});
