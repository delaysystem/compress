// Truncation detection (PLAN.md Layer 0: validate completeness; never ship
// cut-off text). The finish reason is authoritative; text heuristics only add
// evidence, they never override a clean STOP.

export interface CompletenessVerdict {
	complete: boolean;
	reasons: string[];
}

/** Finish reasons that authoritatively mean generation was cut off. Gemini canonical; OpenAI tolerated. */
const TRUNCATED_REASONS = new Set(['MAX_TOKENS', 'length']);

export function checkComplete(
	text: string,
	finishReason: string | null,
): CompletenessVerdict {
	const reasons: string[] = [];
	if (finishReason !== null && TRUNCATED_REASONS.has(finishReason)) {
		reasons.push(`truncated by model: finishReason=${finishReason}`);
	}
	if (text.trim().length === 0) {
		reasons.push('empty text');
	}
	const fences = (text.match(/```/g) ?? []).length;
	if (fences % 2 === 1) {
		reasons.push('unbalanced code fence');
	}
	return { complete: reasons.length === 0, reasons };
}
