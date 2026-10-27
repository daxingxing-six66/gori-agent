import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

export type ChatGptModelCapabilities = Pick<Model<"openai-responses">,
	"contextWindow" | "maxTokens" | "input" | "reasoning" | "thinkingLevelMap">;

const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** A documentation URL is derived from an exact account model ID, never from a guessed family. */
export function chatGptModelDocumentationUrl(id: string): string | undefined {
	if (!/^(?:gpt-|chatgpt-|o[1-9])[-a-z0-9.]*$/.test(id) || id.length > 128) return undefined;
	return `https://developers.openai.com/api/docs/models/${id}.md`;
}

/** Parse facts only. Prose, tools, prices and request settings never become model configuration. */
export function parseChatGptModelDocumentation(id: string, markdown: string): ChatGptModelCapabilities | undefined {
	const modelId = markdown.match(/^Model ID:\s*`([^`\n]+)`\s*$/m)?.[1];
	const snapshots = markdown.split(/^## Snapshots\s*$/m)[1]?.split(/^## /m)[0] ?? "";
	if (!modelId || (modelId !== id && !snapshots.split("\n").some((line) => line.trim() === `- \`${id}\``))) return undefined;
	const contextWindow = tokenCount(markdown.match(/^- ([\d,]+) context window\s*$/m)?.[1]);
	const maxTokens = tokenCount(markdown.match(/^- ([\d,]+) max output tokens\s*$/m)?.[1]);
	const modalities = markdown.match(/^- Input modalities:\s*([^\n]+)$/m)?.[1]?.split(",").map((value) => value.trim());
	if (!contextWindow || !maxTokens || maxTokens > contextWindow || !modalities?.includes("text")) return undefined;
	// Do not silently lose an advertised input modality that the shared Model type cannot represent.
	if (modalities.some((value) => value !== "text" && value !== "image")) return undefined;
	const input: ("text" | "image")[] = modalities.includes("image") ? ["text", "image"] : ["text"];
	const declaration = markdown.match(/`reasoning\.effort` supports\s+([\s\S]*?)\.(?:\s|$)/)?.[1];
	if (!declaration) {
		if (!/^- Reasoning tokens?: (?:Not supported|Unsupported)\s*$/im.test(markdown)) return undefined;
		return { contextWindow, maxTokens, input, reasoning: false };
	}
	const supported = [...declaration.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
	if (!supported.length || supported.some((value) => !efforts.some((effort) => effort === value))) return undefined;
	const thinkingLevelMap: ThinkingLevelMap = {
		off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
	};
	for (const effort of efforts) {
		if (supported.includes(effort)) thinkingLevelMap[effort === "none" ? "off" : effort] = effort;
	}
	return { contextWindow, maxTokens, input, reasoning: supported.some((effort) => effort !== "none"), thinkingLevelMap };
}

function tokenCount(value: string | undefined): number | undefined {
	if (!value || !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)) return undefined;
	const count = Number(value.replaceAll(",", ""));
	return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}
