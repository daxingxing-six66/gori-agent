export interface ChatContextUsage {
	contextTokens: number;
	contextWindow: number;
	usagePercent: number;
	source: "estimated";
	providerId: string;
	modelId: string;
}

export function isChatContextUsage(value: unknown): value is ChatContextUsage {
	if (value === null || typeof value !== "object") return false;
	const data = value as Record<string, unknown>;
	return typeof data.contextTokens === "number" && Number.isFinite(data.contextTokens) && data.contextTokens >= 0 &&
		typeof data.contextWindow === "number" && Number.isFinite(data.contextWindow) && data.contextWindow > 0 &&
		typeof data.usagePercent === "number" && Number.isFinite(data.usagePercent) && data.usagePercent >= 0 &&
		data.source === "estimated" && typeof data.providerId === "string" && typeof data.modelId === "string";
}
