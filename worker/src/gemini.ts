// Minimal Gemini AI Studio REST client (PLAN.md Step 2b re-measurement).
// Fetch-based: runs in Workers and Node 22. Auth via x-goog-api-key header,
// never a query param — keys must not land in URLs or logs. Model IDs are
// parameters, never hardcoded: pin them by probing listModels first.

import { GEMINI_BASE_URL } from './config.ts';
import { parseSseEvents } from './sse.ts';

export type FetchFn = (
	url: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<{
	ok: boolean;
	status: number;
	statusText: string;
	json(): Promise<unknown>;
	body: ReadableStream<Uint8Array> | null;
}>;

export interface CountTokensResult {
	totalTokens: number;
}

export interface TokenUsage {
	promptTokens: number;
	candidatesTokens: number;
	totalTokens: number;
}

export interface GenerationParams {
	temperature?: number;
	maxOutputTokens?: number;
}

export interface GenerateResult {
	text: string;
	finishReason: string | null;
	usage?: TokenUsage;
}

export class GeminiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(`gemini ${status}: ${message}`);
		this.status = status;
	}
}

const MAX_ERROR_DETAIL = 200; // Display cap for API error text. Origin: arbitrary readability choice.
// Unary calls finish in seconds; 60s is generous headroom before a stuck socket fails loud (run 012 finding).
const REQUEST_TIMEOUT_MS = 60_000;
// Streams read long bodies; 5 min bounds a stuck socket without killing slow-but-live streams.
const STREAM_TIMEOUT_MS = 300_000;

export class GeminiClient {
	private readonly apiKey: string;
	private readonly fetchFn: FetchFn;
	private readonly baseUrl: string;

	constructor(opts: { apiKey: string; fetchFn?: FetchFn; baseUrl?: string }) {
		if (opts.apiKey.length === 0) {
			throw new Error('gemini: empty apiKey');
		}
		this.apiKey = opts.apiKey;
		this.fetchFn = opts.fetchFn ?? fetch;
		this.baseUrl = opts.baseUrl ?? GEMINI_BASE_URL;
	}

	async listModels(): Promise<string[]> {
		const res = await this.request(
			`${this.baseUrl}/models`,
			{ headers: this.headers() },
			REQUEST_TIMEOUT_MS,
		);
		await this.throwIfError(res);
		const body = (await res.json()) as { models?: Array<{ name?: string }> };
		return (body.models ?? [])
			.map((m) => m.name ?? '')
			.filter((n) => n.length > 0);
	}

	async countTokens(model: string, text: string): Promise<CountTokensResult> {
		const res = await this.request(
			`${this.baseUrl}/models/${model}:countTokens`,
			{
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
			},
			REQUEST_TIMEOUT_MS,
		);
		await this.throwIfError(res);
		const body = (await res.json()) as { totalTokens?: number };
		if (typeof body.totalTokens !== 'number') {
			throw new Error('gemini: countTokens response missing totalTokens');
		}
		return { totalTokens: body.totalTokens };
	}

	async generateRaw(
		model: string,
		prompt: string,
		params?: GenerationParams,
	): Promise<unknown> {
		const requestBody: Record<string, unknown> = {
			contents: [{ parts: [{ text: prompt }] }],
		};
		if (params !== undefined) {
			const config: Record<string, unknown> = {};
			if (params.temperature !== undefined) {
				config.temperature = params.temperature;
			}
			if (params.maxOutputTokens !== undefined) {
				config.maxOutputTokens = params.maxOutputTokens;
			}
			requestBody.generationConfig = config;
		}
		const res = await this.request(
			`${this.baseUrl}/models/${model}:generateContent`,
			{
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify(requestBody),
			},
			REQUEST_TIMEOUT_MS,
		);
		await this.throwIfError(res);
		return await res.json();
	}

	async generate(
		model: string,
		prompt: string,
		params?: GenerationParams,
	): Promise<GenerateResult> {
		const raw =
			params === undefined
				? await this.generateRaw(model, prompt)
				: await this.generateRaw(model, prompt, params);
		const body = raw as {
			candidates?: Array<{
				content?: { parts?: Array<{ text?: string }> };
				finishReason?: string;
			}>;
			usageMetadata?: {
				promptTokenCount?: number;
				candidatesTokenCount?: number;
				totalTokenCount?: number;
			};
		};
		const first = body.candidates?.[0];
		const text = first?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
		const usage = body.usageMetadata;
		if (
			typeof usage?.promptTokenCount === 'number' &&
			typeof usage.candidatesTokenCount === 'number' &&
			typeof usage.totalTokenCount === 'number'
		) {
			return {
				text,
				finishReason: first?.finishReason ?? null,
				usage: {
					promptTokens: usage.promptTokenCount,
					candidatesTokens: usage.candidatesTokenCount,
					totalTokens: usage.totalTokenCount,
				},
			};
		}
		return { text, finishReason: first?.finishReason ?? null };
	}

	private async request(
		url: string,
		init: { method?: string; headers?: Record<string, string>; body?: string },
		timeoutMs: number,
	): Promise<Awaited<ReturnType<FetchFn>>> {
		try {
			return await this.fetchFn(url, {
				...init,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (e) {
			// /timeout/i covers TimeoutError plus undici's Headers/Connect/Body
			// variants (run 020: an unmapped HeadersTimeoutError bypassed the
			// 408 mapping and mislabeled sick calls as generic fetch failures).
			if (
				e instanceof Error &&
				(e.name === 'AbortError' || /timeout/i.test(e.name))
			) {
				throw new GeminiError(408, 'request timed out');
			}
			throw e;
		}
	}

	private headers(): Record<string, string> {
		return {
			'x-goog-api-key': this.apiKey,
			'Content-Type': 'application/json',
		};
	}

	async *streamJson(model: string, prompt: string): AsyncGenerator<unknown> {
		const res = await this.request(
			`${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`,
			{
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
			},
			STREAM_TIMEOUT_MS,
		);
		await this.throwIfError(res);
		if (res.body === null) {
			throw new Error('gemini: stream response has no body');
		}
		for await (const payload of parseSseEvents(res.body)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(payload);
			} catch {
				throw new Error('gemini: invalid stream payload JSON');
			}
			yield parsed;
		}
	}

	private async throwIfError(res: {
		ok: boolean;
		status: number;
		statusText: string;
		json(): Promise<unknown>;
	}): Promise<void> {
		if (res.ok) {
			return;
		}
		let detail = res.statusText;
		try {
			const body = (await res.json()) as { error?: { message?: string } };
			if (body.error?.message !== undefined && body.error.message.length > 0) {
				detail = body.error.message.slice(0, MAX_ERROR_DETAIL);
			}
		} catch {
			// Non-JSON error body; keep statusText.
		}
		throw new GeminiError(res.status, detail);
	}
}
