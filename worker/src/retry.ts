// Retry policy (extracted after the IR pilot's 429 failures, 2026-11-11).
// Retryable: network throws, timeouts, 429 backpressure, 5xx.
// Fatal immediately: other 4xx (bad request/auth/not-found never heal).
// 429s get the longer budget: backpressure is a slowdown signal, not failure.

import { GeminiError } from './gemini.ts';
import { OpenAIError } from './openai.ts';

export interface RetryBudget {
	maxAttempts: number;
	baseMs: number;
}

/** Starting point chosen after observing burst behavior; tuned by pilot runs. */
export const DEFAULT_BUDGET: RetryBudget = { maxAttempts: 4, baseMs: 1000 };

/** Starting point chosen after observing 429s at burst rate; tuned by pilot runs. */
export const BACKPRESSURE_BUDGET: RetryBudget = {
	maxAttempts: 8,
	baseMs: 5000,
};

type ApiError = GeminiError | OpenAIError;

function asApiError(e: unknown): ApiError | null {
	return e instanceof GeminiError || e instanceof OpenAIError ? e : null;
}

export function isRetryable(e: unknown): boolean {
	const api = asApiError(e);
	if (api === null) {
		return true;
	}
	if (api.status === 429 || api.status === 408) {
		return true;
	}
	return api.status >= 500;
}

export function isBackpressure(e: unknown): boolean {
	const api = asApiError(e);
	return api !== null && api.status === 429;
}

/** Patience for a full backpressure wall. Chosen: per-minute quota outages
 * clear within ~60s; 5 straight minutes of zero-success 429s is systematic
 * (run 026 evidence: a count-10 trip misfired on a recovering throttle —
 * counts cannot separate a 60s full outage from a dead quota; time can). */
export const BACKPRESSURE_WINDOW_MS = 5 * 60 * 1000;

/** Single-call burn ceiling. Catches the slow-sick class a window trip
 * cannot: rows that SUCCEED after minutes of backoff (v3 evidence: 11
 * rows/hour) keep resetting any success-gated trip, so the call itself
 * must abort loudly past 10 minutes. */
export const CALL_TIME_TRIP_MS = 10 * 60 * 1000;

/** Shared fail-fast: feed every call outcome; trips loud when backpressure
 * persists with zero success for the whole window, so a dead quota aborts
 * a campaign instead of burning retry budgets per row. One instance per
 * model — a live model must not reset a dead model's trip. Synchronous
 * updates are race-free under Node's interleaving. */
export class BackpressureTrip {
	private windowStart: number | null = null;
	private latched = false;
	private readonly windowMs: number;

	// No parameter properties: runners execute via --experimental-strip-types,
	// which rejects non-erasable syntax (explicit assignment instead).
	constructor(windowMs: number = BACKPRESSURE_WINDOW_MS) {
		this.windowMs = windowMs;
	}

	/** Returns true once tripped (stays tripped; a campaign abort follows). */
	recordBackpressure(): boolean {
		const now = Date.now();
		if (this.windowStart === null) {
			this.windowStart = now;
		}
		if (now - this.windowStart >= this.windowMs) {
			this.latched = true;
		}
		return this.latched;
	}

	recordSuccess(): void {
		// Latched: a success after the trip does not untrip the campaign.
		if (!this.latched) {
			this.windowStart = null;
		}
	}

	get tripped(): boolean {
		return this.latched;
	}
}

/** Full-jitter exponential backoff. rand injectable for deterministic tests. */
export function backoffMs(
	attempt: number,
	baseMs: number,
	rand: () => number = Math.random,
): number {
	const capped = Math.min(attempt, 10);
	return Math.floor(baseMs * 2 ** capped + rand() * 500);
}
