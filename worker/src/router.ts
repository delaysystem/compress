// Typed-envelope routing (PLAN.md Approach/Tool-call passthrough).
// Routes on the typed envelope (finish reason + tool-call presence), never on
// text sniffing. Complete messages only: streaming deltas must pass through
// src/streaming.ts finalize() before reaching this router.

export type ReplyKind = 'tool_calls' | 'final_text';

/** Provider-neutral normalized assistant message. Build with fromGemini/fromOpenAI. */
export interface NormalizedReply {
	/** Normalized finish reason: the provider token, passed through verbatim. */
	finishReason: string | null;
	/** Tool calls present on the envelope; empty means none requested. */
	toolCalls: unknown[];
}

const TOOL_CALL_REASONS = new Set([
	'tool_calls',
	'TOOL_CALLS',
	'function_call',
	'FUNCTION_CALL',
]);

export function routeReply(reply: NormalizedReply): ReplyKind {
	if (reply.toolCalls.length > 0) {
		return 'tool_calls';
	}
	if (
		reply.finishReason !== null &&
		TOOL_CALL_REASONS.has(reply.finishReason)
	) {
		return 'tool_calls';
	}
	return 'final_text';
}

// --- provider adapters (boundary only; preserve shapes, never guess) ---

export interface GeminiCandidate {
	finishReason?: string | null;
	content?: { parts?: Array<{ text?: string; functionCall?: unknown }> } | null;
}

export function fromGemini(candidate: GeminiCandidate): NormalizedReply {
	const parts = candidate.content?.parts ?? [];
	return {
		finishReason: candidate.finishReason ?? null,
		toolCalls: parts.filter(
			(p) => p.functionCall !== undefined && p.functionCall !== null,
		),
	};
}

export interface OpenAIMessage {
	finish_reason?: string | null;
	tool_calls?: unknown[] | null;
}

export function fromOpenAI(message: OpenAIMessage): NormalizedReply {
	return {
		finishReason: message.finish_reason ?? null,
		toolCalls: message.tool_calls ?? [],
	};
}
