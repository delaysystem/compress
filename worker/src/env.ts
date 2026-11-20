// Worker bindings (mirrors wrangler.jsonc + secrets).
// NIM_API_KEY: set via `wrangler secret put` (owner step), never in files.
// SPAN_KV: unprovisioned until the owner creates the namespace; absence yields
// explicit 501s (tested), never silent behavior.
export interface Env {
	NIM_API_KEY?: string;
	SPAN_KV?: KVNamespace;
}
