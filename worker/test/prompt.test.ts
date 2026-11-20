import { get_encoding } from 'tiktoken';
import { describe, expect, it } from 'vitest';
import { buildEmitPrompt } from '../src/prompt.ts';

const HEAD = 'Convert it. USE THE CODEBOOK.\nCodebook:\nAX:Need {item}';

describe('buildEmitPrompt', () => {
	it('keeps a byte-identical static prefix across references (cacheable)', () => {
		const a = buildEmitPrompt(HEAD, 'first reference text here');
		const b = buildEmitPrompt(HEAD, 'second reference, totally different');
		const headA = a.split('REPLY TO COMPRESS:')[0] ?? '';
		const headB = b.split('REPLY TO COMPRESS:')[0] ?? '';
		expect(headA.length).toBeGreaterThan(0);
		expect(headA).toBe(headB);
		expect(headA).toBe(`${HEAD}\n---\n\n`);
		expect(a).toContain('first reference text here');
		expect(a.endsWith('IR:')).toBe(true);
	});

	it('v3x head is smaller than the v3 head', () => {
		const enc = get_encoding('cl100k_base');
		const v3 = buildEmitPrompt(
			`${HEAD} Extra verbose filler words making the old prompt longer than needed here.`,
			'some reference',
		);
		const v3x = buildEmitPrompt(HEAD, 'some reference');
		expect(
			enc.encode(v3x.split('REPLY TO COMPRESS:')[0] ?? '').length,
		).toBeLessThan(enc.encode(v3.split('REPLY TO COMPRESS:')[0] ?? '').length);
		enc.free();
	});
});
