import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../src/gemini.ts';
import { OpenAIChatClient, OpenAIError } from '../src/openai.ts';

function stubFetch(
	body: unknown,
	opts: { status?: number } = {},
): {
	fetchFn: FetchFn;
	seen: { url: string; auth: string; payload: unknown; signal: unknown };
} {
	const status = opts.status ?? 200;
	const seen = {
		url: '',
		auth: '',
		payload: null as unknown,
		signal: null as unknown,
	};
	const fetchFn: FetchFn = (url, init) => {
		seen.url = url;
		seen.auth = init?.headers?.Authorization ?? '';
		seen.payload = init?.body === undefined ? null : JSON.parse(init.body);
		seen.signal = init?.signal ?? null;
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			statusText: status === 200 ? 'OK' : 'ERR',
			json: () => Promise.resolve(body),
			body: null,
		});
	};
	return { fetchFn, seen };
}

const CHAT_BODY = {
	choices: [
		{
			message: { role: 'assistant', content: 'ok' },
			finish_reason: 'stop',
		},
	],
	usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

describe('generate', () => {
	it('posts bearer auth and parses text, finish, usage', async () => {
		const { fetchFn, seen } = stubFetch(CHAT_BODY);
		const client = new OpenAIChatClient({
			apiKey: 'test-only-key',
			baseUrl: 'https://x.test/v1',
			fetchFn,
		});
		const r = await client.generate('m', 'hi', {
			temperature: 0,
			maxOutputTokens: 8,
		});
		expect(r).toEqual({
			text: 'ok',
			finishReason: 'STOP',
			usage: { promptTokens: 10, candidatesTokens: 2, totalTokens: 12 },
		});
		expect(seen.url).toBe('https://x.test/v1/chat/completions');
		expect(seen.auth).toBe('Bearer test-only-key');
		expect(seen.payload).toMatchObject({
			model: 'm',
			messages: [{ role: 'user', content: 'hi' }],
			temperature: 0,
			max_tokens: 8,
		});
		expect(seen.signal).toBeInstanceOf(AbortSignal);
	});

	it('strips a trailing slash from baseUrl', async () => {
		const { fetchFn, seen } = stubFetch(CHAT_BODY);
		const client = new OpenAIChatClient({
			apiKey: 'k',
			baseUrl: 'https://x.test/v1/',
			fetchFn,
		});
		await client.generate('m', 'hi');
		expect(seen.url).toBe('https://x.test/v1/chat/completions');
	});

	it('maps length to MAX_TOKENS and joins content blocks', async () => {
		const { fetchFn } = stubFetch({
			choices: [
				{
					message: {
						content: [
							{ type: 'text', text: 'a' },
							{ type: 'text', text: 'b' },
						],
					},
					finish_reason: 'length',
				},
			],
		});
		const client = new OpenAIChatClient({
			apiKey: 'k',
			baseUrl: 'https://x.test/v1',
			fetchFn,
		});
		const r = await client.generate('m', 'hi');
		expect(r.text).toBe('ab');
		expect(r.finishReason).toBe('MAX_TOKENS');
		expect(r.usage).toBeUndefined();
	});

	it('raises OpenAIError with status and message', async () => {
		const { fetchFn } = stubFetch(
			{ error: { message: 'bad key' } },
			{ status: 401 },
		);
		const client = new OpenAIChatClient({
			apiKey: 'k',
			baseUrl: 'https://x.test/v1',
			fetchFn,
		});
		const err = await client.generate('m', 'hi').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(OpenAIError);
		expect((err as OpenAIError).status).toBe(401);
		expect((err as Error).message).toContain('bad key');
	});

	it('maps TimeoutError to retryable 408', async () => {
		const fetchFn: FetchFn = () =>
			Promise.reject(Object.assign(new Error('x'), { name: 'TimeoutError' }));
		const client = new OpenAIChatClient({
			apiKey: 'k',
			baseUrl: 'https://x.test/v1',
			fetchFn,
		});
		const err = await client.generate('m', 'hi').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(OpenAIError);
		expect((err as OpenAIError).status).toBe(408);
	});

	it('maps undici HeadersTimeoutError to 408', async () => {
		const fetchFn: FetchFn = () =>
			Promise.reject(
				Object.assign(new Error('x'), { name: 'HeadersTimeoutError' }),
			);
		const client = new OpenAIChatClient({
			apiKey: 'k',
			baseUrl: 'https://x.test/v1',
			fetchFn,
		});
		const err = await client.generate('m', 'hi').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(OpenAIError);
		expect((err as OpenAIError).status).toBe(408);
	});

	it('captures reasoning tokens when present', async () => {
		const { fetchFn } = stubFetch({
			choices: [
				{
					message: { role: 'assistant', content: 'ok' },
					finish_reason: 'stop',
				},
			],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 15,
				total_tokens: 25,
				completion_tokens_details: { reasoning_tokens: 13 },
			},
		});
		const client = new OpenAIChatClient({
			apiKey: 'k',
			baseUrl: 'https://x.test/v1',
			fetchFn,
		});
		const r = await client.generate('m', 'hi');
		expect(r.usage?.reasoningTokens).toBe(13);
	});

	it('passes extraBody fields through verbatim', async () => {
		const { fetchFn, seen } = stubFetch(CHAT_BODY);
		const client = new OpenAIChatClient({
			apiKey: 'k',
			baseUrl: 'https://x.test/v1',
			fetchFn,
		});
		await client.generate('m', 'hi', {
			extraBody: { extra_body: { chat_template_kwargs: { x: 1 } } },
		});
		expect(seen.payload).toMatchObject({
			extra_body: { chat_template_kwargs: { x: 1 } },
		});
	});

	it('rejects empty apiKey and baseUrl', () => {
		expect(
			() => new OpenAIChatClient({ apiKey: '', baseUrl: 'https://x/v1' }),
		).toThrow('empty apiKey');
		expect(() => new OpenAIChatClient({ apiKey: 'k', baseUrl: '' })).toThrow(
			'empty baseUrl',
		);
	});
});
