import type { ChatContext } from "../chat-context.ts";
import type { RuntimeContextRepository } from "../repositories/runtime-context-repository.ts";
import { appendRuntimeContext, projectRuntimeSnapshots, type RuntimeContextSnapshot } from "../../domain/runtime-context.ts";
import { ChatError } from "../../domain/chat.ts";

export class ChatRuntimeContextService {
	private readonly repository: RuntimeContextRepository;
	constructor(repository: RuntimeContextRepository) { this.repository = repository; }
	workflow(sessionId: string, scopes: string[]): { scope: string; instructions: string; data: Record<string, unknown> } | undefined {
		const current = this.repository.latest(sessionId).find(message => message.runtimeContext.channel === "workflow")?.runtimeContext;
		return current?.active && scopes.includes(current.scope) && current.instructions
			? { scope: current.scope, instructions: current.instructions, data: current.data } : undefined;
	}
	async synchronize<T extends ChatContext>(sessionId: string, context: T, read: () => Promise<RuntimeContextSnapshot[]>): Promise<T> {
		let readFailed = false;
		try {
			const committed = await this.repository.synchronize(sessionId, async () => {
				try { return await read(); } catch (cause) { readFailed = true; throw cause; }
			});
			return { ...context, messages: appendRuntimeContext(context.messages, committed) };
		} catch (cause) {
			if (readFailed || cause instanceof ChatError) throw cause;
			throw new ChatError("chat_persistence_failed", "Runtime context could not be saved", 503, { cause });
		}
	}
	/** Estimate missing current facts without creating history or a head cursor. */
	async preview<T extends ChatContext>(sessionId: string, context: T, read: () => Promise<RuntimeContextSnapshot[]>): Promise<T> {
		const committed = this.repository.latest(sessionId), current = await read();
		return { ...context, messages: projectRuntimeSnapshots(appendRuntimeContext(context.messages, committed), current) };
	}
}
