import type { RuntimeContextMessage, RuntimeContextSnapshot } from "../../domain/runtime-context.ts";

export interface RuntimeContextRepository {
	/** Read facts and append changed snapshots under one transaction. */
	synchronize(sessionId: string, read: () => Promise<RuntimeContextSnapshot[]>): Promise<RuntimeContextMessage[]>;
	latest(sessionId: string): RuntimeContextMessage[];
}
