// Cooperative global pacer (extracted after the IR pilot's 429 failures).
// Callers await wait() before starting a metered call; the first call passes
// immediately. Single-threaded check-then-set is approximate under concurrency,
// which is fine: the retry backstop absorbs residual bursts. Clock and sleep
// injectable for deterministic tests; production uses real time.
// Erasable syntax only here (no parameter properties): node --strip-types
// runners import this file and reject non-erasable TypeScript.

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

export class Pacer {
	private lastStart = Number.NEGATIVE_INFINITY;
	private readonly minIntervalMs: number;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(
		minIntervalMs: number,
		now?: () => number,
		sleep?: (ms: number) => Promise<void>,
	) {
		this.minIntervalMs = minIntervalMs;
		this.now = now ?? Date.now;
		this.sleep = sleep ?? defaultSleep;
	}

	async wait(): Promise<void> {
		const waitMs = this.lastStart + this.minIntervalMs - this.now();
		if (waitMs > 0) {
			await this.sleep(waitMs);
		}
		this.lastStart = this.now();
	}
}
