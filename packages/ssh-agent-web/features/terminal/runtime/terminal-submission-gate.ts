interface TerminalSubmissionParticipant {
	prepare(): Promise<void>;
	resume(): void;
}

/** The Session assembly injects this boundary into Chat; the tab container knows nothing about it. */
const participants = new Map<string, Set<TerminalSubmissionParticipant>>();

export function registerTerminalSubmission(sessionId: string, participant: TerminalSubmissionParticipant): () => void {
	const session = participants.get(sessionId) ?? new Set<TerminalSubmissionParticipant>();
	session.add(participant); participants.set(sessionId, session);
	return () => { session.delete(participant); if (session.size === 0) participants.delete(sessionId); };
}

export async function withTerminalSubmission<T>(sessionId: string, start: () => Promise<T>): Promise<T> {
	const current = [...participants.get(sessionId) ?? []];
	try {
		await Promise.all(current.map(participant => participant.prepare()));
		return await start();
	} finally { for (const participant of current) participant.resume(); }
}
