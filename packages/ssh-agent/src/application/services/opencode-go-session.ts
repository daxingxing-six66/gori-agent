import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";

export function addOpenCodeGoSessionHeaders(
	model: Model<Api>,
	sessionId: string,
	headers: Record<string, string> | undefined,
): Record<string, string> | undefined;
export function addOpenCodeGoSessionHeaders(
	model: Model<Api>,
	sessionId: string,
	headers: ProviderHeaders | undefined,
): ProviderHeaders | undefined;
export function addOpenCodeGoSessionHeaders(
	model: Model<Api>,
	sessionId: string,
	headers: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (model.provider !== "opencode-go") return headers;
	return {
		...headers,
		"x-opencode-session": sessionId,
		"x-opencode-client": "pi",
	};
}
