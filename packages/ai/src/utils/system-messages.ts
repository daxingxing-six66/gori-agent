import type { Api } from "../types.ts";

/** Adapters that preserve chronological system messages without changing their role. */
export function supportsConversationSystemMessages(api: Api): boolean {
	return api === "faux" || api.startsWith("faux:") || ["mistral-conversations", "openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(api);
}
