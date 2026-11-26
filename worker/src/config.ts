// Pinned plan values (agents2.md Rule 1: single config source, origin cited).
// Every number below comes from the PLAN.md section named in its comment.
// Implementation code imports these; it never re-literals them.

/** PLAN.md Approach/Phase 2: replies at/below this token length skip expansion. Unevidenced threshold. */
export const SKIP_EXPANSION_TOKENS = 40;
/** PLAN.md Step 5: model-emitted IR p50 ratio gate. */
export const IR_RATIO_GATE_P50 = 1.8;
/** PLAN.md Success Criteria: shadow turns behind the zero-observed tool-mismatch bound. */
export const SHADOW_TURNS_MIN = 10_000;
/** PLAN.md Success Criteria: upper 95% bound paired with zero observed (rule of three). */
export const TOOL_MISMATCH_UPPER95 = 0.0003;
/** PLAN.md Step 4: shadow entity-fail ceiling. */
export const ENTITY_FAIL_SHADOW_MAX = 0.001;
/** PLAN.md Step 4: shadow semantic-pass floor. */
export const SEMANTIC_PASS_SHADOW_MIN = 0.99;
/** PLAN.md Step 4: canary kill thresholds. */
export const CANARY_CSAT_SIGMA = 1;
export const CANARY_REPROMPT_PP = 0.005;
export const CANARY_P99_RISE = 0.1;
/** PLAN.md Step 3: golden-set floor. */
export const GOLDEN_TURNS_MIN = 1000;
/** PLAN.md Validation: human pairs per gate. */
export const HUMAN_PAIRS_MIN = 300;
/** PLAN.md Step 1: dictionary minimum support. */
export const DICT_MIN_SUPPORT = 50;
/** PLAN.md Success Criteria: precision-sample size for ±0.3% at 95%. */
export const PRECISION_SAMPLE_N = 2000;
/** PLAN.md Step 5: IR pilot floor. */
export const IR_PILOT_TURNS_MIN = 200;
/** PLAN.md Layer 0: cap-trigger rewrite gate. */
export const CAP_TRIGGER_MAX = 0.05;
/** Owner .dev.vars contract 2026-11-11: key name for Gemini AI Studio. Name only, never the value. */
export const GEMINI_API_KEY_NAME = 'GOOGLE_API_KEY';
/** Public stable Gemini API endpoint (identical in all environments). Origin: Google AI Studio docs; override per-call for tests/staging. */
export const GEMINI_BASE_URL =
	'https://generativelanguage.googleapis.com/v1beta';
/** Owner .dev.vars contract 2026-11-11 (run 020 provider switch): key name for NVIDIA NIM. Name only, never the value. */
export const NIM_API_KEY_NAME = 'NIM_API_KEY';
/** Public NVIDIA NIM OpenAI-compatible endpoint. Origin: NVIDIA integrate API docs; override per-call for tests/staging. */
export const NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
/** Owner .dev.vars contract: key name for Groq Cloud. Name only, never the value. */
export const GROQ_API_KEY_NAME = 'GROQ_API_KEY';
/** Public Groq OpenAI-compatible endpoint. Origin: GroqCloud API docs; override per-call for tests/staging. */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
/** Owner .dev.vars contract: key name for Cerebras. Name only, never the value. */
export const CEREBRAS_API_KEY_NAME = 'CEREBRAS_API_KEY';
/** Public Cerebras OpenAI-compatible endpoint. Origin: Cerebras API docs; override per-call for tests/staging. */
export const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
/** Owner .dev.vars contract: key name for OpenRouter. Name only, never the value. */
export const OPENROUTER_API_KEY_NAME = 'OPENROUTER_API_KEY';
/** Public OpenRouter OpenAI-compatible endpoint. Origin: OpenRouter API docs; override per-call for tests/staging. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** Owner .dev.vars contract 2026-11-25: key names & OpenAI-compatible endpoints for the 7 additional providers. */
export const OPENTYPHOON_API_KEY_NAME = 'OPENTYPHOON';
export const OPENTYPHOON_BASE_URL = 'https://api.opentyphoon.ai/v1';
export const ROUTMY_API_KEY_NAME = 'ROUTMY';
export const ROUTMY_BASE_URL = 'https://api.rout.my/v1';
export const EXPERIMENTALLABS_API_KEY_NAME = 'EXPERIMENTALLABS';
export const EXPERIMENTALLABS_BASE_URL = 'https://api.experientiallabs.ai/v1';
export const ANYAPI_API_KEY_NAME = 'ANYAPI';
export const ANYAPI_BASE_URL = 'https://api.anyapi.ai/v1';
export const DREAMPROMPTING_API_KEY_NAME = 'DREAMPROMPTING';
export const DREAMPROMPTING_BASE_URL = 'https://dreamprompting.com/api/v1';
export const REGOLO_API_KEY_NAME = 'REGOLO';
export const REGOLO_BASE_URL = 'https://api.regolo.ai/v1';
export const FREEMODEL_API_KEY_NAME = 'FREEMODEL';
export const FREEMODEL_BASE_URL = 'https://api.freemodel.dev/v1';
/** Owner contract 2026-11-12: lossless mode allows this many words different
 * from the flagship's native system-less output (word-level Levenshtein). */
export const LOSSLESS_WORD_BUDGET = 3;
/** PLAN.md fallback ladder: repair attempts before template render. SLM
 * calls are unbounded by policy; this caps per-message latency instead. */
export const REPAIR_ATTEMPTS = 1;
/** Latency experiment 2026-11-21/22: collapsing the four expansion rules
 * into one line cuts prefill ~142->~50 tokens. Measured expander p50 7.6s
 * baseline -> 6.0s compact (~1.27x pooled, ~1.5x bracketed); paired quality
 * eval passed (see run-reports/034-latency-methods.md). Default is compact;
 * set to 'full' to restore the verbose rules. */
export const EXPANSION_PROMPT_MODE: 'full' | 'compact' = 'compact';
