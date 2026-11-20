import { describe, expect, it } from 'vitest';
import { type FetchFn, GeminiClient, GeminiError } from '../src/gemini.ts';
import countFixture from './fixtures/gemini-count-tokens.json';
import generateFixture from './fixtures/gemini-generate.json';

interface SeenCall {
	url: string;
	method: string | undefined;
	hasAuthHeader: boolean;
}

// Fetch-boundary stub with recorded/doc fixtures (REPO-RULES.md sanctioned pattern).
function sseStream(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function stubFetch(
	body: unknown,
	opts: {
		status?: number;
		ok?: boolean;
		jsonThrows?: boolean;
		streamBytes?: string;
	} = {},
): { fetchFn: FetchFn; calls: SeenCall[] } {
	const status = opts.status ?? 200;
	const ok = opts.ok ?? true;
	const calls: SeenCall[] = [];
	const fetchFn: FetchFn = (url, init) => {
		calls.push({
			url,
			method: init?.method,
			hasAuthHeader: (init?.headers?.['x-goog-api-key'] ?? '').length > 0,
		});
		return Promise.resolve({
			ok,
			status,
			statusText: ok ? 'OK' : 'ERR',
			json: () =>
				opts.jsonThrows === true
					? Promise.reject(new Error('no json'))
					: Promise.resolve(body),
			body: opts.streamBytes === undefined ? null : sseStream(opts.streamBytes),
		});
	};
	return { fetchFn, calls };
}

describe('countTokens', () => {
	it('posts the documented shape and parses totalTokens', async () => {
		const { fetchFn, calls } = stubFetch(countFixture);
		const client = new GeminiClient({ apiKey: 'test-only-key', fetchFn });
		const r = await client.countTokens('gemini-3.8-flash', 'Hello world');
		expect(r).toEqual({ totalTokens: 25 });
		expect(calls[0]?.url).toContain(':countTokens');
		expect(calls[0]?.method).toBe('POST');
		expect(calls[0]?.hasAuthHeader).toBe(true);
	});

	it('never puts the key in the URL', async () => {
		const { fetchFn, calls } = stubFetch(countFixture);
		const client = new GeminiClient({ apiKey: 'test-only-key', fetchFn });
		await client.countTokens('m', 'hi');
		expect(calls[0]?.url).not.toContain('test-only-key');
	});

	it('rejects a response missing totalTokens', async () => {
		const { fetchFn } = stubFetch({});
		const client = new GeminiClient({ apiKey: 'k', fetchFn });
		await expect(client.countTokens('m', 'hi')).rejects.toThrow(
			'missing totalTokens',
		);
	});
});

describe('generate', () => {
	// Fixture is the recorded live response (gemini-3.5-flash-lite, 2026-11-11).
	it('parses text, finishReason, and usage', async () => {
		const { fetchFn } = stubFetch(generateFixture.response);
		const client = new GeminiClient({ apiKey: 'k', fetchFn });
		const r = await client.generate('m', 'Say ok');
		expect(r).toEqual({
			text: 'ok',
			finishReason: 'STOP',
			usage: { promptTokens: 5, candidatesTokens: 1, totalTokens: 6 },
		});
	});

	it('omits usage when the API omits usageMetadata', async () => {
		const { fetchFn } = stubFetch({
			candidates: [
				{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' },
			],
		});
		const client = new GeminiClient({ apiKey: 'k', fetchFn });
		const r = await client.generate('m', 'Say ok');
		expect(r).toEqual({ text: 'hi', finishReason: 'STOP' });
		expect('usage' in r).toBe(false);
	});
});

async function collectStream(client: GeminiClient): Promise<unknown[]> {
	const out: unknown[] = [];
	for await (const p of client.streamJson('m', 'hi')) {
		out.push(p);
	}
	return out;
}

describe('streamJson', () => {
	it('yields parsed payloads from the event stream', async () => {
		const { fetchFn, calls } = stubFetch(
			{},
			{ streamBytes: 'data: {"a":1}\n\ndata: {"b":2}\n\n' },
		);
		const client = new GeminiClient({ apiKey: 'k', fetchFn });
		const out: unknown[] = [];
		for await (const p of client.streamJson('m', 'hi')) {
			out.push(p);
		}
		expect(out).toEqual([{ a: 1 }, { b: 2 }]);
		expect(calls[0]?.url).toContain(':streamGenerateContent');
	});

	it('throws on missing body and on invalid payload JSON', async () => {
		const noBody = stubFetch({}).fetchFn;
		await expect(
			collectStream(new GeminiClient({ apiKey: 'k', fetchFn: noBody })),
		).rejects.toThrow('no body');
		const { fetchFn } = stubFetch({}, { streamBytes: 'data: {oops\n\n' });
		await expect(
			collectStream(new GeminiClient({ apiKey: 'k', fetchFn })),
		).rejects.toThrow('invalid stream payload JSON');
	});
});

describe('listModels', () => {
	it('maps names and drops empties', async () => {
		const { fetchFn } = stubFetch({
			models: [{ name: 'a' }, {}, { name: 'b' }],
		});
		const client = new GeminiClient({ apiKey: 'k', fetchFn });
		await expect(client.listModels()).resolves.toEqual(['a', 'b']);
	});
});

describe('errors', () => {
	it('raises GeminiError with status and message', async () => {
		const { fetchFn } = stubFetch(
			{ error: { message: 'bad key' } },
			{ status: 400, ok: false },
		);
		const client = new GeminiClient({ apiKey: 'k', fetchFn });
		const err = await client.countTokens('m', 'hi').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GeminiError);
		expect((err as GeminiError).status).toBe(400);
		expect((err as Error).message).toContain('bad key');
	});

	it('falls back to statusText on non-JSON bodies', async () => {
		const { fetchFn } = stubFetch(
			{},
			{ status: 500, ok: false, jsonThrows: true },
		);
		const client = new GeminiClient({ apiKey: 'k', fetchFn });
		await expect(client.countTokens('m', 'hi')).rejects.toThrow('500');
	});

	it('rejects an empty apiKey', () => {
		expect(() => new GeminiClient({ apiKey: '' })).toThrow('empty apiKey');
	});
});

describe('request timeout', () => {
	function abortingFetch(name: string): FetchFn {
		return () => Promise.reject(Object.assign(new Error('aborted'), { name }));
	}

	it('maps TimeoutError to retryable 408', async () => {
		const client = new GeminiClient({
			apiKey: 'k',
			fetchFn: abortingFetch('TimeoutError'),
		});
		const err = await client.countTokens('m', 'hi').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GeminiError);
		expect((err as GeminiError).status).toBe(408);
	});

	it('maps AbortError to retryable 408', async () => {
		const client = new GeminiClient({
			apiKey: 'k',
			fetchFn: abortingFetch('AbortError'),
		});
		const err = await client.generate('m', 'hi').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GeminiError);
		expect((err as GeminiError).status).toBe(408);
	});

	it('maps undici HeadersTimeoutError to 408', async () => {
		const client = new GeminiClient({
			apiKey: 'k',
			fetchFn: abortingFetch('HeadersTimeoutError'),
		});
		const err = await client.countTokens('m', 'hi').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(GeminiError);
		expect((err as GeminiError).status).toBe(408);
	});

	it('passes an AbortSignal to fetch', async () => {
		let seen: unknown;
		const fetchFn: FetchFn = (_url, init) => {
			seen = init?.signal;
			return Promise.resolve({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: () => Promise.resolve({ totalTokens: 1 }),
				body: null,
			});
		};
		const client = new GeminiClient({ apiKey: 'k', fetchFn });
		await client.countTokens('m', 'hi');
		expect(seen).toBeInstanceOf(AbortSignal);
	});

	it('propagates non-abort rejections unchanged', async () => {
		const boom = new Error('socket hung up');
		const client = new GeminiClient({
			apiKey: 'k',
			fetchFn: () => Promise.reject(boom),
		});
		await expect(client.countTokens('m', 'hi')).rejects.toBe(boom);
	});
});
