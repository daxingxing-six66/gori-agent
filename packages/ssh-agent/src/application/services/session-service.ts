import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ManagementError } from "../../domain/errors.ts";
import type { Clock, IdGenerator, SessionId, WorkspaceId } from "../../domain/ids.ts";
import type { CreateSessionInput, DeleteSessionInput, Session, UpdateSessionInput } from "../../domain/session.ts";
import type { CommandOperationRepository } from "../repositories/command-operation-repository.ts";
import type { SessionRepository } from "../repositories/session-repository.ts";
import type { WorkspaceRepository } from "../repositories/workspace-repository.ts";
import { requireDisplayName, requirePositiveRevision } from "../validation.ts";
import type { SessionLifecycleCoordinator } from "./session-lifecycle-coordinator.ts";

export interface SessionService {
	create(input: CreateSessionInput): Promise<Session>;
	get(id: SessionId): Promise<Session>;
	listByWorkspaceId(workspaceId: WorkspaceId): Promise<Session[]>;
	listAll(): Promise<Session[]>;
	update(input: UpdateSessionInput): Promise<Session>;
	rename(input: UpdateSessionInput): Promise<Session>;
	delete(input: DeleteSessionInput): Promise<void>;
}

export interface DefaultSessionServiceOptions {
	sessions: SessionRepository;
	workspaces: WorkspaceRepository;
	clock: Clock;
	ids: IdGenerator;
	operations?: Pick<CommandOperationRepository, "countActiveBySessionId">;
	hasActiveChatRun?: (sessionId: SessionId) => Promise<boolean>;
	lifecycle?: SessionLifecycleCoordinator;
	closeTerminalForDeletion?: (sessionId: SessionId) => Promise<void>;
	cleanupAttachmentsForDeletion?: (sessionId: SessionId) => Promise<void>;
}

export class DefaultSessionService implements SessionService {
	private readonly sessions: SessionRepository;
	private readonly workspaces: WorkspaceRepository;
	private readonly clock: Clock;
	private readonly ids: IdGenerator;
	private readonly operations?: Pick<CommandOperationRepository, "countActiveBySessionId">;
	private readonly hasActiveChatRun?: (sessionId: SessionId) => Promise<boolean>;
	private readonly lifecycle?: SessionLifecycleCoordinator;
	private readonly closeTerminalForDeletion?: (sessionId: SessionId) => Promise<void>;
	private readonly cleanupAttachmentsForDeletion?: (sessionId: SessionId) => Promise<void>;

	constructor(options: DefaultSessionServiceOptions) {
		this.sessions = options.sessions;
		this.workspaces = options.workspaces;
		this.clock = options.clock;
		this.ids = options.ids;
		this.operations = options.operations;
		this.hasActiveChatRun = options.hasActiveChatRun;
		this.lifecycle = options.lifecycle;
		this.closeTerminalForDeletion = options.closeTerminalForDeletion;
		this.cleanupAttachmentsForDeletion = options.cleanupAttachmentsForDeletion;
	}

	async create(input: CreateSessionInput): Promise<Session> {
		const workspace = await this.workspaces.findById(input.workspaceId);
		if (!workspace) {
			throw new ManagementError("not_found", `Workspace not found: ${input.workspaceId}`);
		}
		const now = this.clock.now();
		const session: Session = {
			id: this.ids.next(),
			workspaceId: input.workspaceId,
			displayName: requireDisplayName(input.displayName),
			workDir: await normalizeWorkDir(input.workDir ?? workspace.defaultCwd),
			autoAudit: input.autoAudit ?? false,
			terminalContextCursor: 0,
			revision: 1,
			createdAt: now,
			updatedAt: now,
		};
		await this.sessions.insert(session);
		return session;
	}

	async get(id: SessionId): Promise<Session> {
		const session = await this.sessions.findById(id);
		if (!session) throw new ManagementError("not_found", `Session not found: ${id}`);
		return session;
	}

	listByWorkspaceId(workspaceId: WorkspaceId): Promise<Session[]> {
		return this.sessions.listByWorkspaceId(workspaceId);
	}

	listAll(): Promise<Session[]> {
		return this.sessions.listAll();
	}

	async rename(input: UpdateSessionInput): Promise<Session> {
		return this.update(input);
	}

	async update(input: UpdateSessionInput): Promise<Session> {
		const lease = this.lifecycle?.acquireUse(input.id, "session_update");
		try {
			requirePositiveRevision(input.expectedRevision);
			if (input.displayName === undefined && input.workDir === undefined && input.autoAudit === undefined) {
				throw new ManagementError("validation_error", "Session update must contain a mutable field", "body");
			}
			const current = await this.get(input.id);
			if (current.revision !== input.expectedRevision) {
				throw new ManagementError("revision_conflict", "Session was modified by another request");
			}
			if (
				(input.workDir !== undefined || input.autoAudit !== undefined) &&
				(await this.hasActiveChatRun?.(input.id)) === true
			) {
				throw new ManagementError("session_has_active_chat_run", "Session has an active Chat Run");
			}
			const updated: Session = {
				...current,
				displayName: input.displayName === undefined ? current.displayName : requireDisplayName(input.displayName),
				workDir:
					input.workDir === undefined
						? current.workDir
						: input.workDir === null
							? null
							: await normalizeWorkDir(input.workDir),
				autoAudit: input.autoAudit ?? current.autoAudit,
				revision: current.revision + 1,
				updatedAt: this.clock.now(),
			};
			if (!(await this.sessions.update(updated, input.expectedRevision))) {
				throw new ManagementError("revision_conflict", "Session was modified by another request");
			}
			return updated;
		} finally {
			lease?.release();
		}
	}

	async delete(input: DeleteSessionInput): Promise<void> {
		const barrier = await this.lifecycle?.acquireDeletionBarrier(input.id);
		try {
			requirePositiveRevision(input.expectedRevision);
			const current = await this.sessions.findById(input.id);
			if (!current) throw new ManagementError("not_found", `Session not found: ${input.id}`);
			if (current.revision !== input.expectedRevision) {
				throw new ManagementError("revision_conflict", "Session was modified by another request");
			}
			if ((await this.hasActiveChatRun?.(input.id)) === true) {
				throw new ManagementError("session_has_active_chat_run", "Session has an active Chat Run");
			}
			if ((this.lifecycle?.getUsage(input.id).byKind.attachment_upload ?? 0) > 0) {
				throw new ManagementError(
					"session_has_active_attachment_upload",
					"Session has an active Attachment upload",
				);
			}
			if (this.operations && (await this.operations.countActiveBySessionId(input.id)) > 0) {
				throw new ManagementError(
					"session_has_active_operations",
					"Session still contains active command Operations",
				);
			}
			await this.closeTerminalForDeletion?.(input.id);
			if (!(await this.sessions.delete(input.id, input.expectedRevision))) {
				throw new ManagementError("revision_conflict", "Session was modified by another request");
			}
			await this.cleanupAttachmentsForDeletion?.(input.id).catch((error) => {
				console.error("Failed to remove deleted Session Attachment files", { sessionId: input.id, error });
			});
		} finally {
			barrier?.release();
		}
	}
}

async function normalizeWorkDir(value: string): Promise<string> {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new ManagementError("validation_error", "workDir must not be empty", "workDir");
	const expanded =
		trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
	if (!isAbsolute(expanded))
		throw new ManagementError("validation_error", "workDir must be absolute or start with ~/", "workDir");
	try {
		const normalized = await realpath(expanded);
		if (!(await stat(normalized)).isDirectory()) throw new Error("not a directory");
		return normalized;
	} catch (error) {
		throw new ManagementError(
			"validation_error",
			"workDir must exist and be a directory",
			"workDir",
			error instanceof Error ? error : undefined,
		);
	}
}
