import { describe, expect, it } from "vitest";
import { SessionCommandScheduler } from "../src/application/services/session-command-scheduler.ts";

const clock = { now: () => Date.now() };

describe("SessionCommandScheduler", () => {
	it("serializes one Session while allowing another Session to run", async () => {
		const scheduler = new SessionCommandScheduler<string>({ clock, maxConcurrentOperations: 2 });
		const firstRelease = deferred();
		const started: string[] = [];
		const first = scheduler.schedule({
			sessionId: "session-a",
			deadlineAt: Date.now() + 1_000,
			execute: async () => {
				started.push("a1");
				await firstRelease.promise;
				return "a1";
			},
		});
		await waitFor(() => started.length === 1);
		const second = scheduler.schedule({
			sessionId: "session-a",
			deadlineAt: Date.now() + 1_000,
			execute: async () => {
				started.push("a2");
				return "a2";
			},
		});
		const other = scheduler.schedule({
			sessionId: "session-b",
			deadlineAt: Date.now() + 1_000,
			execute: async () => {
				started.push("b1");
				return "b1";
			},
		});
		await waitFor(() => started.includes("b1"));
		expect(started).toEqual(["a1", "b1"]);
		firstRelease.resolve();
		await expect(Promise.all([first, second, other])).resolves.toEqual([
			{ kind: "executed", result: "a1" },
			{ kind: "executed", result: "a2" },
			{ kind: "executed", result: "b1" },
		]);
		expect(started).toEqual(["a1", "b1", "a2"]);
	});

	it("enforces the process limit and grants waiting Session heads in FIFO order", async () => {
		const scheduler = new SessionCommandScheduler<string>({ clock, maxConcurrentOperations: 2 });
		const releases = new Map<string, Deferred>();
		const started: string[] = [];
		const schedule = (sessionId: string) =>
			scheduler.schedule({
				sessionId,
				deadlineAt: Date.now() + 1_000,
				execute: async () => {
					started.push(sessionId);
					const release = deferred();
					releases.set(sessionId, release);
					await release.promise;
					return sessionId;
				},
			});
		const first = schedule("session-a");
		const second = schedule("session-b");
		const third = schedule("session-c");
		const fourth = schedule("session-d");
		await waitFor(() => started.length === 2);
		expect(started).toEqual(["session-a", "session-b"]);
		releases.get("session-a")?.resolve();
		await waitFor(() => started.length === 3);
		expect(started[2]).toBe("session-c");
		releases.get("session-b")?.resolve();
		await waitFor(() => started.length === 4);
		expect(started[3]).toBe("session-d");
		releases.get("session-c")?.resolve();
		releases.get("session-d")?.resolve();
		await Promise.all([first, second, third, fourth]);
	});

	it("actively expires a command waiting behind the same Session", async () => {
		const scheduler = new SessionCommandScheduler<string>({ clock, maxConcurrentOperations: 2 });
		const firstRelease = deferred();
		let secondExecuted = false;
		const first = scheduler.schedule({
			sessionId: "session-a",
			deadlineAt: Date.now() + 1_000,
			execute: async () => {
				await firstRelease.promise;
				return "first";
			},
		});
		const second = scheduler.schedule({
			sessionId: "session-a",
			deadlineAt: Date.now() + 20,
			execute: async () => {
				secondExecuted = true;
				return "second";
			},
		});
		await expect(second).resolves.toEqual({ kind: "queue_timeout" });
		expect(secondExecuted).toBe(false);
		firstRelease.resolve();
		await first;
		expect(secondExecuted).toBe(false);
	});

	it("cancels a command while it waits for a process permit", async () => {
		const scheduler = new SessionCommandScheduler<string>({ clock, maxConcurrentOperations: 1 });
		const firstRelease = deferred();
		const controller = new AbortController();
		let secondExecuted = false;
		const first = scheduler.schedule({
			sessionId: "session-a",
			deadlineAt: Date.now() + 1_000,
			execute: async () => {
				await firstRelease.promise;
				return "first";
			},
		});
		const second = scheduler.schedule({
			sessionId: "session-b",
			deadlineAt: Date.now() + 1_000,
			signal: controller.signal,
			execute: async () => {
				secondExecuted = true;
				return "second";
			},
		});
		controller.abort();
		await expect(second).resolves.toEqual({ kind: "cancelled_before_dispatch" });
		expect(secondExecuted).toBe(false);
		firstRelease.resolve();
		await first;
	});

	it("releases the permit and continues the Session after execution rejects", async () => {
		const scheduler = new SessionCommandScheduler<string>({ clock, maxConcurrentOperations: 1 });
		const started: string[] = [];
		const first = scheduler.schedule({
			sessionId: "session-a",
			deadlineAt: Date.now() + 1_000,
			execute: async () => {
				started.push("first");
				throw new Error("execution failed");
			},
		});
		const second = scheduler.schedule({
			sessionId: "session-a",
			deadlineAt: Date.now() + 1_000,
			execute: async () => {
				started.push("second");
				return "second";
			},
		});
		await expect(first).rejects.toThrow("execution failed");
		await expect(second).resolves.toEqual({ kind: "executed", result: "second" });
		expect(started).toEqual(["first", "second"]);
	});

	it("rejects an invalid process concurrency limit", () => {
		expect(() => new SessionCommandScheduler({ clock, maxConcurrentOperations: 0 })).toThrow(
			"maxConcurrentOperations must be a positive safe integer",
		);
	});
});

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolvePromise: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Condition was not reached");
}
