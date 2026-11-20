import { describe, expect, it } from 'vitest';
import { type FetchFn, GeminiClient } from '../src/gemini.ts';

function captureBody(): { fetchFn: FetchFn; bodies: string[] } {
	const bodies: string[] = [];
	const fetchFn: FetchFn = (_url, init) => {
		bodies.push(typeof init?.body === 'string' ? init.body : '');
		return Promise.resolve({
			ok: true,
			status: 200,
			statusText: 'OK',
			body: null,
			json: () => Promise.resolve({ candidates: [] }),
		});
	};
	return { fetchFn, bodies };
}

describe('generate params', () => {
	it('sends generationConfig when params are given', async () => {
		const { fetchFn, bodies } = captureBody();
		await new GeminiClient({ apiKey: 'k', fetchFn }).generate('m', 'hi', {
			temperature: 0,
			maxOutputTokens: 256,
		});
		expect(JSON.parse(bodies[0] ?? '{}')).toMatchObject({
			generationConfig: { temperature: 0, maxOutputTokens: 256 },
		});
	});

	it('omits generationConfig otherwise', async () => {
		const { fetchFn, bodies } = captureBody();
		await new GeminiClient({ apiKey: 'k', fetchFn }).generate('m', 'hi');
		expect(
			'generationConfig' in
				(JSON.parse(bodies[0] ?? '{}') as Record<string, unknown>),
		).toBe(false);
	});
});
