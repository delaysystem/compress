import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiError } from '../src/gemini.ts';
import { OpenAIError } from '../src/openai.ts';
import {
	BACKPRESSURE_BUDGET,
	BACKPRESSURE_WINDOW_MS,
	BackpressureTrip,
	backoffMs,
	DEFAULT_BUDGET,
	isBackpressure,
	isRetryable,
} from '../src/retry.ts';

describe('isRetryable', () => {
	it('retries backpressure, timeouts, and server errors', () => {
		expect(isRetryable(new GeminiError(429, 'quota'))).toBe(true);
		expect(isRetryable(new GeminiError(408, 'timeout'))).toBe(true);
		expect(isRetryable(new GeminiError(500, 'boom'))).toBe(true);
		expect(isRetryable(new GeminiError(503, 'unavailable'))).toBe(true);
		expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
	});

	it('fails fast on client errors', () => {
		for (const status of [400, 401, 403, 404]) {
			expect(isRetryable(new GeminiError(status, 'nope'))).toBe(false);
		}
	});

	it('treats OpenAI errors by the same status rules', () => {
		expect(isRetryable(new OpenAIError(429, 'quota'))).toBe(true);
		expect(isRetryable(new OpenAIError(408, 'timeout'))).toBe(true);
		expect(isRetryable(new OpenAIError(500, 'boom'))).toBe(true);
		expect(isRetryable(new OpenAIError(401, 'bad key'))).toBe(false);
		expect(isBackpressure(new OpenAIError(429, 'quota'))).toBe(true);
		expect(isBackpressure(new OpenAIError(503, 'busy'))).toBe(false);
	});
});

describe('isBackpressure', () => {
	it('matches only 429s', () => {
		expect(isBackpressure(new GeminiError(429, 'quota'))).toBe(true);
		expect(isBackpressure(new GeminiError(503, 'busy'))).toBe(false);
		expect(isBackpressure(new Error('x'))).toBe(false);
	});
});

describe('backoffMs', () => {
	it('grows exponentially with full jitter', () => {
		expect(backoffMs(0, 1000, () => 0)).toBe(1000);
		expect(backoffMs(1, 1000, () => 0)).toBe(2000);
		expect(backoffMs(2, 1000, () => 0)).toBe(4000);
		expect(backoffMs(0, 1000, () => 1)).toBe(1500);
	});

	it('caps the exponent', () => {
		expect(backoffMs(100, 1000, () => 0)).toBe(1000 * 1024);
	});
});

describe('budgets', () => {
	it('gives backpressure a longer budget than the default', () => {
		expect(BACKPRESSURE_BUDGET.maxAttempts).toBeGreaterThan(
			DEFAULT_BUDGET.maxAttempts,
		);
		expect(BACKPRESSURE_BUDGET.baseMs).toBeGreaterThan(DEFAULT_BUDGET.baseMs);
		expect(DEFAULT_BUDGET).toEqual({ maxAttempts: 4, baseMs: 1000 });
		expect(BACKPRESSURE_BUDGET).toEqual({ maxAttempts: 8, baseMs: 5000 });
	});
});

describe('BackpressureTrip', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('trips after a full window with zero success', () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const trip = new BackpressureTrip(60_000);
		expect(trip.recordBackpressure()).toBe(false);
		vi.setSystemTime(59_999);
		expect(trip.recordBackpressure()).toBe(false);
		vi.setSystemTime(60_000);
		expect(trip.recordBackpressure()).toBe(true);
		expect(trip.tripped).toBe(true);
	});

	it('stays tripped once tripped (latched)', () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const trip = new BackpressureTrip(1000);
		trip.recordBackpressure();
		vi.setSystemTime(1000);
		trip.recordBackpressure();
		trip.recordSuccess();
		expect(trip.tripped).toBe(true);
	});

	it('resets the window on success', () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const trip = new BackpressureTrip(1000);
		trip.recordBackpressure();
		vi.setSystemTime(999);
		trip.recordSuccess();
		vi.setSystemTime(1998);
		expect(trip.recordBackpressure()).toBe(false);
		expect(trip.tripped).toBe(false);
	});

	it('defaults to the pinned constant', () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const trip = new BackpressureTrip();
		trip.recordBackpressure();
		vi.setSystemTime(BACKPRESSURE_WINDOW_MS - 1);
		expect(trip.recordBackpressure()).toBe(false);
		vi.setSystemTime(BACKPRESSURE_WINDOW_MS);
		expect(trip.recordBackpressure()).toBe(true);
	});
});
