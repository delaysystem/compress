import { describe, expect, it } from 'vitest';
import {
	type FinalizeResult,
	geminiChunkToDeltas,
	openaiChunkToDeltas,
	StreamAccumulator,
} from '../src/streaming.ts';
import chunks from './fixtures/stream-chunks.json';

function runGemini(key: 'geminiText' | 'geminiFunctionCall'): FinalizeResult {
	const acc = new StreamAccumulator();
	for (const c of chunks[key]) {
		for (const d of geminiChunkToDeltas(c)) {
			acc.push(d);
		}
	}
	return acc.finalize();
}

function runOpenai(
	key:
		| 'openaiText'
		| 'openaiToolFragments'
		| 'openaiInterleaved'
		| 'openaiBadJson'
		| 'openaiMissingName',
): FinalizeResult {
	const acc = new StreamAccumulator();
	for (const c of chunks[key]) {
		for (const d of openaiChunkToDeltas(c)) {
			acc.push(d);
		}
	}
	return acc.finalize();
}

describe('text streams', () => {
	it('joins gemini text deltas and tolerates unknown fields', () => {
		const r = runGemini('geminiText');
		expect(r).toEqual({
			ok: true,
			value: { finishReason: 'STOP', text: 'one two three', toolCalls: [] },
		});
	});

	it('joins openai text deltas', () => {
		const r = runOpenai('openaiText');
		expect(r.ok && r.value.text).toBe('Hi ');
		if (r.ok) {
			expect(r.value.finishReason).toBe('stop');
		}
	});
});

describe('tool call streams', () => {
	it('rebuilds fragmented arguments into one parsed call', () => {
		const r = runOpenai('openaiToolFragments');
		expect(r.ok).toBe(true);
		if (!r.ok) {
			return;
		}
		expect(r.value.finishReason).toBe('tool_calls');
		expect(r.value.toolCalls).toEqual([
			{ id: 'call_1', name: 'get_order', args: { order_id: 'o-1' } },
		]);
	});

	it('keeps interleaved indexes separate and ordered', () => {
		const r = runOpenai('openaiInterleaved');
		expect(r.ok).toBe(true);
		if (!r.ok) {
			return;
		}
		expect(r.value.toolCalls).toEqual([
			{ id: 'a', name: 'get_a', args: { x: 1 } },
			{ id: 'b', name: 'get_b', args: { y: 2 } },
		]);
	});

	it('passes gemini function calls through with object args', () => {
		const r = runGemini('geminiFunctionCall');
		expect(r.ok).toBe(true);
		if (!r.ok) {
			return;
		}
		expect(r.value.text).toBe('Looking it up. ');
		expect(r.value.toolCalls).toEqual([
			{ id: null, name: 'get_order', args: { id: 'o-1' } },
		]);
	});
});

describe('malformed streams', () => {
	it('fails invalid arguments JSON naming the index', () => {
		const r = runOpenai('openaiBadJson');
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain('index 0');
		}
	});

	it('fails nameless calls naming the index', () => {
		const r = runOpenai('openaiMissingName');
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain('index 0');
		}
	});

	it('fails streams without a finish reason', () => {
		const acc = new StreamAccumulator();
		acc.push({ kind: 'text', text: 'dangling' });
		const r = acc.finalize();
		expect(r.ok).toBe(false);
	});
});
