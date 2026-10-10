import { ManagementError } from "../../domain/errors.ts";
import type { RemoteSandboxMode } from "../../domain/remote-sandbox.ts";
import type { Session } from "../../domain/session.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";

/** The Session's trusted setting, never a model-supplied permission flag. */
export function sessionSandboxMode(session: Pick<Session, "sandboxEnabled">): RemoteSandboxMode {
	return session.sandboxEnabled === false ? "full_access" : "workspace_write";
}

/** Current trusted configuration overrides sandbox guidance in the immutable session prompt. */
export function sessionSandboxInstructions(mode: RemoteSandboxMode): string {
	const instruction = mode === "full_access"
		? "The user has disabled remote sandboxing for this Session. Remote commands and Terminal use ordinary SSH execution without filesystem confinement. Do not probe or install a sandbox, or request a one-call Full Access exception, merely to execute commands."
		: "Remote sandboxing is enabled for this Session. Default remote commands and Terminal must use filesystem confinement. A command that requires a sandbox exception needs explicit one-call Full Access approval.";
	return `<session-sandbox>\nCurrent Session execution policy takes precedence over earlier sandbox instructions. ${instruction} Guard rules, ordinary command approval and SSH account permissions still apply. Local tools and SFTP retain their existing policies.\n</session-sandbox>`;
}

export class SessionSandboxPolicy {
	readonly #sessions: Pick<SessionRepository, "findById">;

	constructor(sessions: Pick<SessionRepository, "findById">) {
		this.#sessions = sessions;
	}

	async mode(sessionId: string): Promise<RemoteSandboxMode> {
		const session = await this.#sessions.findById(sessionId);
		if (!session) throw new ManagementError("not_found", `Session not found: ${sessionId}`);
		return sessionSandboxMode(session);
	}
}
