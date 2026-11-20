// Emit-side compliance checks (run 034+): enumerate every line the
// decoder would reject (unknown code, arity mismatch, malformed line)
// so the repair loop can feed them ALL back in one retry —
// prepareExpansion reports only the first error. Pure and total.
import { type Dictionary, findEntry } from './dict.ts';
import { classifyLine, parseCodeLine } from './expander.ts';

export type CodeViolation =
	| { line: number; code: string; kind: 'arity'; want: number; got: number }
	| {
			line: number;
			code: string;
			kind: 'unknown' | 'malformed';
			detail: string;
	  };

export function codeViolations(
	irText: string,
	dict: Dictionary,
): CodeViolation[] {
	const out: CodeViolation[] = [];
	const lines = irText.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const kind = classifyLine(line);
		if (kind === 'text' || kind === 'span') {
			continue;
		}
		if (kind === 'malformed') {
			out.push({
				line: i + 1,
				code: '',
				kind: 'malformed',
				detail: line.trim().slice(0, 60),
			});
			continue;
		}
		const use = parseCodeLine(line);
		if (use === undefined) {
			out.push({
				line: i + 1,
				code: '',
				kind: 'unknown',
				detail: 'unparseable code line',
			});
			continue;
		}
		const entry = findEntry(dict, use.code);
		if (entry === undefined) {
			out.push({
				line: i + 1,
				code: use.code,
				kind: 'unknown',
				detail: `unknown code: ${use.code}`,
			});
			continue;
		}
		if (use.slotValues.length !== entry.slots.length) {
			out.push({
				line: i + 1,
				code: use.code,
				kind: 'arity',
				want: entry.slots.length,
				got: use.slotValues.length,
			});
		}
	}
	return out;
}

/** Deterministic line-level repair (run 035+): rewrite every line the
 * decoder would reject WITHOUT a model call. Rules, in order: exact
 * comma-split for a lone short value (mis-packing, unambiguous),
 * surplus merge into the last slot, slotless codes to prefixed form
 * with extras as text, unknown codes to text, malformed lines to a
 * Note, empty results dropped. Entities are preserved on every path
 * (nothing is shortened or deleted except empty strings), so recall
 * cannot drop — only compression on the fixed lines. Span lines pass
 * through untouched (they need a store to judge). Total: the output
 * holds zero code violations. Fixed lines use the bare wire except
 * slotless codes, which REQUIRE the : prefix (bare `m` is text). */
export function autofixIr(
	irText: string,
	dict: Dictionary,
): { ir: string; fixedLines: number } {
	const out: string[] = [];
	let fixed = 0;
	for (const line of irText.split('\n')) {
		const kind = classifyLine(line);
		if (kind === 'text' || kind === 'span') {
			out.push(line);
			continue;
		}
		if (kind === 'malformed') {
			out.push(`Note: ${line.trim()}`);
			fixed += 1;
			continue;
		}
		const use = parseCodeLine(line);
		if (use === undefined) {
			out.push(`Note: ${line.trim()}`);
			fixed += 1;
			continue;
		}
		const entry = findEntry(dict, use.code);
		if (entry === undefined) {
			pushText(out, use.slotValues.join(', '));
			fixed += 1;
			continue;
		}
		const want = entry.slots.length;
		const vals = use.slotValues;
		if (vals.length === want) {
			out.push(line);
			continue;
		}
		fixed += 1;
		if (want === 0) {
			out.push(`:${use.code}`);
			pushText(out, vals.join(', '));
			continue;
		}
		if (vals.length > want) {
			const head = vals.slice(0, want - 1);
			const tail = vals.slice(want - 1).join(', ');
			out.push([use.code, ...head, tail].join('|'));
			continue;
		}
		if (vals.length === 1) {
			const pieces = (vals[0] ?? '')
				.split(',')
				.map((p) => p.trim())
				.filter((p) => p.length > 0);
			if (pieces.length === want) {
				out.push([use.code, ...pieces].join('|'));
				continue;
			}
		}
		pushText(out, vals.join(', '));
	}
	return { ir: out.join('\n'), fixedLines: fixed };
}

/** Append a salvaged text line unless it holds nothing. */
function pushText(out: string[], text: string): void {
	if (text.trim().length > 0) {
		out.push(text);
	}
}
