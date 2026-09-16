import { ChatError, type ChatRun } from "../../domain/chat.ts";
import type { ChatUserMessage } from "../../domain/chat-attachment.ts";
import type { ChatRunRuntime } from "../chat-run-runtime.ts";
import { runFailure } from "../failure-policy.ts";
import { reportFailure } from "../failure-reporter.ts";

/** Owns execution and settlement; a failed commit never changes the chosen outcome. */
export async function executeChatRun(input: {
	runtime: ChatRunRuntime;
	message: ChatUserMessage;
	update(status: ChatRun["status"], failure?: ChatRun["failure"]): void;
	cleanup: readonly (() => void | Promise<void>)[];
}): Promise<void> {
	const { runtime } = input;
	let failure: ChatRun["failure"];
	let status: ChatRun["status"] = "completed";
	try {
		try {
			input.update("running");
			await runtime.prompt(input.message);
			failure = runtime.publicFailure;
			status = failure ? "failed" : runtime.cancellationRequested ? "cancelled" : "completed";
		} catch (error) {
			failure =
				runtime.publicFailure ??
				runFailure(error, {
					stage: "agent",
					runId: runtime.run.id,
					sessionId: runtime.run.sessionId,
				});
			status = "failed";
		}
		input.update(status, failure);
	} finally {
		for (const cleanup of input.cleanup) {
			try {
				await cleanup();
			} catch (error) {
				reportFailure(error, {
					stage: "cleanup",
					runId: runtime.run.id,
					sessionId: runtime.run.sessionId,
					rootErrorId: failure?.errorId,
				});
			}
		}
	}
}

/** Session-scoped failed commits are retried on access, never by replaying the Agent. */
export class PendingRunCommits {
	readonly #pending = new Map<string, { commit(): void; error: ChatError }>();

	retain(run: ChatRun, cause: unknown, commit: () => void): ChatError {
		const error = new ChatError("chat_persistence_failed", "Run final status could not be saved", 503, { cause });
		this.#pending.set(run.sessionId, { commit, error });
		reportFailure(error, {
			stage: "run_commit",
			runId: run.id,
			sessionId: run.sessionId,
			rootErrorId: run.failure?.errorId,
		});
		return error;
	}

	reconcile(sessionId: string): void {
		const pending = this.#pending.get(sessionId);
		if (!pending) return;
		try {
			pending.commit();
		} catch {
			throw pending.error;
		}
		this.#pending.delete(sessionId);
	}
}
