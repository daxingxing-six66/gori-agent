import { describe, expect, it } from "vitest";
import {
	canSelectChatComposerTool,
	chatComposerMenuIncludesFiles,
	filterChatComposerTools,
	matchChatComposerMenuTrigger,
	nextEnabledComposerMenuIndex,
	removeChatComposerMenuTrigger,
	resolveChatComposerMenuSections,
	type ChatComposerTool,
} from "@/features/chat/model/chat-composer-menu";

const terminalTool: ChatComposerTool = {
	id: "terminal",
	icon: "terminal",
	name: "Terminal Mode",
	description: "创建持久化 SSH PTY 供 Agent 使用",
	keywords: ["terminal", "终端", "pty"],
	status: { label: "已启动", tone: "active" },
};

const compactTool: ChatComposerTool = {
	id: "compact",
	icon: "compact",
	name: "压缩上下文",
	description: "将当前会话历史压缩为摘要",
	keywords: ["compact", "context", "压缩"],
};

describe("chat composer menu triggers", () => {
	it("opens the command menu only at the beginning of an otherwise blank message", () => {
		expect(matchChatComposerMenuTrigger("/term")).toMatchObject({
			trigger: "command",
			query: "term",
			startOffsetInTextNode: 0,
			endOffsetInTextNode: 5,
		});
		expect(matchChatComposerMenuTrigger("  /终端")).toMatchObject({ trigger: "command", query: "终端" });
		expect(matchChatComposerMenuTrigger("运行 /term")).toBeNull();
		expect(matchChatComposerMenuTrigger("访问 https://example.com/path")).toBeNull();
	});

	it("opens the mention menu at the beginning or after whitespace", () => {
		expect(matchChatComposerMenuTrigger("@term")).toMatchObject({ trigger: "mention", query: "term" });
		expect(matchChatComposerMenuTrigger("检查 @src")).toMatchObject({
			trigger: "mention",
			query: "src",
			startOffsetInTextNode: 3,
			endOffsetInTextNode: 7,
		});
		expect(matchChatComposerMenuTrigger("user@example.com")).toBeNull();
	});

	it("parses the committed Chinese composition text after input completes", () => {
		expect(matchChatComposerMenuTrigger("@重启服务")).toMatchObject({ trigger: "mention", query: "重启服务" });
		expect(matchChatComposerMenuTrigger("/压缩上下文")).toMatchObject({ trigger: "command", query: "压缩上下文" });
	});

	it("keeps files exclusive to the mention menu", () => {
		expect(chatComposerMenuIncludesFiles("command")).toBe(false);
		expect(chatComposerMenuIncludesFiles("mention")).toBe(true);
	});
});

describe("chat composer tool selection", () => {
	it("filters tools by name, description, and keywords", () => {
		expect(filterChatComposerTools([terminalTool, compactTool], "terminal")).toEqual([terminalTool]);
		expect(filterChatComposerTools([terminalTool], "SSH PTY")).toEqual([terminalTool]);
		expect(filterChatComposerTools([terminalTool], "终端")).toEqual([terminalTool]);
		expect(filterChatComposerTools([terminalTool], "已启动")).toEqual([terminalTool]);
		expect(filterChatComposerTools([terminalTool, compactTool], "context")).toEqual([compactTool]);
		expect(filterChatComposerTools([terminalTool, compactTool], "压缩")).toEqual([compactTool]);
		expect(filterChatComposerTools([terminalTool, compactTool], "plan")).toEqual([]);
	});

	it("removes only the active trigger range", () => {
		const message = "检查 @term 后继续";
		expect(removeChatComposerMenuTrigger(message, 3, 8)).toBe("检查  后继续");
		expect(removeChatComposerMenuTrigger("/terminal", 0, 9)).toBe("");
	});

	it("skips disabled tools during keyboard navigation and rejects direct selection", () => {
		expect(nextEnabledComposerMenuIndex([true, false, true, false], 3, 1)).toBe(1);
		expect(nextEnabledComposerMenuIndex([true, false, true, false], 1, -1)).toBe(3);
		expect(nextEnabledComposerMenuIndex([true], 0, 1)).toBe(-1);
		expect(canSelectChatComposerTool({ ...terminalTool, disabled: true })).toBe(false);
		expect(canSelectChatComposerTool(terminalTool)).toBe(true);
	});
});

describe("chat composer menu sections", () => {
	it("hides an empty tool group while retaining matching files", () => {
		expect(resolveChatComposerMenuSections({
			fileMenuOpen: true,
			fileLoading: false,
			fileError: false,
			hasParentDirectory: false,
			visibleToolCount: 0,
			visibleFileCount: 1,
		})).toEqual({ showTools: false, showFiles: true, showEmpty: false });
	});

	it("shows one combined empty state when neither tools nor files match", () => {
		expect(resolveChatComposerMenuSections({
			fileMenuOpen: true,
			fileLoading: false,
			fileError: false,
			hasParentDirectory: false,
			visibleToolCount: 0,
			visibleFileCount: 0,
		})).toEqual({ showTools: false, showFiles: false, showEmpty: true });
		expect(resolveChatComposerMenuSections({
			fileMenuOpen: false,
			fileLoading: false,
			fileError: false,
			hasParentDirectory: false,
			visibleToolCount: 0,
			visibleFileCount: 0,
		})).toEqual({ showTools: false, showFiles: false, showEmpty: true });
	});

	it("keeps the file group visible while files are loading or failed", () => {
		expect(resolveChatComposerMenuSections({
			fileMenuOpen: true,
			fileLoading: true,
			fileError: false,
			hasParentDirectory: false,
			visibleToolCount: 0,
			visibleFileCount: 0,
		})).toEqual({ showTools: false, showFiles: true, showEmpty: false });
		expect(resolveChatComposerMenuSections({
			fileMenuOpen: true,
			fileLoading: false,
			fileError: true,
			hasParentDirectory: false,
			visibleToolCount: 0,
			visibleFileCount: 0,
		})).toEqual({ showTools: false, showFiles: true, showEmpty: false });
	});
});
