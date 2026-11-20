// Tier-1 grounding screen (run 012 precondition): every DISTINCT entity the
// IR claims must appear in the grounding (history + retrieved docs).
// Catches fabrication (v3 evidence: phone numbers absent from grounding);
// repetition is emphasis, not fabrication, so SET semantics. Paraphrase-away
// (entity in neither IR nor grounding) is invisible here by design: this
// screen catches INVENTION, omission is the recall metric's job. Tier-2
// (sampled LLM entailment per line) covers non-entity claims separately.

import type { Entity } from './entities.ts';

export interface GroundingVerdict {
	pass: boolean;
	checked: number;
	ungrounded: string[];
}

function key(e: Entity): string {
	return `${e.class}:${e.canonical}`;
}

export function checkEntityGrounding(
	ir: Entity[],
	ground: Entity[],
): GroundingVerdict {
	const groundKeys = new Set(ground.map(key));
	const irKeys = [...new Set(ir.map(key))];
	const ungrounded = irKeys.filter((k) => !groundKeys.has(k));
	return {
		pass: ungrounded.length === 0,
		checked: irKeys.length,
		ungrounded,
	};
}
