export interface ChatContextUsage {
	contextTokens: number;
	contextWindow: number;
	usagePercent: number;
	source: "estimated";
	providerId: string;
	modelId: string;
}
