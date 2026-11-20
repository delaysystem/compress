// Streaming-delta reassembly (PLAN.md Step 3: streamed tool calls arrive as
// argument deltas requiring reassembly before routing/validation).
// Provider chunk objects (post-SSE-parse) normalize to StreamDelta events;
// the accumulator rebuilds complete text + tool calls. JSON arguments parse
// once at finalize; malformed streams fail fast naming the call index.
// Chunk shapes follow the providers' documented streaming contracts.
// Fixture status: Gemini text chunks recorded live 2026-11-11; functionCall
// and OpenAI shapes still doc-based (tools support / OpenAI key pending).

export type StreamDelta =
	| { kind: 'text'; text: string }
	| {
			kind: 'toolCall';
			index: number;
			id: string | undefined;
			name: string | undefined;
			argumentsFragment: string | undefined;
	  }
	| { kind: 'completeCall'; id: string | null; name: string; args: unknown }
	| { kind: 'finish'; finishReason: string };

export interface NormalizedToolCall {
	id: string | null;
	name: string;
	args: unknown;
}

export interface FinalizedStream {
	finishReason: string;
	text: string;
	toolCalls: NormalizedToolCall[];
}

export type FinalizeResult =
	| { ok: true; value: FinalizedStream }
	| { ok: false; error: string };

interface FragmentCall {
	id: string | undefined;
	name: string | undefined;
	args: string;
}

export class StreamAccumulator {
	private textParts: string[] = [];
	private calls = new Map<number, FragmentCall>();
	private complete: NormalizedToolCall[] = [];
	private finishReason: string | null = null;

	push(delta: StreamDelta): void {
		if (delta.kind === 'text') {
			if (delta.text.length > 0) {
				this.textParts.push(delta.text);
			}
			return;
		}
		if (delta.kind === 'finish') {
			this.finishReason = delta.finishReason;
			return;
		}
		if (delta.kind === 'completeCall') {
			this.complete.push({ id: delta.id, name: delta.name, args: delta.args });
			return;
		}
		let call = this.calls.get(delta.index);
		if (call === undefined) {
			call = { id: undefined, name: undefined, args: '' };
			this.calls.set(delta.index, call);
		}
		if (delta.id !== undefined) {
			call.id = delta.id;
		}
		if (delta.name !== undefined) {
			call.name = delta.name;
		}
		if (delta.argumentsFragment !== undefined) {
			call.args += delta.argumentsFragment;
		}
	}

	finalize(): FinalizeResult {
		if (this.finishReason === null) {
			return { ok: false, error: 'stream ended without finish reason' };
		}
		const toolCalls: NormalizedToolCall[] = [];
		const indices = [...this.calls.keys()].sort((a, b) => a - b);
		for (const index of indices) {
			const call = this.calls.get(index);
			if (call === undefined) {
				continue;
			}
			if (call.name === undefined || call.name.length === 0) {
				return {
					ok: false,
					error: `incomplete tool call at index ${index}: missing name`,
				};
			}
			let args: unknown = null;
			if (call.args.length > 0) {
				try {
					const parsed: unknown = JSON.parse(call.args);
					args = parsed;
				} catch {
					return {
						ok: false,
						error: `invalid tool arguments JSON at index ${index}`,
					};
				}
			}
			toolCalls.push({ id: call.id ?? null, name: call.name, args });
		}
		for (const c of this.complete) {
			if (c.name.length === 0) {
				return { ok: false, error: 'complete tool call missing name' };
			}
			toolCalls.push(c);
		}
		return {
			ok: true,
			value: {
				finishReason: this.finishReason,
				text: this.textParts.join(''),
				toolCalls,
			},
		};
	}
}

// --- provider chunk adapters (chunk objects, post-SSE framing) ---

export interface GeminiStreamChunk {
	candidates?: Array<{
		content?: {
			parts?: Array<{
				text?: string;
				functionCall?: { name?: string; args?: unknown } | null;
			}>;
		};
		finishReason?: string;
	}>;
}

export function geminiChunkToDeltas(chunk: GeminiStreamChunk): StreamDelta[] {
	const deltas: StreamDelta[] = [];
	for (const cand of chunk.candidates ?? []) {
		for (const part of cand.content?.parts ?? []) {
			if (typeof part.text === 'string' && part.text.length > 0) {
				deltas.push({ kind: 'text', text: part.text });
			}
			if (part.functionCall !== undefined && part.functionCall !== null) {
				deltas.push({
					kind: 'completeCall',
					id: null,
					name: part.functionCall.name ?? '',
					args: part.functionCall.args ?? null,
				});
			}
		}
		if (typeof cand.finishReason === 'string' && cand.finishReason.length > 0) {
			deltas.push({ kind: 'finish', finishReason: cand.finishReason });
		}
	}
	return deltas;
}

export interface OpenAIStreamChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
}

export function openaiChunkToDeltas(chunk: OpenAIStreamChunk): StreamDelta[] {
	const deltas: StreamDelta[] = [];
	for (const choice of chunk.choices ?? []) {
		const delta = choice.delta;
		if (typeof delta?.content === 'string' && delta.content.length > 0) {
			deltas.push({ kind: 'text', text: delta.content });
		}
		for (const tc of delta?.tool_calls ?? []) {
			const fn = tc.function;
			if (
				tc.id === undefined &&
				fn?.name === undefined &&
				fn?.arguments === undefined
			) {
				continue;
			}
			deltas.push({
				kind: 'toolCall',
				index: tc.index ?? 0,
				id: tc.id,
				name: fn?.name,
				argumentsFragment: fn?.arguments,
			});
		}
		if (
			typeof choice.finish_reason === 'string' &&
			choice.finish_reason.length > 0
		) {
			deltas.push({ kind: 'finish', finishReason: choice.finish_reason });
		}
	}
	return deltas;
}
