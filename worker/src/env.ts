// Worker bindings (mirrors wrangler.jsonc + secrets).
// NIM_API_KEY: set via `wrangler secret put` (owner step), never in files.
// SPAN_KV: unprovisioned until the owner creates the namespace; absence yields
// explicit 501s (tested), never silent behavior.
export interface Env {
	NIM_API_KEY?: string;
	GROQ_API_KEY?: string;
	CEREBRAS_API_KEY?: string;
	OPENROUTER_API_KEY?: string;
	OPENTYPHOON?: string;
	ROUTMY?: string;
	EXPERIMENTALLABS?: string;
	ANYAPI?: string;
	DREAMPROMPTING?: string;
	REGOLO?: string;
	FREEMODEL?: string;
	SPAN_KV?: KVNamespace;
}
