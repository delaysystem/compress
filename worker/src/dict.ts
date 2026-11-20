// Versioned template-dictionary codec (PLAN.md version-pinning + code-length rule).
// Serving direction is decode: the model emits codes, the pipeline expands.
// There is intentionally no text->codes encoder here: code assignment happens
// offline in mining (Step 1); a runtime fuzzy encoder would be a second,
// unvalidated guesser. Slot values are copied verbatim (byte-exact, no trim).

export interface DictEntry {
	code: string;
	template: string;
	slots: string[];
}

export interface Dictionary {
	version: string;
	entries: DictEntry[];
}

export type DecodeResult =
	| { ok: true; text: string }
	| { ok: false; error: string };

// Single-brace slots only: {{...}} markers are legitimate slot content
// (rule: copy markers exact, inside slots too) and must not trip this.
const LEFTOVER_RE = /(?<!\{)\{[^{}]*\}(?!\})/;

export function findEntry(
	dict: Dictionary,
	code: string,
): DictEntry | undefined {
	return dict.entries.find((e) => e.code === code);
}

/** Render dictionary entries as emit-prompt codebook lines. Slot order in
 * each template is the wire order (matches decodeLine positional fill).
 * topN caps prompt cost; entries are pre-ordered by coverage. wire 'bare'
 * omits the : prefix (lenient parser accepts it); default ':' is explicit. */
export function dictToPrompt(
	dict: Dictionary,
	opts?: { topN?: number; wire?: ':' | 'bare' | 'v3' | 'v3x' },
): string {
	const n = opts?.topN ?? dict.entries.length;
	const wire = opts?.wire ?? ':';
	const compact = wire === 'v3x';
	const lines = dict.entries
		.slice(0, Math.max(0, n))
		.map((e) =>
			compact ? `${e.code}:${e.template}` : `${e.code} means "${e.template}"`,
		);
	const usage =
		wire === 'bare'
			? 'Emit one code per line as <code>|<slot1>|<slot2> with slot values in template order; slotless codes as <code> alone. Example: a|duplicate charges. Never add a : prefix.'
			: wire === 'v3' || wire === 'v3x'
				? 'Emit ONE line: space-separated <code> <slots...> segments in template order (e.g. AX widget WB first | second MC). | only between slots of multi-slot codes. Free text needs TX (e.g. TX some note). Backslash-escape any payload word equal to a code. Never emit newlines.'
				: 'Emit one code per line as :<code>|<slot1>|<slot2> with slot values in template order; slotless codes as :<code>. Example: :a|duplicate charges. Never emit a bare code without the : prefix, and never start an uncoded line with :.';
	return [
		compact
			? 'Codebook:'
			: 'Codebook (emit codes, never write out a coded line):',
		...lines,
		usage,
	].join('\n');
}

export function decodeLine(
	dict: Dictionary,
	version: string,
	code: string,
	slotValues: string[],
): DecodeResult {
	if (dict.version !== version) {
		return {
			ok: false,
			error: `dict version mismatch: have ${dict.version}, want ${version}`,
		};
	}
	const entry = findEntry(dict, code);
	if (entry === undefined) {
		return { ok: false, error: `unknown code: ${code}` };
	}
	if (slotValues.length !== entry.slots.length) {
		return {
			ok: false,
			error: `arity mismatch for ${code}: want ${entry.slots.length}, got ${slotValues.length}`,
		};
	}
	let text = entry.template;
	for (let i = 0; i < entry.slots.length; i++) {
		// Lengths pre-checked above; the guard satisfies noUncheckedIndexedAccess.
		const name = entry.slots[i];
		const value = slotValues[i];
		if (name === undefined || value === undefined) {
			continue;
		}
		text = text.replaceAll(`{${name}}`, value);
	}
	if (LEFTOVER_RE.test(text)) {
		return { ok: false, error: `unfilled placeholder in ${code}` };
	}
	return { ok: true, text: destutterLeading(text) };
}

// Leading-pair destutter (run 038 banked row: "Describe describe problem"):
// emitters repeat the template verb inside the slot. Drop the second of two
// leading case-insensitive matches (trailing punctuation ignored); loop for
// triples. The drop applies only when content remains after it: collapsing
// "Complaint: complaint" to a dangling "Complaint:" derails the SLM into
// hallucinating URLs and steps (proven live on bitext-7429 A/B), so
// degenerate lines keep their stutter. Mid-line duplicates are untouched
// (unobserved; out of scope), as is anything without two leading words.
function destutterLeading(text: string): string {
	const norm = (w: string): string =>
		w.replace(/[;:,.!?]+$/g, '').toLowerCase();
	let out = text;
	for (;;) {
		const m = /^(\S+)(\s+)(\S+)([\s\S]*)$/.exec(out);
		const first = m?.[1];
		const second = m?.[3];
		const rest = m?.[4];
		if (first === undefined || second === undefined || rest === undefined) {
			return out;
		}
		const a = norm(first);
		if (a.length === 0 || a !== norm(second) || rest.trim().length === 0) {
			return out;
		}
		out = `${first}${rest}`;
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}

/** Validated constructor for bundled/staged dictionaries. Fails loud on corrupt data. */
export function dictFromJson(v: unknown): Dictionary {
	if (!isRecord(v)) {
		throw new Error('dict: top level must be an object');
	}
	const version = v.version;
	if (typeof version !== 'string' || version.length === 0) {
		throw new Error('dict: version must be a non-empty string');
	}
	const rawEntries = v.entries;
	if (!Array.isArray(rawEntries)) {
		throw new Error('dict: entries must be an array');
	}
	const entries: DictEntry[] = rawEntries.map((e: unknown, i: number) => {
		if (!isRecord(e)) {
			throw new Error(`dict: entry ${i} must be an object`);
		}
		const code = e.code;
		const template = e.template;
		const slots = e.slots;
		if (typeof code !== 'string' || code.length === 0) {
			throw new Error(`dict: entry ${i} code must be a non-empty string`);
		}
		if (typeof template !== 'string') {
			throw new Error(`dict: entry ${i} template must be a string`);
		}
		if (!Array.isArray(slots)) {
			throw new Error(`dict: entry ${i} slots must be string[]`);
		}
		const checked: string[] = [];
		for (const s of slots) {
			if (typeof s !== 'string') {
				throw new Error(`dict: entry ${i} slots must be string[]`);
			}
			checked.push(s);
		}
		return { code, template, slots: checked };
	});
	return { version, entries };
}
