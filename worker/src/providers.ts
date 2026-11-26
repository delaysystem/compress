// Multi-provider OpenAI-compatible failover pool (existing 4 + 7 .dev.vars
// providers). Ranks healthy providers by EWMA latency, trips a circuit breaker
// on errors/timeouts for cooldownMs, and optionally hedges slow primaries.
// Secret values are never logged or embedded in error messages.

import {
	ANYAPI_API_KEY_NAME,
	ANYAPI_BASE_URL,
	CEREBRAS_API_KEY_NAME,
	CEREBRAS_BASE_URL,
	DREAMPROMPTING_API_KEY_NAME,
	DREAMPROMPTING_BASE_URL,
	EXPERIMENTALLABS_API_KEY_NAME,
	EXPERIMENTALLABS_BASE_URL,
	FREEMODEL_API_KEY_NAME,
	FREEMODEL_BASE_URL,
	GROQ_API_KEY_NAME,
	GROQ_BASE_URL,
	NIM_API_KEY_NAME,
	NIM_BASE_URL,
	OPENROUTER_API_KEY_NAME,
	OPENROUTER_BASE_URL,
	OPENTYPHOON_API_KEY_NAME,
	OPENTYPHOON_BASE_URL,
	REGOLO_API_KEY_NAME,
	REGOLO_BASE_URL,
	ROUTMY_API_KEY_NAME,
	ROUTMY_BASE_URL,
} from './config.ts';
import type { Env } from './env.ts';
import type { ExpanderClient } from './expander.ts';
import type { FetchFn } from './gemini.ts';
import {
	type ChatMessage,
	type ChatParams,
	type ChatResult,
	NO_THINK_EXTRA_BODY,
	OpenAIChatClient,
} from './openai.ts';

export interface ProviderConfig {
	id: string;
	keyName: string;
	baseUrl: string;
	defaultModel: string;
	extraBody?: Record<string, unknown>;
	timeoutMs?: number;
}

export const ALL_PROVIDER_CONFIGS: readonly ProviderConfig[] = [
	{
		id: 'groq',
		keyName: GROQ_API_KEY_NAME,
		baseUrl: GROQ_BASE_URL,
		defaultModel: 'qwen/qwen3.8-27b',
		extraBody: NO_THINK_EXTRA_BODY,
		timeoutMs: 15_000,
	},
	{
		id: 'cerebras',
		keyName: CEREBRAS_API_KEY_NAME,
		baseUrl: CEREBRAS_BASE_URL,
		defaultModel: 'llama3.1-8b',
		timeoutMs: 15_000,
	},
	{
		id: 'opentyphoon',
		keyName: OPENTYPHOON_API_KEY_NAME,
		baseUrl: OPENTYPHOON_BASE_URL,
		defaultModel: 'typhoon-v2.5-30b-a3b-instruct',
		timeoutMs: 20_000,
	},
	{
		id: 'routmy',
		keyName: ROUTMY_API_KEY_NAME,
		baseUrl: ROUTMY_BASE_URL,
		defaultModel: 'auto',
		timeoutMs: 20_000,
	},
	{
		id: 'experimentallabs',
		keyName: EXPERIMENTALLABS_API_KEY_NAME,
		baseUrl: EXPERIMENTALLABS_BASE_URL,
		defaultModel: 'auto',
		timeoutMs: 20_000,
	},
	{
		id: 'anyapi',
		keyName: ANYAPI_API_KEY_NAME,
		baseUrl: ANYAPI_BASE_URL,
		defaultModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
		timeoutMs: 20_000,
	},
	{
		id: 'dreamprompting',
		keyName: DREAMPROMPTING_API_KEY_NAME,
		baseUrl: DREAMPROMPTING_BASE_URL,
		defaultModel: 'auto',
		timeoutMs: 20_000,
	},
	{
		id: 'regolo',
		keyName: REGOLO_API_KEY_NAME,
		baseUrl: REGOLO_BASE_URL,
		defaultModel: 'deepseek-v4.1-flash',
		timeoutMs: 20_000,
	},
	{
		id: 'freemodel',
		keyName: FREEMODEL_API_KEY_NAME,
		baseUrl: FREEMODEL_BASE_URL,
		defaultModel: 'auto',
		timeoutMs: 20_000,
	},
	{
		id: 'openrouter',
		keyName: OPENROUTER_API_KEY_NAME,
		baseUrl: OPENROUTER_BASE_URL,
		defaultModel: 'meta-llama/llama-3.1-8b-instruct:free',
		timeoutMs: 20_000,
	},
	{
		id: 'nim',
		keyName: NIM_API_KEY_NAME,
		baseUrl: NIM_BASE_URL,
		defaultModel: 'deepseek-ai/deepseek-v3.2',
		extraBody: NO_THINK_EXTRA_BODY,
		timeoutMs: 30_000,
	},
];

export interface ChatCapableClient extends ExpanderClient {
	chat?(
		model: string,
		messages: ChatMessage[],
		params?: ChatParams,
	): Promise<ChatResult>;
}

export interface ProviderEntry {
	config: ProviderConfig;
	client: ChatCapableClient;
}

export interface ProviderStats {
	id: string;
	defaultModel: string;
	ewmaMs: number | null;
	successes: number;
	failures: number;
	unhealthyUntil: number;
	lastError: string | null;
}

export interface ProviderPoolOptions {
	cooldownMs?: number;
	hedgeAfterMs?: number;
	ewmaAlpha?: number;
	now?: () => number;
	fetchFn?: FetchFn;
	configs?: readonly ProviderConfig[];
}

interface ProviderState {
	entry: ProviderEntry;
	order: number;
	ewmaMs: number | null;
	successes: number;
	failures: number;
	unhealthyUntil: number;
	lastError: string | null;
}

const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_EWMA_ALPHA = 0.35;

export class ProviderPool implements ChatCapableClient {
	private readonly states: ProviderState[];
	private readonly cooldownMs: number;
	private readonly hedgeAfterMs: number | undefined;
	private readonly ewmaAlpha: number;
	private readonly now: () => number;
	lastProvider: string | undefined;

	constructor(entries: ProviderEntry[], opts?: ProviderPoolOptions) {
		if (entries.length === 0) {
			throw new Error('ProviderPool requires at least one provider');
		}
		this.cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.hedgeAfterMs = opts?.hedgeAfterMs;
		this.ewmaAlpha = opts?.ewmaAlpha ?? DEFAULT_EWMA_ALPHA;
		this.now = opts?.now ?? (() => Date.now());
		this.states = entries.map((entry, order) => ({
			entry,
			order,
			ewmaMs: null,
			successes: 0,
			failures: 0,
			unhealthyUntil: 0,
			lastError: null,
		}));
	}

	async generate(
		model: string,
		prompt: string,
		params?: ChatParams,
	): Promise<ChatResult> {
		return this.dispatch(model, params, (state, targetModel, callParams) =>
			state.entry.client.generate(targetModel, prompt, callParams),
		);
	}

	async chat(
		model: string,
		messages: ChatMessage[],
		params?: ChatParams,
	): Promise<ChatResult> {
		return this.dispatch(model, params, (state, targetModel, callParams) => {
			if (state.entry.client.chat !== undefined) {
				return state.entry.client.chat(targetModel, messages, callParams);
			}
			const prompt = messages.map((m) => m.content).join('\n\n');
			return state.entry.client.generate(targetModel, prompt, callParams);
		});
	}

	recordLatency(id: string, ms: number): void {
		const s = this.states.find((x) => x.entry.config.id === id);
		if (s === undefined) {
			return;
		}
		this.updateSuccess(s, ms);
	}

	markUnhealthy(id: string, error = 'unavailable'): void {
		const s = this.states.find((x) => x.entry.config.id === id);
		if (s === undefined) {
			return;
		}
		this.updateFailure(s, error);
	}

	stats(): ProviderStats[] {
		return this.rankedStates().map((s) => ({
			id: s.entry.config.id,
			defaultModel: s.entry.config.defaultModel,
			ewmaMs: s.ewmaMs === null ? null : Math.round(s.ewmaMs),
			successes: s.successes,
			failures: s.failures,
			unhealthyUntil: s.unhealthyUntil,
			lastError: s.lastError,
		}));
	}

	private rankedStates(): ProviderState[] {
		const t = this.now();
		const healthy: ProviderState[] = [];
		const cooling: ProviderState[] = [];
		for (const s of this.states) {
			if (s.unhealthyUntil <= t) {
				healthy.push(s);
			} else {
				cooling.push(s);
			}
		}
		const byLatency = (a: ProviderState, b: ProviderState): number => {
			if (a.ewmaMs !== null && b.ewmaMs !== null) {
				return a.ewmaMs - b.ewmaMs;
			}
			if (a.ewmaMs !== null) {
				return -1;
			}
			if (b.ewmaMs !== null) {
				return 1;
			}
			return a.order - b.order;
		};
		healthy.sort(byLatency);
		cooling.sort(
			(a, b) => a.unhealthyUntil - b.unhealthyUntil || byLatency(a, b),
		);
		return [...healthy, ...cooling];
	}

	private updateSuccess(state: ProviderState, ms: number): void {
		state.successes += 1;
		state.unhealthyUntil = 0;
		state.lastError = null;
		state.ewmaMs =
			state.ewmaMs === null
				? ms
				: this.ewmaAlpha * ms + (1 - this.ewmaAlpha) * state.ewmaMs;
	}

	private updateFailure(state: ProviderState, error: string): void {
		state.failures += 1;
		state.unhealthyUntil = this.now() + this.cooldownMs;
		state.lastError = error.slice(0, 160);
	}

	private resolveCall(
		state: ProviderState,
		requestedModel: string,
		attemptIndex: number,
		params?: ChatParams,
	): { targetModel: string; callParams: ChatParams | undefined } {
		const targetModel =
			requestedModel === 'auto' || attemptIndex > 0
				? state.entry.config.defaultModel
				: requestedModel;
		const mergedExtra =
			state.entry.config.extraBody === undefined &&
			params?.extraBody === undefined
				? undefined
				: {
						...params?.extraBody,
						...state.entry.config.extraBody,
					};
		if (params === undefined && mergedExtra === undefined) {
			return { targetModel, callParams: undefined };
		}
		const callParams: ChatParams = { ...params };
		if (mergedExtra !== undefined) {
			callParams.extraBody = mergedExtra;
		}
		return { targetModel, callParams };
	}

	private async invokeOne(
		state: ProviderState,
		requestedModel: string,
		attemptIndex: number,
		params: ChatParams | undefined,
		runner: (
			state: ProviderState,
			targetModel: string,
			callParams: ChatParams | undefined,
		) => Promise<ChatResult>,
	): Promise<{ state: ProviderState; result: ChatResult }> {
		const { targetModel, callParams } = this.resolveCall(
			state,
			requestedModel,
			attemptIndex,
			params,
		);
		const t0 = this.now();
		try {
			const result = await runner(state, targetModel, callParams);
			this.updateSuccess(state, Math.max(0, this.now() - t0));
			return { state, result };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.updateFailure(state, msg);
			throw e;
		}
	}

	private async dispatch(
		requestedModel: string,
		params: ChatParams | undefined,
		runner: (
			state: ProviderState,
			targetModel: string,
			callParams: ChatParams | undefined,
		) => Promise<ChatResult>,
	): Promise<ChatResult> {
		const candidates = this.rankedStates();
		const errors: string[] = [];

		// Hedged execution for the top-2 healthy candidates when configured.
		const primary = candidates[0];
		const secondary = candidates[1];
		if (
			this.hedgeAfterMs !== undefined &&
			this.hedgeAfterMs > 0 &&
			primary !== undefined &&
			secondary !== undefined &&
			primary.unhealthyUntil <= this.now() &&
			secondary.unhealthyUntil <= this.now()
		) {
			const hedged = await this.dispatchHedged(
				primary,
				secondary,
				requestedModel,
				params,
				runner,
				errors,
			);
			if (hedged !== undefined) {
				return hedged;
			}
			// Fall through to remaining candidates (index >= 2) if both hedged calls failed.
			for (let i = 2; i < candidates.length; i++) {
				const s = candidates[i];
				if (s === undefined) {
					continue;
				}
				try {
					const ok = await this.invokeOne(s, requestedModel, i, params, runner);
					this.lastProvider = ok.state.entry.config.id;
					return ok.result;
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					errors.push(`${s.entry.config.id}: ${msg}`);
				}
			}
			throw new Error(`all providers failed: ${errors.join('; ')}`);
		}

		for (let i = 0; i < candidates.length; i++) {
			const s = candidates[i];
			if (s === undefined) {
				continue;
			}
			try {
				const ok = await this.invokeOne(s, requestedModel, i, params, runner);
				this.lastProvider = ok.state.entry.config.id;
				return ok.result;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				errors.push(`${s.entry.config.id}: ${msg}`);
			}
		}
		throw new Error(`all providers failed: ${errors.join('; ')}`);
	}

	private async dispatchHedged(
		primary: ProviderState,
		secondary: ProviderState,
		requestedModel: string,
		params: ChatParams | undefined,
		runner: (
			state: ProviderState,
			targetModel: string,
			callParams: ChatParams | undefined,
		) => Promise<ChatResult>,
		errors: string[],
	): Promise<ChatResult | undefined> {
		const hedgeDelay = this.hedgeAfterMs ?? 0;
		return new Promise<ChatResult | undefined>((resolve) => {
			let settled = false;
			let pending = 1;
			let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

			const maybeDone = (): void => {
				if (!settled && pending === 0) {
					settled = true;
					resolve(undefined);
				}
			};

			const launch = (s: ProviderState, attemptIdx: number): void => {
				void this.invokeOne(s, requestedModel, attemptIdx, params, runner).then(
					(ok) => {
						if (hedgeTimer !== undefined) {
							clearTimeout(hedgeTimer);
						}
						if (!settled) {
							settled = true;
							this.lastProvider = ok.state.entry.config.id;
							resolve(ok.result);
						}
					},
					(e: unknown) => {
						const msg = e instanceof Error ? e.message : String(e);
						errors.push(`${s.entry.config.id}: ${msg}`);
						pending -= 1;
						if (hedgeTimer !== undefined && attemptIdx === 0 && !settled) {
							clearTimeout(hedgeTimer);
							hedgeTimer = undefined;
							pending += 1;
							launch(secondary, 1);
							return;
						}
						maybeDone();
					},
				);
			};

			hedgeTimer = setTimeout(() => {
				hedgeTimer = undefined;
				if (!settled) {
					pending += 1;
					launch(secondary, 1);
				}
			}, hedgeDelay);

			launch(primary, 0);
		});
	}
}

export function buildProviderPoolFromMap(
	vars: Record<string, string | undefined>,
	opts?: ProviderPoolOptions,
): ProviderPool | undefined {
	const configs = opts?.configs ?? ALL_PROVIDER_CONFIGS;
	const entries: ProviderEntry[] = [];
	for (const cfg of configs) {
		const apiKey = vars[cfg.keyName];
		if (apiKey === undefined || apiKey.length === 0) {
			continue;
		}
		entries.push({
			config: cfg,
			client: new OpenAIChatClient({
				apiKey,
				baseUrl: cfg.baseUrl,
				...(opts?.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
				...(cfg.timeoutMs === undefined ? {} : { timeoutMs: cfg.timeoutMs }),
			}),
		});
	}
	if (entries.length === 0) {
		return undefined;
	}
	return new ProviderPool(entries, opts);
}

export function buildProviderPoolFromEnv(
	env: Env,
	opts?: ProviderPoolOptions,
): ProviderPool | undefined {
	const vars: Record<string, string | undefined> = {
		NIM_API_KEY: env.NIM_API_KEY,
		GROQ_API_KEY: env.GROQ_API_KEY,
		CEREBRAS_API_KEY: env.CEREBRAS_API_KEY,
		OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
		OPENTYPHOON: env.OPENTYPHOON,
		ROUTMY: env.ROUTMY,
		EXPERIMENTALLABS: env.EXPERIMENTALLABS,
		ANYAPI: env.ANYAPI,
		DREAMPROMPTING: env.DREAMPROMPTING,
		REGOLO: env.REGOLO,
		FREEMODEL: env.FREEMODEL,
	};
	return buildProviderPoolFromMap(vars, opts);
}
