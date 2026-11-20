import { describe, expect, it } from 'vitest';
import { fromGemini, fromOpenAI, routeReply } from '../src/router.ts';
import sample from './fixtures/tau2-sample.json';

describe('routeReply', () => {
	it('routes tool calls to the tool path', () => {
		expect(routeReply({ finishReason: null, toolCalls: [{ name: 'x' }] })).toBe(
			'tool_calls',
		);
	});

	it('routes a tool-call finish reason with an empty array to the tool path', () => {
		expect(routeReply({ finishReason: 'tool_calls', toolCalls: [] })).toBe(
			'tool_calls',
		);
	});

	it('routes plain stopped replies to the text path', () => {
		expect(routeReply({ finishReason: 'STOP', toolCalls: [] })).toBe(
			'final_text',
		);
	});

	it('routes mixed content plus tool calls to the tool path (whole message forwarded)', () => {
		expect(
			routeReply({ finishReason: 'STOP', toolCalls: [{ name: 'x' }] }),
		).toBe('tool_calls');
	});
});

describe('fromGemini', () => {
	it('detects functionCall parts', () => {
		const r = fromGemini({
			finishReason: 'STOP',
			content: {
				parts: [{ text: 'hi' }, { functionCall: { name: 'lookup', args: {} } }],
			},
		});
		expect(r.toolCalls).toHaveLength(1);
		expect(routeReply(r)).toBe('tool_calls');
	});

	it('maps text-only candidates to final text', () => {
		const r = fromGemini({
			finishReason: 'STOP',
			content: { parts: [{ text: 'hello' }] },
		});
		expect(routeReply(r)).toBe('final_text');
	});

	it('treats missing content as no tool calls', () => {
		expect(routeReply(fromGemini({ finishReason: 'STOP' }))).toBe('final_text');
	});
});

describe('fromOpenAI', () => {
	it('maps tool_calls through', () => {
		const r = fromOpenAI({
			finish_reason: 'tool_calls',
			tool_calls: [{ id: '1' }],
		});
		expect(routeReply(r)).toBe('tool_calls');
	});

	it('maps nulls to an empty envelope', () => {
		expect(routeReply(fromOpenAI({}))).toBe('final_text');
	});

	it('routes the real tau2 fixture shapes', () => {
		const kinds = sample.messages.map((m) => {
			const toolCalls =
				'tool_calls' in m && Array.isArray(m.tool_calls) ? m.tool_calls : null;
			return routeReply(
				fromOpenAI({ finish_reason: null, tool_calls: toolCalls }),
			);
		});
		expect(kinds).toEqual([
			'final_text',
			'tool_calls',
			'final_text',
			'final_text',
		]);
	});
});
