import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEventPublisher } from "../src/application/chat-run-event-hub.ts";
import type { ChatRepository } from "../src/application/repositories/chat-repository.ts";
import { ChatApprovalService } from "../src/application/services/chat-approval-service.ts";
import type { ToolApproval } from "../src/domain/chat.ts";

type ApprovalRepository = Pick<
	ChatRepository,
	"insertApproval" | "findApproval" | "listApprovals" | "resolveApproval" | "rejectPendingApproval"
>;

function createContext(approvalTimeoutMs = 300_000) {
	const approvals = new Map<string, ToolApproval>();
	const repository = {
		insertApproval: vi.fn((approval: ToolApproval) => approvals.set(approval.id, { ...approval })),
		findApproval: vi.fn((sessionId: string, approvalId: string) => {
			const approval = approvals.get(approvalId);
			return approval?.sessionId === sessionId ? { ...approval } : undefined;
		}),
		listApprovals: vi.fn((sessionId: string, status: string) =>
			[...approvals.values()].filter((approval) => approval.sessionId === sessionId && approval.status === status),
		),
		resolveApproval: vi.fn((approvalId: string, approved: boolean, resolvedAt: number) => {
			const current = approvals.get(approvalId);
			if (!current) throw new Error("Approval not found");
			const resolved: ToolApproval = {
				...current,
				status: approved ? "approved" : "rejected",
				source: "user",
				...(approved ? {} : { rejectionReason: "user_rejected" as const }),
				resolvedAt,
			};
			approvals.set(approvalId, resolved);
			return { ...resolved };
		}),
		rejectPendingApproval: vi.fn(
			(approvalId: string, reason: NonNullable<ToolApproval["rejectionReason"]>, resolvedAt: number) => {
				const current = approvals.get(approvalId);
				if (!current || current.status !== "pending") return undefined;
				const rejected: ToolApproval = {
					...current,
					status: "rejected",
					rejectionReason: reason,
					resolvedAt,
				};
				approvals.set(approvalId, rejected);
				return { ...rejected };
			},
		),
	} satisfies ApprovalRepository;
	const events = { publish: vi.fn() } satisfies ChatEventPublisher;
	let sequence = 0;
	let now = 100;
	const service = new ChatApprovalService({
		repository,
		ids: { next: () => `approval-${++sequence}` },
		events,
		approvalTimeoutMs,
		clock: () => ++now,
	});
	return { service, repository, events, approvals };
}

function request(autoApprove = false, runId = "run-1") {
	return {
		run: { id: runId, sessionId: "session-1" },
		assistantMessageId: "assistant-1",
		toolCallId: "tool-1",
		toolName: "bash",
		description: "Execute bash",
		autoApprove,
	};
}

afterEach(() => vi.useRealTimers());

describe("ChatApprovalService", () => {
	it.each(["timeout", "abort", "resolve"] as const)("rejects the waiter when %s persistence fails", async (mode) => {
		vi.useFakeTimers();
		const context = createContext(25);
		const controller = new AbortController();
		const original = new Error("database unavailable");
		context.repository.rejectPendingApproval.mockImplementation(() => {
			throw original;
		});
		context.repository.resolveApproval.mockImplementation(() => {
			throw original;
		});
		const decision = context.service.request(request(), controller.signal);
		const rejected = expect(decision).rejects.toMatchObject({
			code: "chat_approval_persistence_failed",
			cause: original,
		});
		if (mode === "timeout") await vi.advanceTimersByTimeAsync(25);
		else if (mode === "abort") controller.abort();
		else
			expect(() => context.service.resolve("session-1", "approval-1", true)).toThrow(
				"Could not persist approval decision",
			);
		await rejected;
		const calls = context.repository.rejectPendingApproval.mock.calls.length;
		context.service.close();
		await vi.advanceTimersByTimeAsync(100);
		controller.abort();
		expect(context.repository.rejectPendingApproval).toHaveBeenCalledTimes(calls);
		expect(context.approvals.get("approval-1")?.status).toBe("pending");
	});
	it("persists and publishes an automatic Approval without creating a waiter", async () => {
		const context = createContext();

		await expect(context.service.request(request(true))).resolves.toEqual({ approved: true, source: "auto" });
		expect(context.approvals.get("approval-1")).toMatchObject({
			status: "approved",
			source: "auto",
		});
		expect(context.events.publish).toHaveBeenCalledWith(
			"run-1",
			"approval.resolved",
			expect.objectContaining({ id: "approval-1", status: "approved" }),
		);
	});

	it("resolves a manual Approval and preserves idempotent decision semantics", async () => {
		const context = createContext();
		const controller = new AbortController();
		const decision = context.service.request(request(), controller.signal);

		expect(context.service.resolve("session-1", "approval-1", true)).toMatchObject({
			status: "approved",
			source: "user",
		});
		await expect(decision).resolves.toEqual({ approved: true, source: "user" });
		expect(context.service.resolve("session-1", "approval-1", true)).toMatchObject({ status: "approved" });
		expect(() => context.service.resolve("session-1", "approval-1", false)).toThrow(
			"Tool Approval was already resolved",
		);

		const publishCount = context.events.publish.mock.calls.length;
		controller.abort();
		expect(context.events.publish).toHaveBeenCalledTimes(publishCount);
	});

	it("rejects and persists a manual Approval after timeout", async () => {
		vi.useFakeTimers();
		const context = createContext(25);
		const decision = context.service.request(request());

		await vi.advanceTimersByTimeAsync(25);

		await expect(decision).resolves.toEqual({ approved: false, reason: "timeout" });
		expect(context.approvals.get("approval-1")).toMatchObject({
			status: "rejected",
			rejectionReason: "timeout",
		});
	});

	it("handles an already-aborted signal and Run cancellation through the same cleanup path", async () => {
		const context = createContext();
		const controller = new AbortController();
		controller.abort();
		const aborted = context.service.request(request(false, "run-aborted"), controller.signal);
		const cancelled = context.service.request(request(false, "run-cancelled"));

		context.service.cancelRun("run-cancelled", "server_restarted");

		await expect(aborted).resolves.toEqual({ approved: false, reason: "run_cancelled" });
		await expect(cancelled).resolves.toEqual({ approved: false, reason: "server_restarted" });
		expect(context.approvals.get("approval-1")?.rejectionReason).toBe("run_cancelled");
		expect(context.approvals.get("approval-2")?.rejectionReason).toBe("server_restarted");
	});

	it("closes all pending waiters and delegates persisted Approval queries", async () => {
		const context = createContext();
		const first = context.service.request(request(false, "run-1"));
		const second = context.service.request(request(false, "run-2"));

		expect(context.service.list("session-1")).toHaveLength(2);
		context.service.close();

		await expect(first).resolves.toEqual({ approved: false, reason: "run_cancelled" });
		await expect(second).resolves.toEqual({ approved: false, reason: "run_cancelled" });
		expect(context.service.list("session-1")).toHaveLength(0);
	});
});
