import { ManagementError } from "../../domain/errors.ts";
import type { RemoteSandboxMode } from "../../domain/remote-sandbox.ts";
import type { Session } from "../../domain/session.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";

/** The Session's trusted setting, never a model-supplied permission flag. */
export function sessionSandboxMode(session: Pick<Session, "sandboxEnabled" | "sandboxReadOnly">): RemoteSandboxMode {
	return session.sandboxReadOnly !== true && session.sandboxEnabled === false ? "full_access" : "workspace_write";
}

/** Keep the configured workspace roots intact when temporarily selecting read-only mode. */
export function sessionSandboxRoots(session: Pick<Session, "sandboxWritableRoots" | "sandboxReadOnly">): string[] {
	return session.sandboxReadOnly === true ? ["/tmp"] : [...(session.sandboxWritableRoots ?? [])];
}

/** Current trusted configuration overrides sandbox guidance in the immutable session prompt. */
export function sessionSandboxInstructions(mode: RemoteSandboxMode, roots?: readonly string[], readOnly = false): string {
	const instruction = readOnly
		? "Read-only remote sandboxing is enabled for this Session. Read logs and other files using SSH account permissions. Remote commands and Terminal may write only within /tmp and to /dev/null. Full Access exceptions, SFTP uploads, sandbox installation and deployment execution are forbidden. If confinement is unavailable, stop; do not bypass it. Network, IPC, process signals and metadata operations are not restricted by this filesystem policy."
		: mode === "full_access"
		? "The user has disabled remote sandboxing for this Session. Remote commands and Terminal use ordinary SSH execution without filesystem confinement. Do not probe or install a sandbox, or request a one-call Full Access exception, merely to execute commands."
		: "Remote sandboxing is enabled for this Session. Default remote commands and Terminal must use filesystem confinement. A command that requires a sandbox exception needs explicit one-call Full Access approval.";
	const scope = !readOnly && mode === "workspace_write" && roots !== undefined
		? ` Session writable directories: ${JSON.stringify(roots)}. These directories and their descendants, /tmp and /dev/null form the writable scope; changing command cwd does not enlarge it.` : "";
	return `<session-sandbox>\nCurrent Session execution policy takes precedence over earlier sandbox instructions. ${instruction}${scope} Guard rules, ordinary command approval and SSH account permissions still apply. Local tools and SFTP retain their existing policies.\n</session-sandbox>`;
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

	async instructions(sessionId: string): Promise<string> {
		const session = await this.#sessions.findById(sessionId);
		if (!session) throw new ManagementError("not_found", `Session not found: ${sessionId}`);
		return sessionSandboxInstructions(sessionSandboxMode(session), session.sandboxWritableRoots, session.sandboxReadOnly);
	}

	async readOnly(sessionId: string): Promise<boolean> {
		const session = await this.#sessions.findById(sessionId);
		if (!session) throw new ManagementError("not_found", `Session not found: ${sessionId}`);
		return session.sandboxReadOnly === true;
	}
}
