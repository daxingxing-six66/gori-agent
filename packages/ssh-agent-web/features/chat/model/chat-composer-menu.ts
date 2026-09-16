export type ChatComposerMenuTrigger = "command" | "mention";

export interface ChatComposerMenuMatch {
	trigger: ChatComposerMenuTrigger;
	query: string;
	startOffsetInTextNode: number;
	endOffsetInTextNode: number;
}

export interface ChatComposerTool {
	id: string;
	icon: "terminal" | "compact";
	name: string;
	description: string;
	keywords: readonly string[];
	status?: {
		label: string;
		tone: "active" | "inactive" | "pending";
	};
	disabled?: boolean;
	disabledReason?: string;
}

export interface ChatComposerMenuSectionsInput {
	fileMenuOpen: boolean;
	fileLoading: boolean;
	fileError: boolean;
	hasParentDirectory: boolean;
	visibleToolCount: number;
	visibleFileCount: number;
}

export function resolveChatComposerMenuSections(input: ChatComposerMenuSectionsInput): {
	showTools: boolean;
	showFiles: boolean;
	showEmpty: boolean;
} {
	const showTools = input.visibleToolCount > 0;
	const fileStatePendingOrFailed = input.fileMenuOpen && (input.fileLoading || input.fileError);
	const hasResults = showTools || (input.fileMenuOpen && (input.visibleFileCount > 0 || input.hasParentDirectory));
	const showEmpty = !fileStatePendingOrFailed && !hasResults;
	return { showTools, showFiles: input.fileMenuOpen && !showEmpty, showEmpty };
}

export function matchChatComposerMenuTrigger(
	messageBeforeCaret: string,
	textNodeBeforeCaret: string = messageBeforeCaret,
): ChatComposerMenuMatch | null {
	const commandMatch = messageBeforeCaret.match(/^\s*\/([^\s<>/]*)$/u);
	if (commandMatch) {
		const query = commandMatch[1] ?? "";
		const startOffsetInTextNode = textNodeBeforeCaret.length - query.length - 1;
		if (startOffsetInTextNode >= 0 && textNodeBeforeCaret.slice(startOffsetInTextNode) === `/${query}`) {
			return {
				trigger: "command",
				query,
				startOffsetInTextNode,
				endOffsetInTextNode: textNodeBeforeCaret.length,
			};
		}
	}

	const mentionMatch = textNodeBeforeCaret.match(/(?:^|\s)@([^\s<>]*)$/u);
	if (!mentionMatch) return null;
	const query = mentionMatch[1] ?? "";
	return {
		trigger: "mention",
		query,
		startOffsetInTextNode: textNodeBeforeCaret.length - query.length - 1,
		endOffsetInTextNode: textNodeBeforeCaret.length,
	};
}

export function filterChatComposerTools(tools: readonly ChatComposerTool[], query: string): ChatComposerTool[] {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	if (!normalizedQuery) return [...tools];
	return tools.filter((tool) => [tool.name, tool.description, tool.status?.label ?? "", ...tool.keywords]
		.some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
}

export function chatComposerMenuIncludesFiles(trigger: ChatComposerMenuTrigger): boolean {
	return trigger === "mention";
}

export function canSelectChatComposerTool(tool: ChatComposerTool): boolean {
	return tool.disabled !== true;
}

export function firstEnabledComposerMenuIndex(disabledItems: readonly boolean[]): number {
	return disabledItems.findIndex((disabled) => !disabled);
}

export function nextEnabledComposerMenuIndex(
	disabledItems: readonly boolean[],
	currentIndex: number,
	direction: 1 | -1,
): number {
	if (disabledItems.length === 0) return -1;
	for (let offset = 1; offset <= disabledItems.length; offset += 1) {
		const candidate = (currentIndex + direction * offset + disabledItems.length * 2) % disabledItems.length;
		if (!disabledItems[candidate]) return candidate;
	}
	return -1;
}

export function removeChatComposerMenuTrigger(text: string, startOffset: number, endOffset: number): string {
	return text.slice(0, startOffset) + text.slice(endOffset);
}
