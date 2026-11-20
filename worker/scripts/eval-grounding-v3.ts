// Offline tier-1 grounding eval over the frozen v3 rows: reassembles each
// row's grounding from the corpus (mirror of ir-pilot-v3.ts assembly, with
// per-row word-count assert) and runs checkEntityGrounding(IR, grounding).
// No API calls. Writes data/derived/grounding-eval-v3.json; runner and v3
// outputs untouched.
// Run from worker/: node --experimental-strip-types scripts/eval-grounding-v3.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEntities } from '../src/entities.ts';
import { checkEntityGrounding } from '../src/grounding.ts';

interface Row {
	key: string;
	reference: string;
	groundingMeta: { words: number };
	irLite: string;
	puntLite: boolean;
	error: string | null;
}

interface Turn {
	role: string;
	utterance: string;
	references: Array<{ doc_id: string }>;
}

function main(): void {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const rows = readFileSync(
		join(root, 'data', 'derived', 'ir-pilot-v3.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as Row);
	const base = join(root, 'data', 'multidoc2dial', 'multidoc2dial');
	const dialData = (
		JSON.parse(
			readFileSync(join(base, 'multidoc2dial_dial_validation.json'), 'utf8'),
		) as {
			dial_data: Record<string, Array<{ dial_id: string; turns: Turn[] }>>;
		}
	).dial_data;
	const docData = (
		JSON.parse(readFileSync(join(base, 'multidoc2dial_doc.json'), 'utf8')) as {
			doc_data: Record<string, Record<string, { doc_text: string }>>;
		}
	).doc_data;
	const ok = rows.filter((r) => r.error === null && !r.puntLite);
	const fails: Array<{ key: string; checked: number; ungrounded: string[] }> =
		[];
	let checkedTotal = 0;
	for (const r of ok) {
		const m = r.key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
		if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) {
			throw new Error(`unparseable key ${r.key}`);
		}
		const dg = (dialData[m[1]] ?? []).find((d) => d.dial_id === m[2]);
		const ti = Number(m[3]);
		if (dg === undefined || dg.turns[ti]?.role !== 'agent') {
			throw new Error(`key does not resolve to an agent turn: ${r.key}`);
		}
		const history = dg.turns
			.slice(0, ti)
			.map((t) => `${t.role}: ${t.utterance}`);
		const turn = dg.turns[ti] as Turn;
		const docIds = [
			...new Set(turn.references.map((x) => x.doc_id).filter((d) => d)),
		];
		const docs: string[] = [];
		for (const id of docIds) {
			const text = docData[m[1]]?.[id]?.doc_text;
			if (text !== undefined) {
				docs.push(`[${id}]\n${text}`);
			}
		}
		const grounding = `Conversation so far:\n${history.join('\n')}\n\nDocument excerpts:\n${docs.join('\n\n')}`;
		if (grounding.split(/\s+/).length !== r.groundingMeta.words) {
			throw new Error(`grounding reassembly mismatch for ${r.key}`);
		}
		const v = checkEntityGrounding(
			extractEntities(r.irLite),
			extractEntities(grounding),
		);
		checkedTotal += v.checked;
		if (!v.pass) {
			fails.push({ key: r.key, checked: v.checked, ungrounded: v.ungrounded });
		}
	}
	const out = {
		generatedAt: new Date().toISOString(),
		source: 'data/derived/ir-pilot-v3.jsonl (frozen)',
		n: ok.length,
		checkedTotal,
		fails: fails.length,
		failRows: fails,
	};
	writeFileSync(
		join(root, 'data', 'derived', 'grounding-eval-v3.json'),
		`${JSON.stringify(out, null, 2)}\n`,
	);
	console.log(
		`n=${ok.length} entitiesChecked=${checkedTotal} fails=${fails.length}`,
	);
	for (const f of fails) {
		console.log(`  FAIL ${f.key} :: ${f.ungrounded.join(' ')}`);
	}
}

main();
