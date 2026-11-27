import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type AppDeps, handleExpand } from '../src/app.ts';
import { ExpansionCache } from '../src/cache.ts';
import { dictFromJson } from '../src/dict.ts';
import {
	normalizeModelBraces,
	stripAnchorParrot,
	stripHarmony,
	stripThinkBlocks,
} from '../src/expander.ts';
import { ProviderPool } from '../src/providers.ts';
import { validateExpansion } from '../src/validator.ts';
import { autofixV3, decodeV3, parseV3 } from '../src/wirev3.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dictV3 = dictFromJson(
	JSON.parse(
		readFileSync(join(root, 'data', 'derived', 'dict-ir-v3.json'), 'utf8'),
	),
);
const markers = (
	JSON.parse(
		readFileSync(join(root, 'data', 'derived', 'marker-v3.json'), 'utf8'),
	) as { aliases: Record<string, string> }
).aliases;

describe('expander stress & edge cases', () => {
	it('keeps backslash-escaped SEP words literal in Wire v3', () => {
		const ir = 'TX Contact \\KA desk or \\AX team';
		const segs = parseV3(ir, dictV3, markers);
		expect(segs).toHaveLength(1);
		expect(segs[0]).toEqual({
			kind: 'code',
			code: 'TX',
			slots: ['Contact KA desk or AX team'],
		});
		const decoded = decodeV3(segs, dictV3);
		expect(decoded.ok).toBe(true);
		if (decoded.ok) {
			expect(decoded.text).toBe('Contact KA desk or AX team');
		}
	});

	it('repairs unknown codes and surplus arity via autofixV3 without losing slots', () => {
		const ir = 'ZZ unknown payload KA extra1 | extra2';
		const segs = autofixV3(parseV3(ir, dictV3, markers), dictV3).segments;
		const decoded = decodeV3(segs, dictV3);
		expect(decoded.ok).toBe(true);
		if (decoded.ok) {
			expect(decoded.text).toContain('unknown payload');
			expect(decoded.text).toContain('Log in to account');
			expect(decoded.text).toContain('extra1, extra2');
		}
	});

	it('strips stacked braces, anchor parrots, think blocks, and harmony channels', () => {
		const raw =
			'<|channel|>analysis<|message|>thinking<|end|><|start|>assistant<|channel|>final<|message|>' +
			'internal</think>Please note that this service must include the exact values: {{{{Order Number}}}}. ' +
			'Your {{{{Order Number}}}} is confirmed for {{product details}}.<|return|>';
		const draft = 'Order {{Order Number}} confirmed for product details';
		const cleaned = normalizeModelBraces(
			stripAnchorParrot(stripThinkBlocks(stripHarmony(raw))),
			draft,
		);
		expect(cleaned).toBe(
			'Your {{Order Number}} is confirmed for product details.',
		);
	});

	it('prevents substring slot corruption in ExpansionCache across overlapping IDs', () => {
		const cache = new ExpansionCache(32);
		const ir1 = 'Order W12345 refund $10.00 for W1';
		const slots1 = ['W1', 'W12345', '$10.00'];
		const reply1 =
			'Your refund of $10.00 for order W12345 (ref W1) has been processed.';
		expect(cache.set(ir1, slots1, reply1, 'en')).toBe(true);

		const ir2 = 'Order W99999 refund $25.50 for W9';
		const slots2 = ['W9', 'W99999', '$25.50'];
		const hit = cache.get(ir2, slots2, 'en');
		expect(hit?.text).toBe(
			'Your refund of $25.50 for order W99999 (ref W9) has been processed.',
		);
	});

	it('deterministically repairs multilingual greeting/signoff leaks without a 2nd LLM call', async () => {
		let calls = 0;
		const pool = new ProviderPool([
			{
				config: {
					id: 'mock-es',
					keyName: 'MOCK',
					baseUrl: 'https://mock.test/v1',
					defaultModel: 'm',
				},
				client: {
					generate: () => {
						calls += 1;
						return Promise.resolve({
							text: 'Hola! Su reembolso de $49.99 ha sido procesado.\nSaludos cordiales',
							finishReason: 'STOP',
						});
					},
				},
			},
		]);
		const deps: AppDeps = {
			dict: { version: 'v2-test', entries: [] },
			llm: pool,
			loadSpans: () => Promise.resolve({ ok: false, reason: 'not-configured' }),
		};
		const r = await handleExpand(deps, {
			ir: 'procesar reembolso $49.99 ahora',
			dictVersion: 'v2-test',
			kbVersion: 'kb1',
			model: 'auto',
			lang: 'es',
			fastMode: true,
		});
		expect(calls).toBe(1);
		expect(r.status).toBe(200);
		const j = r.json as { ok: boolean; path: string; text: string };
		expect(j.ok).toBe(true);
		expect(j.path).toBe('repaired');
		expect(j.text).toBe('Su reembolso de $49.99 ha sido procesado.');
	});

	it('enforces latencyBudgetMs ceiling when Tier 3 LLM is slow', async () => {
		const slowPool = new ProviderPool([
			{
				config: {
					id: 'slow',
					keyName: 'K',
					baseUrl: 'https://slow.test/v1',
					defaultModel: 'm',
				},
				client: {
					generate: () =>
						new Promise((resolve) =>
							setTimeout(
								() =>
									resolve({
										text: 'Slow reply that arrived too late.',
										finishReason: 'STOP',
									}),
								200,
							),
						),
				},
			},
		]);
		const deps: AppDeps = {
			dict: { version: 'v2-test', entries: [] },
			llm: slowPool,
			loadSpans: () => Promise.resolve({ ok: false, reason: 'not-configured' }),
		};
		const t0 = performance.now();
		const r = await handleExpand(deps, {
			ir: 'Refund approved for order W123',
			dictVersion: 'v2-test',
			kbVersion: 'kb1',
			model: 'auto',
			slotValues: ['W123'],
			latencyBudgetMs: 25,
		});
		const elapsed = performance.now() - t0;
		expect(elapsed).toBeLessThan(120);
		expect(r.status).toBe(200);
		const j = r.json as { ok: boolean; path: string; text: string };
		expect(j.ok).toBe(true);
		expect(j.path).toBe('template');
		expect(j.text).toContain('W123');
	});

	it('cascades through multiple failing providers and recovers on the last healthy one', async () => {
		const pool = new ProviderPool([
			{
				config: {
					id: 'p1-429',
					keyName: 'K1',
					baseUrl: 'https://p1.test/v1',
					defaultModel: 'm1',
				},
				client: {
					generate: () => Promise.reject(new Error('openai 429: rate limit')),
				},
			},
			{
				config: {
					id: 'p2-timeout',
					keyName: 'K2',
					baseUrl: 'https://p2.test/v1',
					defaultModel: 'm2',
				},
				client: {
					generate: () => Promise.reject(new Error('openai 408: timed out')),
				},
			},
			{
				config: {
					id: 'p3-ok',
					keyName: 'K3',
					baseUrl: 'https://p3.test/v1',
					defaultModel: 'm3',
				},
				client: {
					generate: () =>
						Promise.resolve({
							text: 'Your request has been completed.',
							finishReason: 'STOP',
						}),
				},
			},
		]);
		const res = await pool.generate('auto', 'complete request');
		expect(res.text).toBe('Your request has been completed.');
		expect(pool.lastProvider).toBe('p3-ok');
	});

	it('tolerates corpus spacing on numbers/percents while rejecting role-reversal', () => {
		const ok = validateExpansion({
			splicedIr: 'Refund $ 17,500 at 80 % rate',
			slotValues: [],
			output: 'Your refund of $17,500 is approved at an 80% rate.',
			finishReason: 'STOP',
		});
		expect(ok.pass).toBe(true);

		const reversed = validateExpansion({
			splicedIr: 'Describe issue',
			slotValues: [],
			output: 'Please help me resolve my issue right away.',
			finishReason: 'STOP',
		});
		expect(reversed.pass).toBe(false);
		expect(
			reversed.checks.find((c) => c.name === 'no-role-reversal')?.pass,
		).toBe(false);
	});
});
