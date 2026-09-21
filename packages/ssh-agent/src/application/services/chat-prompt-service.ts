import { arch, release, type } from "node:os";
import type { Session } from "../../domain/session.ts";
import { systemPromptFor } from "../chat-context.ts";
import type { ChatPromptRepository } from "../repositories/chat-prompt-repository.ts";
import type { WorkspaceRepository } from "../repositories/workspace-repository.ts";

export class ChatPromptService {
	readonly #repository: ChatPromptRepository;
	readonly #workspaces: Pick<WorkspaceRepository, "findById">;

	constructor(repository: ChatPromptRepository, workspaces: Pick<WorkspaceRepository, "findById">) {
		this.#repository = repository;
		this.#workspaces = workspaces;
	}

	read(sessionId: string): string | undefined {
		return this.#repository.find(sessionId)?.systemPrompt;
	}

	async initialize(session: Session, workDir: string): Promise<string> {
		const existing = this.read(session.id);
		if (existing !== undefined) return existing;
		const workspace = await this.#workspaces.findById(session.workspaceId);
		if (!workspace) throw new Error("Session target is unavailable");
		const systemPrompt = systemPromptFor({
			workDir,
			operatingSystem: `${type()} ${release()} (${arch()})`,
			remoteHost: workspace.host.hostname,
			remotePort: workspace.host.port,
		});
		return this.#repository.createOnce({
			sessionId: session.id,
			systemPrompt,
			version: 1,
			createdAt: Date.now(),
		}).systemPrompt;
	}
}
