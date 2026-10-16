import type { DeploymentOutcome, DeploymentSession } from "../../domain/deployment-session.ts";
import type { ChatMessageProjection } from "../../domain/chat.ts";

export interface DeploymentSessionRepository {
	find(sessionId: string, id: string): DeploymentSession | undefined;
	active(sessionId: string): DeploymentSession | undefined;
	historyMessage(sessionId: string, id: string): ChatMessageProjection | undefined;
	/** Called in the same transaction that creates the Discussion. */
	insert(deployment: DeploymentSession): void;
	/** Compare-and-set terminal state; the first committed outcome wins. */
	finish(sessionId: string, id: string, outcome: DeploymentOutcome, reason: string | undefined, now: number): boolean;
	/** Never resumes commands or restores process-local grants. */
	recoverInterrupted(now: number): void;
}
