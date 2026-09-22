import { describe, expect, it, vi } from "vitest";
import { normalizePublicError, runFailure } from "../src/application/failure-policy.ts";
import { failureIdentity, linkFailureIdentity, reportFailure } from "../src/application/failure-reporter.ts";
import { ChatError } from "../src/domain/chat.ts";
import { FileTransferError } from "../src/domain/file-transfer.ts";
import { SshAgentError } from "../src/domain/ssh-failure.ts";
import { localizePublicValue } from "../src/i18n/projection.ts";
import { formatBackendMessage } from "../src/i18n/message.ts";

describe("shared failure policy", () => {
	it("preserves transfer queue saturation status and localizes the public message", () => {
		const failure = normalizePublicError(new FileTransferError("transfer_queue_full", "queue full", 429));
		expect(failure).toMatchObject({ code: "transfer_queue_full", status: 429 });
		expect(formatBackendMessage("zh-CN", failure.message)).toBe("文件传输等待队列已满，请稍后重试。");
		expect(formatBackendMessage("en-US", failure.message)).toBe("File transfer queue is full. Try again later.");
	});
	it("keeps known SSH failures and the same identity across Run and HTTP", () => {
		const error = new SshAgentError({
			code: "connection_timeout",
			category: "connection",
			phase: "connect",
			message: "timeout",
			retryable: true,
		});
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const run = runFailure(error, { stage: "agent", runId: "run" });
			const http = normalizePublicError(error);
			expect(run.code).toBe(http.code);
			expect(run.retryable).toBe(http.retryable);
			expect(reportFailure(error, { stage: "http" }).errorId).toBe(run.errorId);
			expect(log).toHaveBeenCalledTimes(1);
		} finally {
			log.mockRestore();
		}
	});
	it("logs linked wrappers once, with redacted bounded causes", () => {
		const cause = new Error('Authorization: Bearer credential\npassword="private value"');
		const error = new ChatError("chat_persistence_failed", "write failed", 503, { cause });
		const wrapper = new Error("wrapper", { cause: error });
		linkFailureIdentity(wrapper, error);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			reportFailure(error, { stage: "run_commit" });
			reportFailure(wrapper, { stage: "http" });
			expect(failureIdentity(wrapper).errorId).toBe(failureIdentity(error).errorId);
			expect(log).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(log.mock.calls)).not.toMatch(/credential|private value/);
			expect(JSON.stringify(log.mock.calls)).toContain("write failed");
		} finally {
			log.mockRestore();
		}
	});
	it("whitelists the public failure snapshot and localizes recovery", () => {
		const projected = localizePublicValue(
			{
				failure: {
					schemaVersion: 1,
					errorId: "root",
					stage: "provider_request",
					code: "chat_context_overflow",
					message: "root",
					messageKey: "chat.context_overflow",
					retryable: false,
					cause: { password: "private" },
					diagnostics: "private",
					recovery: {
						errorId: "recovery",
						code: "chat_context_no_compactable_history",
						message: "no history",
						messageKey: "chat.context_no_compactable_history",
					},
				},
			},
			"zh-CN",
		);
		expect(projected).toMatchObject({
			failure: { errorId: "root", message: "上下文过大", recovery: { errorId: "recovery" } },
		});
		expect(JSON.stringify(projected)).not.toMatch(/private|messageKey|no history/);
	});
});
