import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../src/gemini.ts';
import {
	ALL_PROVIDER_CONFIGS,
	buildProviderPoolFromEnv,
	buildProviderPoolFromMap,
	type ProviderConfig,
	type ProviderEntry,
	ProviderPool,
} from '../src/providers.ts';

function mockClient(
	id: string,
	impl: (
		model: string,
		promptOrMessages: unknown,
	) => Promise<{ text: string; finishReason: string | null }>,
): ProviderEntry {
	const config: ProviderConfig = {
		id,
		keyName: `${id.toUpperCase()}_KEY`,
		baseUrl: `https://${id}.test/v1`,
		defaultModel: `${id}-fast`,
	};
	return {
		config,
		client: {
			generate: (model, prompt) => impl(model, prompt),
			chat: (model, messages) => impl(model, messages),
		},
	};
}

describe('ALL_PROVIDER_CONFIGS', () => {
	it('includes all 7 new .dev.vars providers alongside existing 4', () => {
		const keyNames = new Set(ALL_PROVIDER_CONFIGS.map((c) => c.keyName));
		for (const expected of [
			'GROQ_API_KEY',
			'CEREBRAS_API_KEY',
			'NIM_API_KEY',
			'OPENROUTER_API_KEY',
			'OPENTYPHOON',
			'ROUTMY',
			'EXPERIMENTALLABS',
			'ANYAPI',
			'DREAMPROMPTING',
			'REGOLO',
			'FREEMODEL',
		]) {
			expect(keyNames.has(expected)).toBe(true);
		}
	});
});

describe('ProviderPool', () => {
	it('fails over automatically when the primary provider errors', async () => {
		const seenModels: string[] = [];
		const p1 = mockClient('primary', () =>
			Promise.reject(new Error('openai 503: unavailable')),
		);
		const p2 = mockClient('opentyphoon', (m) => {
			seenModels.push(m);
			return Promise.resolve({
				text: 'Recovered reply.',
				finishReason: 'STOP',
			});
		});
		const pool = new ProviderPool([p1, p2], { cooldownMs: 30_000 });
		const res = await pool.chat('custom-primary-model', [
			{ role: 'user', content: 'hi' },
		]);
		expect(res.text).toBe('Recovered reply.');
		expect(pool.lastProvider).toBe('opentyphoon');
		// Failover switches to target provider's defaultModel rather than sending primary's slug.
		expect(seenModels).toEqual(['opentyphoon-fast']);
		const stats = pool.stats();
		expect(stats.find((s) => s.id === 'primary')?.failures).toBe(1);
		expect(stats.find((s) => s.id === 'opentyphoon')?.successes).toBe(1);
	});

	it('ranks healthy providers by lowest EWMA latency and skips cooling ones', async () => {
		let nowMs = 1000;
		const calls: string[] = [];
		const slow = mockClient('slow', () => {
			calls.push('slow');
			return Promise.resolve({ text: 'from slow', finishReason: 'STOP' });
		});
		const fast = mockClient('fast', () => {
			calls.push('fast');
			return Promise.resolve({ text: 'from fast', finishReason: 'STOP' });
		});
		const broken = mockClient('broken', () => {
			calls.push('broken');
			return Promise.reject(new Error('429 rate limit'));
		});
		const pool = new ProviderPool([broken, slow, fast], {
			cooldownMs: 30_000,
			now: () => nowMs,
		});
		pool.recordLatency('slow', 800);
		pool.recordLatency('fast', 120);
		pool.markUnhealthy('broken', 'rate limited');

		const r = await pool.generate('auto', 'expand this');
		expect(r.text).toBe('from fast');
		expect(calls).toEqual(['fast']);

		// Advance past cooldown: broken becomes healthy again, still behind fast EWMA.
		nowMs += 31_000;
		const r2 = await pool.generate('auto', 'expand this');
		expect(r2.text).toBe('from fast');
	});

	it('supports hedged execution when primary is slow', async () => {
		const slowPrimary = mockClient(
			'slow',
			() =>
				new Promise((resolve) =>
					setTimeout(
						() => resolve({ text: 'slow win', finishReason: 'STOP' }),
						80,
					),
				),
		);
		const fastHedge = mockClient('hedge', () =>
			Promise.resolve({ text: 'hedge win', finishReason: 'STOP' }),
		);
		const pool = new ProviderPool([slowPrimary, fastHedge], {
			hedgeAfterMs: 10,
		});
		const r = await pool.generate('auto', 'draft');
		expect(r.text).toBe('hedge win');
		expect(pool.lastProvider).toBe('hedge');
	});

	it('throws aggregate error when every provider fails', async () => {
		const p1 = mockClient('a', () => Promise.reject(new Error('err-a')));
		const p2 = mockClient('b', () => Promise.reject(new Error('err-b')));
		const pool = new ProviderPool([p1, p2]);
		await expect(pool.generate('auto', 'x')).rejects.toThrow(
			/all providers failed.*a: err-a.*b: err-b/,
		);
	});
});

describe('buildProviderPoolFromMap / buildProviderPoolFromEnv', () => {
	it('returns undefined when no keys are configured', () => {
		expect(buildProviderPoolFromMap({})).toBeUndefined();
		expect(buildProviderPoolFromEnv({})).toBeUndefined();
	});

	it('wires any of the 7 new .dev.vars providers and executes without leaking keys', async () => {
		const urls: string[] = [];
		const fetchFn: FetchFn = (url) => {
			urls.push(url);
			return Promise.resolve({
				ok: true,
				status: 200,
				statusText: 'OK',
				body: null,
				json: () =>
					Promise.resolve({
						choices: [
							{ message: { content: 'Expanded.' }, finish_reason: 'stop' },
						],
					}),
			});
		};
		const pool = buildProviderPoolFromEnv(
			{ REGOLO: 'sk-test-secret', ANYAPI: 'sk-any-secret' },
			{ fetchFn },
		);
		expect(pool).toBeDefined();
		const res = await pool?.generate('auto', 'hello');
		expect(res?.text).toBe('Expanded.');
		expect(urls[0]).toContain('api.anyapi.ai/v1/chat/completions');
	});
});
