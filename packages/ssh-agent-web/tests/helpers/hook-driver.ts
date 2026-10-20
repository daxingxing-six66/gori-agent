/** Deterministic hook lifecycle driver for tests without a browser or a third-party renderer. */
export class HookDriver {
	private readonly values: unknown[] = [];
	private readonly refs: { current: unknown }[] = [];
	private readonly memos: { value: unknown; deps?: readonly unknown[] }[] = [];
	private readonly effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
	private pending: (() => void)[] = [];
	private indexes = { state: 0, ref: 0, memo: 0, effect: 0 };
	state<T>(initial: T | (() => T)): [T, (value: T | ((current: T) => T)) => void] {
		const index = this.indexes.state++;
		if (!(index in this.values)) this.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
		return [this.values[index] as T, (value) => { this.values[index] = typeof value === "function" ? (value as (current: T) => T)(this.values[index] as T) : value; }];
	}
	ref<T>(initial: T): { current: T } { const index = this.indexes.ref++; this.refs[index] ??= { current: initial }; return this.refs[index] as { current: T }; }
	memo<T>(factory: () => T, deps?: readonly unknown[]): T {
		const index = this.indexes.memo++;
		if (!equal(this.memos[index]?.deps, deps)) this.memos[index] = { value: factory(), deps };
		return this.memos[index]!.value as T;
	}
	effect(effect: () => void | (() => void), deps?: readonly unknown[]): void {
		const index = this.indexes.effect++;
		if (equal(this.effects[index]?.deps, deps)) return;
		const previous = this.effects[index];
		this.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); this.effects[index] = { deps, ...(typeof cleanup === "function" ? { cleanup } : {}) }; });
	}
	render<T>(render: () => T): T {
		this.indexes = { state: 0, ref: 0, memo: 0, effect: 0 };
		const result = render(); const effects = this.pending; this.pending = []; for (const effect of effects) effect(); return result;
	}
	unmount(): void { for (const effect of this.effects) effect.cleanup?.(); }
}
function equal(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
	return !!left && !!right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}
export function deferred<T>() {
	let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
