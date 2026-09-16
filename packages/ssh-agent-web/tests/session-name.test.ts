import { describe, expect, it } from "vitest";
import { sessionNameFromMessage } from "../features/session/model/session-name.ts";

describe("sessionNameFromMessage", () => {
	it("uses the first six visible characters of normalized content", () => {
		expect(sessionNameFromMessage("  检查\n\n服务器运行状态  ")).toBe("检查 服务器");
	});

	it("does not split emoji grapheme clusters", () => {
		expect(sessionNameFromMessage("👨‍💻检查服务器状态")).toBe("👨‍💻检查服务器");
	});

	it("falls back for empty content", () => {
		expect(sessionNameFromMessage(" \n ", "新会话")).toBe("新会话");
	});
});
