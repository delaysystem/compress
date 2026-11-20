// Prompt assembly (run 037+): separate pure assembly so the cache-prefix
// invariant is unit-testable. Layout: static head (rules + book) first,
// dynamic reference last; byte-identical heads across rows cache.
export function buildEmitPrompt(head: string, reference: string): string {
	return `${head}\n---\n\nREPLY TO COMPRESS:\n${reference}\n\nIR:`;
}
