import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { TerminalOpenFailure, terminalOpenFailureFromStatus } from "../features/terminal/components/terminal-open-failure.tsx";
import type { TerminalStatusResponse } from "../features/terminal/model/terminal.ts";
import { zhCNMessages } from "../features/i18n/messages/zh-CN.ts";

const failedStatus = {
	terminal: {
		id: "terminal-1", sessionId: "session-1", workspaceId: "workspace-1", status: "failed",
		requestedSandboxMode: "workspace_write", sandbox: null, geometry: { rows: 36, cols: 120 },
		eventSequence: 1, ownershipEpoch: 0, closeReason: null,
		failureCode: "sandbox_bubblewrap_not_installed", failureMessage: "Bubblewrap 尚未安装",
		createdAt: 1, updatedAt: 2,
	},
	effectiveServerInteractionMode: "command", transitionInProgress: false,
	capabilities: { minRows: 12, maxRows: 120, minCols: 40, maxCols: 320 },
} satisfies TerminalStatusResponse;

describe("Terminal opening failure", () => {
	it("surfaces an asynchronous failed Terminal status after the open request returned", () => {
		const failure = terminalOpenFailureFromStatus(failedStatus, null);
		expect(failure).toEqual({ key: "terminal-1:2", code: "sandbox_bubblewrap_not_installed",
			message: "Bubblewrap 尚未安装" });
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<TerminalOpenFailure failure={failure!} canRetry canRequestInstallation
				onRetry={vi.fn()} onRequestInstallation={vi.fn()} onDismiss={vi.fn()} />
		</IntlProvider>);
		expect(html).toContain("Bubblewrap 尚未安装");
		expect(html).toContain("交给模型处理安装");
		expect(html).toContain("重试打开");
		expect(html).toContain('role="alert"');
	});

	it("shows generic transport failures and does not offer installation for unrelated errors", () => {
		expect(terminalOpenFailureFromStatus(null, "Network unavailable")).toEqual({
			key: null, code: null, message: "Network unavailable",
		});
		expect(terminalOpenFailureFromStatus({ ...failedStatus, terminal: { ...failedStatus.terminal,
			status: "active", sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full",
				abi: 5, launcherVersion: "3", sandboxRoot: "/srv/app" } } }, "stale error")).toBeNull();
		const failure = terminalOpenFailureFromStatus({ ...failedStatus, terminal: { ...failedStatus.terminal,
			failureCode: "terminal_open_timeout", failureMessage: "Timed out" } }, null)!;
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<TerminalOpenFailure failure={failure} canRetry canRequestInstallation={false}
				onRetry={vi.fn()} onRequestInstallation={vi.fn()} onDismiss={vi.fn()} />
		</IntlProvider>);
		expect(html).toContain("Timed out");
		expect(html).not.toContain("交给模型处理安装");
	});
});
