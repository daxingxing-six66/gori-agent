import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { RealtimeOverviewTab } from "../features/sftp/components/realtime-overview-tab";
import { messagesByLocale } from "../features/i18n/messages/messages";
import type { Workspace } from "../features/workspace/model/workspace";

vi.mock("../features/sftp/components/use-workspace-events", () => ({ useWorkspaceEvents: () => "connected" }));

const workspace: Workspace = {
	id: "w", displayName: "server", environment: "development", host: { hostname: "192.168.1.1", port: 22, hostKey: null }, activeCredentialId: "credential-id", defaultCwd: "/opt/app", connection: { connectTimeoutMs: 10000, keepaliveIntervalMs: 1000, keepaliveMaxCount: 3 }, revision: 1, createdAt: 0, updatedAt: 0,
};

describe("overview translations", () => {
	it("renders Chinese labels while preserving connection data", () => {
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: messagesByLocale["zh-CN"] }, createElement(RealtimeOverviewTab, { workspace })));
		for (const label of ["内存", "磁盘", "SSH 连接", "连接池", "开发环境", "活动通道", "连接时长", "进程排行", "空闲", "192.168.1.1:22", "/opt/app", "credential-id"]) expect(html).toContain(label);
		for (const label of ["Top processes", "SSH connection", "Connection pool", "Working directory"]) expect(html).not.toContain(label);
		expect(messagesByLocale["zh-CN"]["workspace.tabs.overview"]).toBe("概览");
		expect(messagesByLocale["zh-CN"]["workspace.tabs.guard"]).toBe("防护规则");
		expect(messagesByLocale["zh-CN"]["workspace.tabs.files"]).toBe("SFTP 文件");
	});
	it("keeps English labels available", () => {
		const html = renderToStaticMarkup(createElement(IntlProvider, { locale: "en-US", messages: messagesByLocale["en-US"] }, createElement(RealtimeOverviewTab, { workspace })));
		for (const label of ["Memory", "Disk", "SSH connection", "Connection pool", "Top processes", "Idle"]) expect(html).toContain(label);
	});
});
