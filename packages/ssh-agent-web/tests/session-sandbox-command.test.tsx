import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { parseSessionSandboxCommand, isSessionSandboxCommand } from "../features/session/model/session-sandbox-command";
import { matchChatComposerMenuTrigger } from "../features/chat/model/chat-composer-menu";
import { requireTerminalSession } from "../features/terminal/model/terminal";
import { TerminalSandboxNotice } from "../features/terminal/components/terminal-sandbox-notice";
import { DeploymentReview } from "../features/deploy/components/deployment-review";
import { deploymentReviewState } from "../features/deploy/model/deployment-review";
import { isDeploymentRun, type DeploymentRun } from "../features/deploy/model/deployment";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";
import { SessionSandboxBadge } from "../features/session/components/session-sandbox-badge";

describe("Session sandbox command and audit projection", () => {
	it("recognizes commands with arguments and keeps normal messages separate", () => {
		expect(parseSessionSandboxCommand(" /sandbox off ")).toEqual({ kind: "set", enabled: false });
		expect(parseSessionSandboxCommand("/sandbox on")).toEqual({ kind: "set", enabled: true });
		expect(parseSessionSandboxCommand("/sandbox read-only")).toEqual({ kind: "invalid" });
		expect(parseSessionSandboxCommand("/sandbox")).toEqual({ kind: "toggle" });
		expect(parseSessionSandboxCommand("/sandbox nope")).toEqual({ kind: "invalid" });
		expect(isSessionSandboxCommand("请关闭沙箱")).toBe(false);
		expect(matchChatComposerMenuTrigger("/sandbox")).toMatchObject({ query: "sandbox", trigger: "command", startOffsetInTextNode: 0 });
		expect(matchChatComposerMenuTrigger("/sandbox off")).toBeNull();
		expect(matchChatComposerMenuTrigger("运行 /sandbox off")).toBeNull();
	});
	it("shows the confirmed read-only policy in the header badge", () => {
		const markup = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}><SessionSandboxBadge enabled readOnly /></IntlProvider>);
		expect(markup).toContain("只读沙盒");
		expect(markup).not.toContain("沙盒已关闭");
	});
	it("distinguishes intentional Terminal disablement from historical automatic fallback", () => {
		const sandbox = { mode: "full_access", backend: "none", enforcement: "none", source: "session_setting", configuredAt: 10 } as const;
		const terminal = { id: "pty", sessionId: "session", workspaceId: "workspace", status: "active", requestedSandboxMode: "full_access",
			sandbox, geometry: { rows: 36, cols: 120 }, eventSequence: 1, ownershipEpoch: 0,
			closeReason: null, failureCode: null, failureMessage: null, createdAt: 1, updatedAt: 10 };
		expect(requireTerminalSession(terminal).sandbox).toEqual(sandbox);
		expect(() => requireTerminalSession({ ...terminal, requestedSandboxMode: "workspace_write" })).toThrow();
		const markup = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}><TerminalSandboxNotice sandbox={sandbox} /></IntlProvider>);
		expect(markup).toContain("此 Session 已关闭沙箱"); expect(markup).not.toContain("自动回退");
	});
	it("allows starting a deployment under Session authorization without exception approval buttons", () => {
		const run: DeploymentRun = { id: "deployment", sessionId: "session", workspaceId: "workspace", status: "preparing", createdAt: 1, updatedAt: 1,
			plan: { remoteAccess: { mode: "full_access", reason: "session_sandbox_disabled" }, profilePath: "/project/.gori/deploy-test.md", profileHash: "hash",
				project: "project", target: { host: "test.invalid" }, module: { id: "api", name: "API" },
				targetBinding: { port: 22, credentialId: "key", credentialAuthVersion: 1, remoteUser: "test", hostKeyFingerprint: "SHA256:test", writableRoot: "/srv/app" },
				build: { cwd: "/project", command: "build", artifact: "/project/app.jar" }, upload: { remotePath: "/srv/app/app.jar" }, restart: { command: "restart" } },
			stages: { prepare: { status: "success", log: "" }, build: { status: "pending", log: "" }, upload: { status: "pending", log: "" },
				restart: { status: "pending", log: "" }, verify: { status: "pending", log: "" } } };
		expect(isDeploymentRun(run)).toBe(true);
		const noop = () => undefined;
		const markup = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}><DeploymentReview run={run} review={deploymentReviewState(run)}
			busy={false} canConfirm onConfirm={noop} onReviewPermissions={noop} onDecideRecovery={noop} /></IntlProvider>);
		expect(markup).toContain(zhCNMessages["deploy.confirm"]); expect(markup).not.toContain("Full Access"); expect(markup).not.toContain("disabled=");
	});
});
