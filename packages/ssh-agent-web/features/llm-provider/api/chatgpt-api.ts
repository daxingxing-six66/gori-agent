import { apiRequest } from "@/shared/api/client";

export interface ChatGptConnection {
	connected: boolean;
	email: string | null;
	sharing: boolean;
	manageUsageUrl: string;
}

export interface ChatGptSignIn {
	id: string;
	status: "pending" | "connected" | "cancelled" | "failed";
	errorCode?: "chatgpt_sign_in_failed" | "chatgpt_permission_required" | "chatgpt_model_discovery_failed" | "chatgpt_region_unsupported";
	failure?: { stage: string; reason: string; httpStatus?: number; transportCode?: string; upstreamCode?: string };
}

export const chatGptApi = {
	connection: (signal?: AbortSignal) => apiRequest<ChatGptConnection>("/api/llm/chatgpt", { signal }),
	begin: (newAccount: boolean) => apiRequest<ChatGptSignIn & { authorizationUrl: string }>("/api/llm/chatgpt/sign-in", { method: "POST", body: { newAccount } }),
	status: (id: string, signal?: AbortSignal) => apiRequest<ChatGptSignIn>(`/api/llm/chatgpt/sign-in/${encodeURIComponent(id)}`, { signal }),
	cancel: (id: string) => apiRequest<void>(`/api/llm/chatgpt/sign-in/${encodeURIComponent(id)}`, { method: "DELETE" }),
	disconnect: () => apiRequest<void>("/api/llm/chatgpt", { method: "DELETE" }),
	refreshModels: () => apiRequest<void>("/api/llm/chatgpt/models", { method: "POST" }),
};
