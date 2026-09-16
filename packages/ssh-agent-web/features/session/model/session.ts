import type { ThinkingLevel } from "@/features/llm-provider/model/llm-provider";

export interface Session {
	id: string;
	workspaceId: string;
	displayName: string;
	workDir: string | null;
	autoAudit: boolean;
	terminalContextCursor: number;
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export interface ChatModelSelection {
	providerId: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
}

export type SessionDetails = Session & {
	chatModelSelection: ChatModelSelection | null;
};
