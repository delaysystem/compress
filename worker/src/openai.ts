// Minimal OpenAI-compatible chat client (run 020 provider switch).
// Bearer auth, /v1/chat/completions. Generic over endpoints: NVIDIA NIM
// today (baseUrl required, no default), any OpenAI-compatible server
// tomorrow. Timeout + error conventions mirror gemini.ts; finish reasons
// normalize to the validator's vocabulary (STOP / MAX_TOKENS).

import type { FetchFn, TokenUsage } from './gemini.ts';
import { parseSseEvents } from './sse.ts';
import { type OpenAIStreamChunk, openaiChunkToDeltas } from './streaming.ts';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatUsage extends TokenUsage {
	reasoningTokens?: number;
}

export interface ChatParams {
	temperature?: number;
	maxOutputTokens?: number;
	/** Provider-specific body fields (e.g. thinking toggles). Passed through verbatim. */
	extraBody?: Record<string, unknown>;
}

export interface ChatResult {
	text: string;
	finishReason: string | null;
	usage?: ChatUsage;
}

export class OpenAIError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(`openai ${status}: ${message}`);
		this.status = status;
	}
}

const MAX_ERROR_DETAIL = 200; // Display cap for API error text. Origin: arbitrary readability choice.
const REQUEST_TIMEOUT_MS = 60_000;

/** Probed live 2026-11-11: top-level reasoning_effort none suppresses
 * DeepSeek v4.1 Flash thinking entirely (0 reasoning tokens vs 13
 * default). Pass as extraBody on every call until re-probed. */
export const NO_THINK_EXTRA_BODY = { reasoning_effort: 'none' }; // Same rationale as gemini.ts: unary calls finish in seconds.

export class OpenAIChatClient {
	private readonly apiKey: string;
	private readonly fetchFn: FetchFn;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;

	constructor(opts: {
		apiKey: string;
		baseUrl: string;
		fetchFn?: FetchFn;
		timeoutMs?: number;
	}) {
		if (opts.apiKey.length === 0) {
			throw new Error('openai: empty apiKey');
		}
		if (opts.baseUrl.length === 0) {
			throw new Error('openai: empty baseUrl');
		}
		this.apiKey = opts.apiKey;
		this.fetchFn = opts.fetchFn ?? fetch;
		this.baseUrl = opts.baseUrl.replace(/\/$/, '');
		// Per-instance override: slow tiers (NIM cold starts) need more room
		// than the 60s default. The deadline itself is unobservable from
		// outside (AbortSignal exposes no ms), so no unit test pins a value.
		this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
	}

	async generate(
		model: string,
		prompt: string,
		params?: ChatParams,
	): Promise<ChatResult> {
		return this.chat(model, [{ role: 'user', content: prompt }], params);
	}

	async chat(
		model: string,
		messages: ChatMessage[],
		params?: ChatParams,
	): Promise<ChatResult> {
		const body: Record<string, unknown> = { model, messages };
		if (params?.temperature !== undefined) {
			body.temperature = params.temperature;
		}
		if (params?.maxOutputTokens !== undefined) {
			body.max_tokens = params.maxOutputTokens;
		}
		if (params?.extraBody !== undefined) {
			Object.assign(body, params.extraBody);
		}
		let res: Awaited<ReturnType<FetchFn>>;
		try {
			res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (e) {
			// /timeout/i covers TimeoutError plus undici's Headers/Connect/Body
			// variants (run 020: an unmapped HeadersTimeoutError bypassed the
			// 408 mapping and mislabeled sick calls as generic fetch failures).
			if (
				e instanceof Error &&
				(e.name === 'AbortError' || /timeout/i.test(e.name))
			) {
				throw new OpenAIError(408, 'request timed out');
			}
			throw e;
		}
		await this.throwIfError(res);
		const parsed = (await res.json()) as {
			choices?: Array<{
				message?: { content?: unknown };
				finish_reason?: unknown;
			}>;
			usage?: {
				prompt_tokens?: unknown;
				completion_tokens?: unknown;
				total_tokens?: unknown;
				completion_tokens_details?: { reasoning_tokens?: unknown };
			};
		};
		const first = parsed.choices?.[0];
		const text = contentText(first?.message?.content);
		const finish =
			typeof first?.finish_reason === 'string' ? first.finish_reason : null;
		const usage = parsed.usage;
		const result: ChatResult = {
			text,
			finishReason: finish === null ? null : normalizeFinish(finish),
		};
		if (
			typeof usage?.prompt_tokens === 'number' &&
			typeof usage.completion_tokens === 'number' &&
			typeof usage.total_tokens === 'number'
		) {
			// candidatesTokens carries provider completion tokens: every
			// consumer downstream (ladder sums, usage accounting) speaks
			// TokenUsage vocabulary, mapped once at this boundary.
			result.usage = {
				promptTokens: usage.prompt_tokens,
				candidatesTokens: usage.completion_tokens,
				totalTokens: usage.total_tokens,
			};
			const rtokens = usage.completion_tokens_details?.reasoning_tokens;
			if (typeof rtokens === 'number' && result.usage !== undefined) {
				result.usage.reasoningTokens = rtokens;
			}
		}
		return result;
	}

	async *chatStream(
		model: string,
		messages: ChatMessage[],
		params?: ChatParams,
	): AsyncGenerator<string> {
		const body: Record<string, unknown> = { model, messages, stream: true };
		if (params?.temperature !== undefined) {
			body.temperature = params.temperature;
		}
		if (params?.maxOutputTokens !== undefined) {
			body.max_tokens = params.maxOutputTokens;
		}
		if (params?.extraBody !== undefined) {
			Object.assign(body, params.extraBody);
		}
		let res: Awaited<ReturnType<FetchFn>>;
		try {
			res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: this.headers(),
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (e) {
			if (
				e instanceof Error &&
				(e.name === 'AbortError' || /timeout/i.test(e.name))
			) {
				throw new OpenAIError(408, 'request timed out');
			}
			throw e;
		}
		await this.throwIfError(res);
		if (res.body === null) {
			return;
		}
		for await (const payload of parseSseEvents(res.body)) {
			let chunk: OpenAIStreamChunk;
			try {
				chunk = JSON.parse(payload) as OpenAIStreamChunk;
			} catch {
				continue;
			}
			for (const delta of openaiChunkToDeltas(chunk)) {
				if (delta.kind === 'text' && delta.text.length > 0) {
					yield delta.text;
				}
			}
		}
	}

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.apiKey}`,
			'Content-Type': 'application/json',
		};
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
		throw new OpenAIError(res.status, detail);
	}
}

function contentText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((p) =>
				typeof (p as { text?: unknown }).text === 'string'
					? ((p as { text: string }).text ?? '')
					: '',
			)
			.join('');
	}
	return '';
}

/** Normalize to the validator's vocabulary (STOP / MAX_TOKENS). */
function normalizeFinish(reason: string): string {
	if (reason === 'stop') {
		return 'STOP';
	}
	if (reason === 'length') {
		return 'MAX_TOKENS';
	}
	return reason.toUpperCase();
}
