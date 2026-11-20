import { describe, expect, it } from 'vitest';
import { type AppDeps, handleExpand, routeRequest } from '../src/app.ts';
import type { FetchFn } from '../src/gemini.ts';
import { OpenAIChatClient } from '../src/openai.ts';

const DICT = {
	version: 'd1',
	entries: [
		{
			code: 's',
			template: 'offer escalate if missing by {date:1}',
			slots: ['date:1'],
		},
	],
};

const CLEAN = 'A clean fluent reply with no entities at all.';

function genBody(text: string): unknown {
	return {
		choices: [{ message: { content: text }, finish_reason: 'stop' }],
	};
}

function scriptedLlm(texts: string[]): OpenAIChatClient {
	let i = 0;
	const fetchFn: FetchFn = () => {
		const text = texts[Math.min(i, texts.length - 1)] ?? '';
		i += 1;
		return Promise.resolve({
			ok: true,
			status: 200,
			statusText: 'OK',
			body: null,
			json: () => Promise.resolve(genBody(text)),
		});
	};
	return new OpenAIChatClient({
		apiKey: 'k',
		baseUrl: 'https://x.test/v1',
		fetchFn,
	});
}

function testDeps(over: Partial<AppDeps> = {}): AppDeps {
	return {
		dict: DICT,
		llm: scriptedLlm([CLEAN]),
		loadSpans: () => Promise.resolve({ ok: false, reason: 'not-configured' }),
		...over,
	};
}

const BASE = {
	ir: 'plain telegraphic line',
	dictVersion: 'd1',
	kbVersion: 'kb1',
	model: 'm',
};

describe('handleExpand', () => {
	it('serves the direct path with versions and verdicts', async () => {
		const r = await handleExpand(testDeps(), BASE);
		expect(r.status).toBe(200);
		const j = r.json as {
			ok: boolean;
			path: string;
			versions: object;
			verdicts: unknown[];
		};
		expect(j.ok).toBe(true);
		expect(j.path).toBe('direct');
		expect(j.versions).toEqual({ dict: 'd1', kb: 'kb1' });
		expect(j.verdicts).toHaveLength(1);
	});

	it('repairs and templates through the ladder', async () => {
		const repaired = await handleExpand(
			testDeps({ llm: scriptedLlm(['', CLEAN]) }),
			BASE,
		);
		expect((repaired.json as { path: string }).path).toBe('repaired');
		const templated = await handleExpand(
			testDeps({ llm: scriptedLlm(['']) }),
			BASE,
		);
		expect((templated.json as { path: string }).path).toBe('template');
	});

	it('honors repairAttempts 0 by skipping repair (run 038)', async () => {
		const r = await handleExpand(testDeps({ llm: scriptedLlm(['', CLEAN]) }), {
			...BASE,
			repairAttempts: 0,
		});
		const j = r.json as { path: string; ok: boolean };
		expect(r.status).toBe(200);
		expect(j.path).toBe('template');
		expect(j.ok).toBe(true);
	});

	it('honors repairAttempts above the default', async () => {
		const r = await handleExpand(
			testDeps({ llm: scriptedLlm(['', '', CLEAN]) }),
			{ ...BASE, repairAttempts: 2 },
		);
		expect((r.json as { path: string }).path).toBe('repaired');
	});

	it('rejects malformed repairAttempts with 400', async () => {
		for (const v of [-1, 2.5, 'x', 6, null]) {
			expect(
				(await handleExpand(testDeps(), { ...BASE, repairAttempts: v })).status,
			).toBe(400);
		}
	});

	it('serves failing template with ok=false and no regen path', async () => {
		const r = await handleExpand(testDeps({ llm: scriptedLlm(['']) }), {
			...BASE,
			ir: '   ',
		});
		const j = r.json as { path: string; ok: boolean };
		expect(j.path).toBe('template');
		expect(j.ok).toBe(false);
	});

	it('never regens even when regenModel is supplied (single-call invariant)', async () => {
		// One message = one flagship call, always. A regenModel in the body
		// must not buy a flagship call: template serves, ok:false.
		const r = await handleExpand(testDeps({ llm: scriptedLlm(['']) }), {
			...BASE,
			ir: '   ',
			regenModel: 'big',
		});
		const j = r.json as { path: string; ok: boolean };
		expect(j.path).toBe('template');
		expect(j.ok).toBe(false);
	});

	it('rejects bad versions with 422 and malformed bodies with 400', async () => {
		expect(
			(await handleExpand(testDeps(), { ...BASE, dictVersion: 'nope' })).status,
		).toBe(422);
		expect(
			(await handleExpand(testDeps(), { ...BASE, ir: '@bogus' })).status,
		).toBe(400);
		expect(
			(await handleExpand(testDeps(), { ...BASE, ir: ':zz' })).status,
		).toBe(422);
		expect(
			(await handleExpand(testDeps(), { ...BASE, model: '' })).status,
		).toBe(400);
		expect((await handleExpand(testDeps(), [1, 2])).status).toBe(400);
		expect(
			(await handleExpand(testDeps(), { ...BASE, slotValues: 'x' })).status,
		).toBe(400);
	});

	it('maps span-store outcomes to 501/422/502', async () => {
		const span = { ...BASE, ir: '@span:{"d":"D","s":"1"}' };
		expect((await handleExpand(testDeps(), span)).status).toBe(501);
		const unknown = testDeps({
			loadSpans: () =>
				Promise.resolve({ ok: false, reason: 'unknown-version' }),
		});
		expect((await handleExpand(unknown, span)).status).toBe(422);
		const down = testDeps({
			loadSpans: () => Promise.reject(new Error('kv timeout')),
		});
		expect((await handleExpand(down, span)).status).toBe(502);
	});

	it('resolves spans from the loaded store', async () => {
		const deps = testDeps({
			loadSpans: () =>
				Promise.resolve({
					ok: true,
					store: {
						version: 'kb1',
						documents: new Map([['D', new Map([['1', 'Span text here']])]]),
					},
				}),
		});
		const r = await handleExpand(deps, {
			...BASE,
			ir: '@span:{"d":"D","s":"1"}',
		});
		expect(r.status).toBe(200);
	});

	it('wraps greeting and signoff when provided', async () => {
		const r = await handleExpand(testDeps(), {
			...BASE,
			greeting: 'Hi!',
			signoff: 'Bye!',
		});
		const j = r.json as { text: string };
		expect(j.text.indexOf('Hi!') < j.text.indexOf(CLEAN)).toBe(true);
		expect(j.text.indexOf(CLEAN) < j.text.indexOf('Bye!')).toBe(true);
	});

	it('returns 502 when the expander is down', async () => {
		const fetchFn: FetchFn = () => Promise.reject(new Error('boom'));
		const r = await handleExpand(
			testDeps({
				llm: new OpenAIChatClient({
					apiKey: 'k',
					baseUrl: 'https://x.test/v1',
					fetchFn,
				}),
			}),
			BASE,
		);
		expect(r.status).toBe(502);
	});

	it('returns 500 when no LLM client is wired', async () => {
		const deps: AppDeps = {
			dict: DICT,
			llm: undefined,
			loadSpans: () => Promise.resolve({ ok: false, reason: 'not-configured' }),
		};
		const r = await handleExpand(deps, BASE);
		expect(r.status).toBe(500);
	});
});

describe('routeRequest', () => {
	function req(path: string, init?: RequestInit): Request {
		return new Request(`https://test${path}`, init);
	}

	it('serves health with the dict version', async () => {
		const res = await routeRequest(testDeps(), req('/health'));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, dictVersion: 'd1' });
	});

	it('routes unknown paths, methods, and bad JSON', async () => {
		expect((await routeRequest(testDeps(), req('/nope'))).status).toBe(404);
		expect((await routeRequest(testDeps(), req('/expand'))).status).toBe(405);
		const bad = await routeRequest(
			testDeps(),
			req('/expand', { method: 'POST', body: '{oops' }),
		);
		expect(bad.status).toBe(400);
	});

	it('serves /expand end to end', async () => {
		const res = await routeRequest(
			testDeps(),
			req('/expand', { method: 'POST', body: JSON.stringify(BASE) }),
		);
		expect(res.status).toBe(200);
		const j = (await res.json()) as { ok: boolean; path: string };
		expect(j.ok).toBe(true);
		expect(j.path).toBe('direct');
	});
});
