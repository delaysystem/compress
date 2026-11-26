import { describe, expect, it } from 'vitest';
import { canonicalizeSkeleton, ExpansionCache } from '../src/cache.ts';

describe('ExpansionCache (Tier 2 slot-parameterized LRU)', () => {
	it('canonicalizes slots and {{Markers}} into a shared skeleton', () => {
		const a = canonicalizeSkeleton(
			'Refund approved for order W111 of $19.99 via {{Refund Method}}',
			['W111', '$19.99'],
		);
		const b = canonicalizeSkeleton(
			'Refund approved for order W222 of $89.50 via {{Refund Method}}',
			['W222', '$89.50'],
		);
		expect(a.key).toBe(b.key);
		expect(a.bindings).toEqual(['{{Refund Method}}', '$19.99', 'W111']);
		expect(b.bindings).toEqual(['{{Refund Method}}', '$89.50', 'W222']);
	});

	it('hits across different concrete slot values and re-validates output', () => {
		const cache = new ExpansionCache(16);
		const ir1 = 'Refund approved\nOrder W111\nAmount $19.99';
		const slots1 = ['W111', '$19.99'];
		const reply1 =
			'Your refund of $19.99 for order W111 has been approved and processed.';
		expect(cache.set(ir1, slots1, reply1)).toBe(true);

		const ir2 = 'Refund approved\nOrder W999\nAmount $42.50';
		const slots2 = ['W999', '$42.50'];
		const hit = cache.get(ir2, slots2);
		expect(hit).toBeDefined();
		expect(hit?.text).toBe(
			'Your refund of $42.50 for order W999 has been approved and processed.',
		);
		expect(hit?.verdict.pass).toBe(true);
	});

	it('refuses to store replies missing a bound value and evicts LRU entries', () => {
		const cache = new ExpansionCache(2);
		expect(cache.set('Order A1', ['A1'], 'Your order is ready.')).toBe(false);
		expect(cache.size).toBe(0);

		cache.set('Draft one X1', ['X1'], 'Here is the detail for X1.');
		cache.set('Draft two X2', ['X2'], 'Here is the detail for X2.');
		// Touch X1 to make X2 least recently used.
		expect(cache.get('Draft one X9', ['X9'])?.text).toContain('X9');
		cache.set('Draft three X3', ['X3'], 'Here is the detail for X3.');
		expect(cache.size).toBe(2);
		expect(cache.get('Draft two X8', ['X8'])).toBeUndefined();
		expect(cache.get('Draft one X7', ['X7'])?.text).toContain('X7');
	});
});
