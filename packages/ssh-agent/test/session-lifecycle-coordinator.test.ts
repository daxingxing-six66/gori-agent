import { describe, expect, it } from "vitest";
import { SessionLifecycleCoordinator } from "../src/application/services/session-lifecycle-coordinator.ts";

describe("SessionLifecycleCoordinator", () => {
	it("blocks new uses while a deletion barrier is held and preserves existing usage", async () => {
		const coordinator = new SessionLifecycleCoordinator();
		const run = coordinator.acquireUse("session-1", "chat_run");
		const barrier = await coordinator.acquireDeletionBarrier("session-1");

		expect(coordinator.getUsage("session-1")).toMatchObject({
			deleting: true,
			total: 1,
			byKind: { chat_run: 1 },
		});
		expect(() => coordinator.acquireUse("session-1", "terminal_open")).toThrowError(
			expect.objectContaining({ code: "session_deletion_in_progress" }),
		);

		run.release();
		barrier.release();
		expect(coordinator.getUsage("session-1")).toMatchObject({ deleting: false, total: 0 });
	});

	it("serializes deletion barriers and makes lease release idempotent", async () => {
		const coordinator = new SessionLifecycleCoordinator();
		const first = await coordinator.acquireDeletionBarrier("session-1");
		let secondAcquired = false;
		const secondPromise = coordinator.acquireDeletionBarrier("session-1").then((barrier) => {
			secondAcquired = true;
			return barrier;
		});

		await Promise.resolve();
		expect(secondAcquired).toBe(false);
		first.release();
		first.release();
		const second = await secondPromise;
		expect(coordinator.getUsage("session-1").deleting).toBe(true);
		second.release();
	});
});
