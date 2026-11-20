// Per-reply expansion validator (PLAN.md Step 3 / Validation).
// Runs on the POST-SPLICE IR (deterministic code/span expansion already applied):
// span contents exist only after splicing, so validating raw IR would false-fail.
// Eight checks, all must pass: completeness, raw slot-value coverage, entity
// counted parity (numbers multiset, other classes set — missing OR extra both
// fail; extras are hallucinations), well-formedness (no stray braces),
// no-echo (model must add novel words, not parrot the draft), no-meta
// (no model meta-talk), no-role-reversal (agent must not speak as the
// customer), and no-greeting (no greeting openers or thanks/sign-off closes:
// the wrapper adds framing downstream). Non-blocking warnings (terse-mirror
// style signal) ride along for metrics without affecting the verdict. The
// deterministic template render skips the model-only checks: it is verbatim
// by design, and customer slot values may contain meta-shaped words.
// Verdicts double as ladder repair diagnoses.
// Verdicts double as ladder repair diagnoses (agents2.md Rule 2).

import { checkComplete } from './completeness.ts';
import { diffCountedEntities, extractEntities } from './entities.ts';
import { ANCHOR_PREFIX } from './expander.ts';

export interface ExpansionCheckInput {
	/** IR text after deterministic code/span splicing. */
	splicedIr: string;
	/** Slot values verbatim from tool results (reference stays raw). */
	slotValues: string[];
	output: string;
	finishReason: string | null;
	/** 'template' skips the model-only checks (no-echo, no-meta). Default 'model'. */
	source?: 'model' | 'template';
}

export interface CheckResult {
	name: string;
	pass: boolean;
	detail: string;
}

export interface ValidatorVerdict {
	pass: boolean;
	checks: CheckResult[];
	/** Non-blocking style signals (never affect pass; metrics/policy input). */
	warnings?: string[];
}

// Surface-hygiene markers, each evidenced by observed model output (runs
// 015/018/019 + identifier probe + run 034 LFM3): the {{...}} ellipsis slug,
// rule and line enumeration, rule-text parroting, prompt-header/file quotation,
// draft-mention meta-talk, and REPLY: labels. Kept tight on purpose: broader
// shapes ("here's my reply", "Reply to this email") occur in legitimate
// support prose and are deliberately NOT matched.
const META_MARKERS: Array<{ name: string; re: RegExp }> = [
	{ name: 'ellipsis-slug', re: /\{\.\.\.\}/ },
	{ name: 'rule-recitation', re: /one fact per line/i },
	{ name: 'signoff-recitation', re: /no greeting or (sign-off|filler)/i },
	{ name: 'copy-rule-recitation', re: /markers must be copied exactly/i },
	{ name: 'prompt-quotation', re: /synthetic-corpus rule/i },
	{ name: 'header-quotation', re: /pinned: \d{4}/i },
	{ name: 'enumerated-meta', re: /^(rule|line) \d+/im },
	{ name: 'draft-mention', re: /\bdraft\b/i },
	{ name: 'reply-label', re: /^reply\s*:/im },
	// Repair-hint parroting (run 036 probes: LFM3 narrates the repair instead
	// of doing it). "previous" is required: bare "validation failed" is legit
	// support prose (OTP/code retries).
	{ name: 'repair-parrot', re: /previous (attempt|validation|repair)/i },
];

function bracesBalanced(text: string): boolean {
	let depth = 0;
	let i = 0;
	while (i < text.length - 1) {
		if (text[i] === '{' && text[i + 1] === '{') {
			depth += 1;
			i += 2;
		} else if (text[i] === '}' && text[i + 1] === '}') {
			depth -= 1;
			if (depth < 0) {
				return false;
			}
			i += 2;
		} else {
			i += 1;
		}
	}
	return depth === 0;
}

function checkWellFormedness(output: string): CheckResult {
	const hits: string[] = [];
	if (!bracesBalanced(output)) {
		hits.push('unbalanced-double-braces');
	}
	return {
		name: 'well-formedness',
		pass: hits.length === 0,
		detail: hits.length === 0 ? 'ok' : `hits=${hits.join(',')}`,
	};
}

// Framing hygiene (run 041: rule-less prompts greet 4/25): the reply must not
// open with a greeting, thank in its final sentence, or close with a sign-off
// (the wrapper adds framing downstream; doubles ship otherwise). Positional by
// design: mid-text thanks ("Thank you for the details; we will proceed") is
// conversational glue and passes. No slot scoping: stripping would misalign
// positions, and greeting-shaped slot values at output edges are unobserved.
const GREETING_OPEN_RE =
	/^(hi|hello|hey|greetings|good morning|good afternoon|good evening|thank you|thanks|dear)\b/i;
const SIGNOFF_CLOSE_RES = [
	/(^|\n)\s*(best regards|sincerely|warm regards|kind regards)\b/im,
	/(^|\n)\s*(customer )?support team\s*[.!?]?\s*$/im,
];

function checkNoGreeting(output: string): CheckResult {
	const hits: string[] = [];
	const trimmed = output.trim();
	if (GREETING_OPEN_RE.test(trimmed)) {
		hits.push('greeting-open');
	}
	const sentences = trimmed
		.split(/[.!?…]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const last = sentences[sentences.length - 1] ?? '';
	if (/\bthank( you|s)\b/i.test(last)) {
		hits.push('thanks-close');
	}
	if (SIGNOFF_CLOSE_RES.some((re) => re.test(trimmed))) {
		hits.push('signoff-close');
	}
	return {
		name: 'no-greeting',
		pass: hits.length === 0,
		detail: hits.length === 0 ? 'ok' : `hits=${hits.join(',')}`,
	};
}

function checkNoMeta(output: string, slotValues: string[]): CheckResult {
	// Slot values are customer/tool text: a value containing a meta-shaped
	// word ("review the draft") must not fail the output that quotes it.
	// Strip verbatim slot occurrences before matching.
	let scoped = output;
	for (const v of slotValues) {
		if (v.length > 0) {
			scoped = scoped.split(v).join(' ');
		}
	}
	const hits: string[] = [];
	for (const m of META_MARKERS) {
		if (m.re.test(scoped)) {
			hits.push(m.name);
		}
	}
	return {
		name: 'no-meta',
		pass: hits.length === 0,
		detail: hits.length === 0 ? 'ok' : `hits=${hits.join(',')}`,
	};
}

function wordTokens(s: string): string[] {
	return s
		.toLowerCase()
		.split(/\s+/)
		.map((w) => w.replace(/^[^a-z0-9{]+|[^a-z0-9}]+$/g, ''))
		.filter((w) => w.length > 0);
}

// Echo floor (run 034 banked LFM3 rows): verbatim echoes score exactly 0.00
// novel-word ratio; the nearest faithful render (a 9-line list) scores 0.16.
// Polish-echoes (~0.09) stay servable: terse but complete and faithful, and
// the margin to faithful renders is too thin to cut safely.
const ECHO_NOVEL_FLOOR = 0.05;

// Draft-fluency gate (run 036 corpus proof over 55 drafts): telegraphic
// drafts (true echoes) score glue ≤ 0.09; already-fluent drafts (frontier
// verbatim serves, nothing to expand) score glue ≥ 0.23. The gate list is
// pinned: thresholds were measured with exactly these words.
const GLUE_WORDS = new Set(
	(
		'a,an,the,and,or,but,to,of,in,on,at,by,for,with,from,is,are,was,were,' +
		'be,been,am,it,its,as,so,we,our,you,your,they,their,he,she,his,her,' +
		'him,us,this,that,these,those,will,can,have,has,had,do,does,if,then,' +
		'than,when,which,who,whom,how,not,any,all,each,every,more,most,into,' +
		'over,under,through,during,before,after,between,my,would,should,' +
		'there,here,what'
	).split(','),
);
const FLUENT_ECHO_SKIP = 0.15;
const FLUENT_WARN_SKIP = 0.25;

function draftGlueRatio(splicedIr: string): number {
	const toks = wordTokens(splicedIr);
	if (toks.length === 0) {
		return 0;
	}
	return toks.filter((w) => GLUE_WORDS.has(w)).length / toks.length;
}

function checkNoEcho(splicedIr: string, output: string): CheckResult {
	const glue = draftGlueRatio(splicedIr);
	if (glue >= FLUENT_ECHO_SKIP) {
		return {
			name: 'no-echo',
			pass: true,
			detail: `skipped: fluent draft (glue=${glue.toFixed(2)})`,
		};
	}
	const draft = new Set(wordTokens(splicedIr));
	const out = wordTokens(output);
	if (out.length === 0) {
		return { name: 'no-echo', pass: false, detail: 'empty output' };
	}
	const novel = out.filter((w) => !draft.has(w)).length;
	const ratio = novel / out.length;
	return {
		name: 'no-echo',
		pass: ratio >= ECHO_NOVEL_FLOOR,
		detail:
			ratio >= ECHO_NOVEL_FLOOR
				? `ok novel=${novel}/${out.length}`
				: `echo suspected novel=${novel}/${out.length}`,
	};
}

// Customer-owned nouns: an agent addresses them as "your X" and never claims
// them as "my X" (run 034 bitext-22080 reversal: "share my specific
// experience"). Agent idioms ("do my best", "on my end") use other nouns.
const CUSTOMER_NOUNS = new Set([
	'experience',
	'issue',
	'issues',
	'problem',
	'problems',
	'order',
	'orders',
	'account',
	'accounts',
	'detail',
	'details',
	'request',
	'requests',
	'feedback',
	'question',
	'questions',
	'concern',
	'concerns',
	'ticket',
	'tickets',
	'case',
	'package',
	'shipment',
	'refund',
	'subscription',
	'signup',
	'sign-up',
]);

// Receiving verbs: the speaker receives help, guidance, or money, so the
// speaker is the customer ("let me help" has the reverse order and never
// matches). Zero occurrences in ~400 corpus replies (runs 037/041).
const RECEIVING_VERBS = new Set(['help', 'assist', 'refund', 'guide']);

function checkNoRoleReversal(
	splicedIr: string,
	output: string,
	slotValues: string[],
): CheckResult {
	// Scope to model-introduced voice: strip verbatim slot values and quoted
	// spans (customer quotes), then only flag my+noun absent from the draft.
	let scoped = output;
	for (const v of slotValues) {
		if (v.length > 0) {
			scoped = scoped.split(v).join(' ');
		}
	}
	scoped = scoped.replace(/"[^"]*"/g, ' ').replace(/“[^”]*”/g, ' ');
	// Single-quoted spans are the same class (draft UI labels arrive in
	// single quotes: v12 bitext-23043 'My Account'). The boundary guards
	// keep contractions (can't, I'll) and possessives intact.
	scoped = scoped.replace(/(^|[\s([{])'[^']+'(?=[\s).,;:!?}\]]|$)/g, '$1 ');
	// Novelty scope is trigram-based: a draft UI label ("Open My Account")
	// inoculates the bigram, but a novel continuation ("my account could")
	// still fails. Short tails fall back to bigrams.
	const draftTrigrams = new Set<string>();
	const draftBigrams = new Set<string>();
	const dw = wordTokens(splicedIr);
	for (let i = 0; i + 1 < dw.length; i++) {
		draftBigrams.add(`${dw[i]} ${dw[i + 1]}`);
		if (i + 2 < dw.length) {
			draftTrigrams.add(`${dw[i]} ${dw[i + 1]} ${dw[i + 2]}`);
		}
	}
	const hits: string[] = [];
	const ow = wordTokens(scoped);
	const isNovel = (at: number): boolean => {
		const key = ow.slice(at, at + 3).join(' ');
		return key.split(' ').length >= 3
			? !draftTrigrams.has(key)
			: !draftBigrams.has(key);
	};
	for (let i = 0; i + 1 < ow.length; i++) {
		// Receiving frame (help|assist|refund|guide me): the speaker receives
		// help, guidance, or money, so the speaker is the customer. Agent
		// elicitation uses other verbs (give/send/tell me are ambiguous and
		// excluded). The theoretical "help me understand" elicitation is
		// unobserved and accepted as a risk.
		if (RECEIVING_VERBS.has(ow[i] ?? '') && ow[i + 1] === 'me') {
			const span = `${ow[i]} me`;
			if (isNovel(i) && !hits.includes(span)) {
				hits.push(span);
			}
			continue;
		}
		if (ow[i] !== 'my') {
			continue;
		}
		// Direct (my issue) or one-modifier (my specific experience) claim.
		for (const j of [i + 1, i + 2]) {
			if (j < ow.length && CUSTOMER_NOUNS.has(ow[j] ?? '')) {
				const span = ow.slice(i, j + 1).join(' ');
				if (isNovel(i) && !hits.includes(span)) {
					hits.push(span);
				}
				break;
			}
		}
	}
	return {
		name: 'no-role-reversal',
		pass: hits.length === 0,
		detail: hits.length === 0 ? 'ok' : `customer-voice=[${hits.join(',')}]`,
	};
}

// Terse-mirror warning gates (run 034 banked LFM3 rows): the polish-echo
// scores runCov 0.78 + novel 0.09; the nearest faithful render (a 9-line
// list join) scores 0.65 + 0.16. Non-blocking by design: repair cannot
// de-terse LFM3 (run 036 probe parrots the hint) and the template fallback
// serves terser text, so serving with a warning beats blocking.
const TERSE_RUN_COV = 0.7;
const TERSE_NOVEL_MAX = 0.15;

function terseMirrorWarning(splicedIr: string, output: string): string | null {
	// Fluent drafts served verbatim need no regen: the warning targets
	// terse mirrors of telegraphic drafts only.
	if (draftGlueRatio(splicedIr) >= FLUENT_WARN_SKIP) {
		return null;
	}
	const draft = new Set(wordTokens(splicedIr));
	const out = wordTokens(output);
	if (out.length === 0) {
		return null;
	}
	const novel = out.filter((w) => !draft.has(w)).length / out.length;
	let best = 0;
	let cur = 0;
	for (const w of out) {
		cur = draft.has(w) ? cur + 1 : 0;
		if (cur > best) {
			best = cur;
		}
	}
	const runCov = best / out.length;
	if (runCov >= TERSE_RUN_COV && novel < TERSE_NOVEL_MAX) {
		return `terse-mirror: runCov=${runCov.toFixed(2)} novel=${novel.toFixed(2)}`;
	}
	return null;
}

export function validateExpansion(
	input: ExpansionCheckInput,
): ValidatorVerdict {
	// Strip parroted anchor lines first: struggling models echo the prompt's
	// must-include line, whose words would otherwise inflate novelty past
	// the echo floor and smuggle entities past coverage (24/100 LFM3 rows).
	const output = input.output
		.split('\n')
		.filter((l) => !l.trimStart().startsWith(ANCHOR_PREFIX))
		.join('\n')
		.trim();
	const completeness = checkComplete(output, input.finishReason);
	const missingSlots = input.slotValues.filter(
		(v) => v.length > 0 && !output.includes(v),
	);
	const diff = diffCountedEntities(
		extractEntities(input.splicedIr),
		extractEntities(output),
	);
	const entityOk = diff.missing.length === 0 && diff.extra.length === 0;
	const isTemplate = input.source === 'template';
	const skipped = (
		name: 'no-echo' | 'no-meta' | 'no-role-reversal' | 'no-greeting',
	): CheckResult => ({
		name,
		pass: true,
		detail: 'skipped for template render',
	});
	const checks: CheckResult[] = [
		{
			name: 'completeness',
			pass: completeness.complete,
			detail: completeness.reasons.join('; ') || 'ok',
		},
		{
			name: 'slot-coverage',
			pass: missingSlots.length === 0,
			detail:
				missingSlots.length === 0
					? 'ok'
					: `missing slots: ${missingSlots.join(' | ')}`,
		},
		{
			name: 'entity-parity',
			pass: entityOk,
			detail: entityOk
				? 'ok'
				: `missing=[${diff.missing.join(',')}]+extra=[${diff.extra.join(',')}]`,
		},
		checkWellFormedness(output),
		isTemplate ? skipped('no-echo') : checkNoEcho(input.splicedIr, output),
		isTemplate ? skipped('no-meta') : checkNoMeta(output, input.slotValues),
		isTemplate
			? skipped('no-role-reversal')
			: checkNoRoleReversal(input.splicedIr, output, input.slotValues),
		isTemplate ? skipped('no-greeting') : checkNoGreeting(output),
	];
	const warnings: string[] = [];
	if (!isTemplate) {
		const terse = terseMirrorWarning(input.splicedIr, output);
		if (terse !== null) {
			warnings.push(terse);
		}
	}
	return { pass: checks.every((c) => c.pass), checks, warnings };
}
