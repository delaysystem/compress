// Minimal server-sent-events frame parser (transport only, no domain knowledge).
// Splits a byte stream into data payloads: blank-line-delimited frames, data:
// lines joined with \n, ':' comment lines ignored, [DONE] terminates.
// Line breaks are \r\n, \r, or \n (a lone \r still ends a line per SSE;
// JSON encoders escape control chars, so raw CR/LF never appears inside data).
// Tolerant deviation: a trailing frame the stream never blank-terminated is
// still dispatched, because provider streams may end without a blank line.
// Invalid UTF-8 is replaced (TextDecoder default); callers parse JSON.

export async function* parseSseEvents(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = '';
	let data: string[] = [];
	const dispatch = (): string | 'DONE' | undefined => {
		if (data.length === 0) {
			return undefined;
		}
		const payload = data.join('\n');
		data = [];
		return payload === '[DONE]' ? 'DONE' : payload;
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (value !== undefined) {
			pending += decoder.decode(value, { stream: true });
		}
		if (done) {
			pending += decoder.decode();
			for (const line of pending.split(/\r\n|\r|\n/)) {
				const out = handleLine(line);
				if (out === 'DONE') {
					return;
				}
				if (out !== undefined) {
					yield out;
				}
			}
			const tail = dispatch();
			if (tail !== undefined && tail !== 'DONE') {
				yield tail;
			}
			return;
		}
		const parts = pending.split(/\r\n|\r|\n/);
		pending = parts.pop() ?? '';
		for (const line of parts) {
			const out = handleLine(line);
			if (out === 'DONE') {
				return;
			}
			if (out !== undefined) {
				yield out;
			}
		}
	}

	function handleLine(line: string): string | 'DONE' | undefined {
		if (line === '') {
			return dispatch();
		}
		if (line.startsWith(':')) {
			return undefined;
		}
		if (line.startsWith('data:')) {
			data.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
		}
		return undefined;
	}
}
