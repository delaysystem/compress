import { describe, expect, it } from 'vitest';
import { parseSseEvents } from '../src/sse.ts';

function streamOf(
	chunks: Array<string | Uint8Array>,
): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	const parts = chunks.map((c) => (typeof c === 'string' ? enc.encode(c) : c));
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const p of parts) {
				controller.enqueue(p);
			}
			controller.close();
		},
	});
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
	const out: string[] = [];
	for await (const p of parseSseEvents(body)) {
		out.push(p);
	}
	return out;
}

describe('parseSseEvents', () => {
	it('splits frames and joins data lines', async () => {
		await expect(
			collect(streamOf(['data: {"a":1}\n\ndata: {"b":2}\n\n'])),
		).resolves.toEqual(['{"a":1}', '{"b":2}']);
	});

	it('tolerates lines split across chunks including mid-character multibyte splits', async () => {
		const enc = new TextEncoder();
		const full = enc.encode('data: {"t":"€"}\n\n');
		const cut = 'data: {"t":"'.length + 1; // inside the 3-byte € sequence
		await expect(
			collect(streamOf([full.slice(0, cut), full.slice(cut)])),
		).resolves.toEqual(['{"t":"€"}']);
	});

	it('ignores comments and dispatches unterminated trailing frames', async () => {
		await expect(collect(streamOf([': ping\n\ndata: x\n']))).resolves.toEqual([
			'x',
		]);
	});

	it('stops at [DONE]', async () => {
		await expect(
			collect(streamOf(['data: a\n\ndata: [DONE]\n\ndata: b\n\n'])),
		).resolves.toEqual(['a']);
	});

	it('handles CRLF endings and preserves escaped sequences', async () => {
		await expect(
			collect(
				streamOf(['data: {"a":1}\r\n\r\ndata: {"t":"a\\r\\nb"}\r\n\r\n']),
			),
		).resolves.toEqual(['{"a":1}', '{"t":"a\\r\\nb"}']);
	});

	it('yields nothing for empty streams', async () => {
		await expect(collect(streamOf([]))).resolves.toEqual([]);
		await expect(collect(streamOf(['\n\n']))).resolves.toEqual([]);
	});
});
