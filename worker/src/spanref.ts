// Span-reference resolver (PLAN.md Step 3: span-ref design + validator).
// Addressing is {doc, span} pairs against a versioned document store.
// Wire format is minimal JSON {"d": "...", "s": "..."}: doc ids already contain
// '#' and prose-ish text, so delimiter joins are ambiguous; JSON round-trips
// exactly. Token cost of this format is measured (recount runner), not assumed.
// Index-based addressing (doc position in prompt) was considered and rejected
// for v0: it couples refs to prompt layout and breaks history re-reads.
// Resolution fails fast on the first unknown doc/span: any miss fails the reply.

export interface SpanRef {
	doc: string;
	span: string;
}

export interface SpanStore {
	version: string;
	documents: Map<string, Map<string, string>>;
}

export type ResolveResult =
	| { ok: true; spans: Array<{ ref: SpanRef; text: string }> }
	| { ok: false; error: string };

export function formatRef(ref: SpanRef): string {
	return JSON.stringify({ d: ref.doc, s: ref.span });
}

// Request-scoped short refs (run 030): ^12 addresses span 12 in the
// prompt-carried request map (pseudo-doc 'q'). Valid only with the map
// version they were minted against; never persisted as history (v0's
// index-rejection stands for durable refs). Span ids are 1-3 digits.
export const SHORT_DOC = 'q';
const SHORT_LINE_RE = /^\^(\d{1,3})$/;
const SHORT_INLINE_RE = /\^(\d{1,3})/g;

export function parseShortRef(wire: string): SpanRef | undefined {
	const m = SHORT_LINE_RE.exec(wire.trim());
	return m?.[1] === undefined
		? undefined
		: { doc: SHORT_DOC, span: m[1] as string };
}

/** Expand inline ^12 refs in spliced text against the request map.
 * Unknown numbers fail loud (cited-but-absent is an emitter bug). */
export function expandShortRefs(
	store: SpanStore,
	kbVersion: string,
	text: string,
): { ok: true; text: string } | { ok: false; error: string } {
	if (store.version !== kbVersion) {
		return {
			ok: false,
			error: `kb version mismatch: have ${store.version}, want ${kbVersion}`,
		};
	}
	const doc = store.documents.get(SHORT_DOC);
	const missing: string[] = [];
	const out = text.replace(SHORT_INLINE_RE, (_m, num: string) => {
		const hit = doc?.get(num);
		if (hit === undefined) {
			missing.push(num);
			return _m;
		}
		return hit;
	});
	if (missing.length > 0) {
		return { ok: false, error: `unknown span: ${missing.join(',')}` };
	}
	return { ok: true, text: out };
}

export function parseRef(wire: string): SpanRef | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(wire);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	const doc = record.d;
	const span = record.s;
	if (
		typeof doc !== 'string' ||
		typeof span !== 'string' ||
		doc.length === 0 ||
		span.length === 0
	) {
		return undefined;
	}
	return { doc, span };
}

export function resolveRefs(
	store: SpanStore,
	kbVersion: string,
	refs: SpanRef[],
): ResolveResult {
	if (store.version !== kbVersion) {
		return {
			ok: false,
			error: `kb version mismatch: have ${store.version}, want ${kbVersion}`,
		};
	}
	const spans: Array<{ ref: SpanRef; text: string }> = [];
	for (const ref of refs) {
		const doc = store.documents.get(ref.doc);
		if (doc === undefined) {
			return { ok: false, error: `unknown doc: ${ref.doc}` };
		}
		const text = doc.get(ref.span);
		if (text === undefined) {
			return {
				ok: false,
				error: `unknown span: ${ref.span} in doc ${ref.doc}`,
			};
		}
		spans.push({ ref, text });
	}
	return { ok: true, spans };
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}

/** Validated constructor for staged span stores. Fails loud on corrupt data. */
export function spanStoreFromJson(version: string, v: unknown): SpanStore {
	if (!isRecord(v) || Array.isArray(v)) {
		throw new Error('spanstore: top level must be an object');
	}
	const documents = new Map<string, Map<string, string>>();
	for (const [docId, spans] of Object.entries(v)) {
		if (!isRecord(spans) || Array.isArray(spans)) {
			throw new Error(`spanstore: doc ${docId} must be an object`);
		}
		const inner = new Map<string, string>();
		for (const [spanId, text] of Object.entries(spans)) {
			if (typeof text !== 'string') {
				throw new Error(
					`spanstore: span ${spanId} in ${docId} must be a string`,
				);
			}
			inner.set(spanId, text);
		}
		documents.set(docId, inner);
	}
	return { version, documents };
}
