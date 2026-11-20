// Deterministic politeness wrapper (PLAN.md Layer 0b-a). The greeting and
// sign-off copy arrives as config arguments (product strings live outside
// code); this module only joins and strips. stripWrapper removes at most one
// layer and never touches the core.

export interface WrapperCopy {
	greeting: string;
	signoff: string;
}

export function wrapReply(core: string, copy: WrapperCopy): string {
	const parts = [copy.greeting.trim(), core.trim(), copy.signoff.trim()].filter(
		(p) => p.length > 0,
	);
	return parts.join('\n\n');
}

export function stripWrapper(text: string, copy: WrapperCopy): string {
	let out = text;
	const greeting = copy.greeting.trim();
	const signoff = copy.signoff.trim();
	if (greeting.length > 0 && out.startsWith(greeting)) {
		out = out.slice(greeting.length);
	}
	const trimmed = out.trimEnd();
	if (signoff.length > 0 && trimmed.endsWith(signoff)) {
		out = trimmed.slice(0, -signoff.length);
	}
	return out.trim();
}
