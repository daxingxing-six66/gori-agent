import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { DeploymentFullAccessReview } from "../features/deploy/components/deployment-full-access-review";
import { DeploymentReview } from "../features/deploy/components/deployment-review";
import { DeploymentTaskPage } from "../features/deploy/components/deployment-task-page";
import { DeploymentModulePicker } from "../features/deploy/components/deployment-module-picker";
import { deploymentModuleOptions } from "../features/deploy/model/deployment-module-options";
import { ChatTimeline } from "../features/chat/components/chat-timeline";
import { DeploymentLogStore } from "../features/deploy/runtime/deployment-log-store";
import { conversationHistory } from "../features/chat/model/conversation-history";
import { deploymentNeedsReview, deploymentReviewState } from "../features/deploy/model/deployment-review";
import type { DeploymentDiscussion, DeploymentProfileSummary, DeploymentRun } from "../features/deploy/model/deployment";
import type { ChatTimelineEntry } from "../features/chat/model/chat-runtime-state";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";

const noop = () => undefined;
const discussion: DeploymentDiscussion = {
	id: "discussion-1", sessionId: "session-1", workspaceId: "workspace-1", status: "discussing", revision: 1,
	profileFile: "deploy-a.md", profileHash: "a".repeat(64), projectRoot: "/tmp/project", project: "example",
	module: { id: "api", name: "API" },
	targetBinding: { hostname: "example.org", port: 22, workspaceRevision: 1, hostKeyAlgorithm: "ssh-ed25519",
		hostKeyFingerprint: "SHA256:test", credentialId: "c", credentialAuthVersion: 1, remoteUser: "tester", writableRoot: "/srv/app" },
	createdAt: 1, updatedAt: 1,
};
const run: DeploymentRun = {
	id: "run-1", sessionId: "session-1", workspaceId: "workspace-1", createdAt: 2, updatedAt: 2, status: "preparing",
	plan: {
		profilePath: "/tmp/project/.gori/deploy-example.org.md", profileHash: "abc", project: "example",
		remoteAccess: { mode: "workspace_write" },
		target: { host: "example.org" },
		targetBinding: { port: 22, hostKeyFingerprint: "SHA256:test", credentialId: "c", credentialAuthVersion: 1, remoteUser: "tester", writableRoot: "/srv/app" },
		module: { id: "api", name: "API" },
		build: { cwd: "/tmp/project", command: "npm run build", artifact: "/tmp/project/app.tar.gz" },
		upload: { remotePath: "/srv/app/app.tar.gz" }, restart: { command: "systemctl restart app" },
		verify: { command: "systemctl is-active app" },
	},
	stages: {
		prepare: { status: "success", log: "" }, build: { status: "pending", log: "" },
		upload: { status: "pending", log: "" }, restart: { status: "pending", log: "" },
		verify: { status: "pending", log: "" },
	},
};


const localize = (element: React.ReactNode) => renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>{element}</IntlProvider>);
function page(props: Partial<Parameters<typeof DeploymentTaskPage>[0]> = {}) {
	return localize(<DeploymentTaskPage sessionId="session-1" task={null} run={null} discussion={null}
		logs={new DeploymentLogStore("session-1")}
		loading={false} busy={false} error={null} fullscreen={false} pending={false}
		onReturnConversation={noop} onSubmit={async () => true} {...props} />);
}
function picker(props: Partial<Parameters<typeof DeploymentModulePicker>[0]> = {}) {
	return localize(<DeploymentModulePicker discovery={null} loading={false} busy={false} disabled={false} error={null}
		onSelect={async () => undefined} onSetup={noop} onClose={noop} onRetry={noop} {...props} />);
}
function review(value: DeploymentRun, props: Partial<Parameters<typeof DeploymentReview>[0]> = {}) {
	return localize(<DeploymentReview run={value} review={deploymentReviewState(value)} busy={false} canConfirm onConfirm={noop}
		onReviewPermissions={noop} onDecideRecovery={noop} {...props} />);
}
function permissions(value: DeploymentRun) {
	const state = deploymentReviewState(value);
	return state ? localize(<DeploymentFullAccessReview run={value} stages={state.exceptionStages} pendingStages={state.pendingExceptions} busy={false} onDecide={noop} />) : "";
}
const disabledStart = /<button(?=[^>]*class="deploy-plan-start")(?=[^>]*disabled="")[^>]*>/u;
function timeline(messages: ChatTimelineEntry[], extra: Partial<Parameters<typeof ChatTimeline>[0]> = {}) {
	return localize(<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false} timeline={messages} tools={{}} approvals={{}}
		approvalMutationId={null} run={null} latestUserText="" onResolveApproval={noop} onRestoreDraft={noop}
		onOpenDeployment={noop} {...extra} />);
}
function historyKeys(history: ReturnType<typeof conversationHistory>): string[] {
	return history.map((entry) => entry.kind === "deployment" ? entry.run.id : entry.kind === "discussion" ? entry.discussion.id : entry.entry.key);
}
function planned(): DeploymentRun {
	if (run.plan.version === 2) throw new Error("Expected v1 fixture");
	const { build, upload, ...common } = run.plan;
	return { ...run, plan: { ...common, version: 2, buildSteps: [{ cwd: build.cwd, command: build.command }],
		artifacts: [{ source: build.artifact, remotePath: upload.remotePath }] } };
}

describe("deployment task and plan review", () => {
	it("preselects the first module and distinguishes identical module ids across profiles", () => {
		const profiles: DeploymentProfileSummary[] = [
			{ file: "deploy-a.md", project: "A", target: { host: "example.org" }, modules: [{ id: "api", name: "API" }, { id: "worker", name: "Worker" }] },
			{ file: "deploy-b.md", project: "B", target: { host: "example.org" }, modules: [{ id: "api", name: "API" }] },
		];
		const options = deploymentModuleOptions(profiles);
		expect(new Set(options.map((option) => option.key)).size).toBe(3);
		const html = picker({ discovery: { host: "example.org", profiles, errors: [], latest: null, activeDiscussion: null } });
		expect(html).toContain("选择部署模块");
		expect(html).not.toContain("deploy-a.md");
		expect(html).not.toContain("deploy-b.md");
		expect(html).not.toContain("deploy-module-source");
		expect(html).not.toContain("<code>");
		expect(html).not.toContain("lucide-package");
		expect(html.match(/type="radio"/g)).toHaveLength(3);
		expect(html).toContain('<ol class="deploy-module-list"');
		expect(html.match(/class="deploy-module-card"/g)).toHaveLength(3);
		const radios = html.match(/<input[^>]*type="radio"[^>]*>/gu) ?? [];
		expect(radios[0]).toContain('checked=""');
		expect(radios.slice(1).every((radio) => !radio.includes('checked=""'))).toBe(true);
		expect(html).toContain('role="dialog"');
		expect(html).not.toContain("deploy-stage-overview");
		expect(html).toContain("添加服务配置");
	});

	it("does not invent stages while discussing and keeps decisions out of the task page", () => {
		const html = page({ discussion });
		expect(html).toContain("讨论中");
		expect(html).not.toContain("deploy-stage-overview");
		expect(html).not.toContain("开始部署");
		expect(html).not.toContain("模型记录");
	});

	it("disables profile selection without a model and surfaces discovery errors", () => {
		const html = picker({ disabled: true, error: "连接失败", discovery: null });
		expect(html).toContain("连接失败");
		expect(html).not.toContain("正在读取部署配置");
		const profiles: DeploymentProfileSummary[] = [{ file: "deploy-a.md", project: "A", target: { host: "example.org" }, modules: [{ id: "api", name: "API" }] }];
		expect(picker({ disabled: true, discovery: { host: "example.org", profiles, errors: [], latest: null, activeDiscussion: null } })).toMatch(/disabled=""[^>]*aria-label="选择 API/);
	});

	it("reviews exact legacy commands and file overwrite targets in Deploy", () => {
		const html = review(run);
		for (const detail of ["npm run build", "/tmp/project/app.tar.gz", "/srv/app/app.tar.gz", "systemctl restart app", "systemctl is-active app"]) expect(html).toContain(detail);
		expect(html).toContain("开始部署");
		expect(html).not.toContain("deploy-logs");
		expect(html).not.toContain("deploy-stage-overview");
	});

	it("reviews every build step and artifact from a model selected plan", () => {
		const next = planned();
		if (next.plan.version !== 2) throw new Error("Expected v2");
		next.plan.buildSteps = [{ cwd: "/tmp/project/common", command: "build-common" }, { cwd: "/tmp/project/api", command: "build-api" }];
		next.plan.artifacts = [{ source: "/tmp/project/common.jar", remotePath: "/srv/app/common.jar" }, { source: "/tmp/project/api.jar", remotePath: "/srv/app/api.jar" }];
		const html = review(next);
		for (const detail of ["build-common", "build-api", "/tmp/project/common.jar", "/srv/app/common.jar", "/tmp/project/api.jar", "/srv/app/api.jar"]) expect(html).toContain(detail);
		expect(review(next, { canConfirm: false })).toMatch(disabledStart);
	});

	it("requires exact per-command human exceptions before confirming a Full Access plan", () => {
		const full: DeploymentRun = { ...run, plan: { ...run.plan, remoteAccess: { mode: "full_access", reason: "deployment_policy" } },
			fullAccessApprovals: {
				restart: { id: "r", stage: "restart", command: run.plan.restart.command, status: "pending", requestedAt: 1 },
				verify: { id: "v", stage: "verify", command: run.plan.verify!.command, status: "pending", requestedAt: 1 },
			} };
		const html = review(full) + permissions(full);
		expect(html).toContain("tester@example.org:22");
		expect(html).toContain("SHA256:test");
		expect(html).toContain('aria-label="批准重启命令使用 Full Access"');
		expect(html).toContain('aria-label="批准验证命令使用 Full Access"');
		expect(html).toMatch(disabledStart);
	});

	it("reviews only the exceptional stage in a mixed plan and permits a fresh human approval", () => {
		const next = planned();
		next.plan = { ...next.plan, remoteAccess: { mode: "full_access", reason: "sandbox_scope_exceeded" },
			restart: { command: "install app.conf /etc/app.conf", writePaths: ["/etc/app.conf"], access: { mode: "full_access", reason: "sandbox_scope_exceeded" } },
			verify: { command: "test -f /srv/app/api.jar", access: { mode: "workspace_write" } } };
		next.fullAccessApprovals = { restart: { id: "r", stage: "restart", command: next.plan.restart.command, status: "pending", requestedAt: 1,
			toolName: "remote_sandbox_exception", reason: "sandbox_scope_exceeded" } };
		expect(permissions(next).match(/批准本条命令/g)).toHaveLength(1);
		expect(review(next)).toMatch(disabledStart);
		next.fullAccessApprovals.restart = { ...next.fullAccessApprovals.restart!, status: "approved", resolvedAt: 2, expiresAt: Date.now() + 60_000 };
		expect(review(next)).not.toMatch(disabledStart);
		next.fullAccessApprovals.restart.expiresAt = 3;
		expect(review(next)).toMatch(disabledStart);
	});

	it("does not ask to renew a completed stage until that stage is invalidated by a rerun", () => {
		const full: DeploymentRun = { ...run, status: "recovering", plan: { ...run.plan, remoteAccess: { mode: "full_access", reason: "deployment_policy" } },
			stages: { ...run.stages, restart: { status: "success", log: "restarted" }, verify: { status: "failed", log: "verification failed" } },
			fullAccessApprovals: { restart: { id: "r", stage: "restart", command: run.plan.restart.command, status: "approved", requestedAt: 1, resolvedAt: 2, expiresAt: 3 },
				verify: { id: "v", stage: "verify", command: run.plan.verify!.command, status: "pending", requestedAt: 4 } } };
		expect(permissions(full)).not.toContain('aria-label="批准重启命令使用 Full Access"');
		expect(permissions(full)).toContain('aria-label="批准验证命令使用 Full Access"');
	});

	it("shows proposed changes but does not gate diagnosis after a later failure", () => {
		const next = planned();
		if (next.plan.version !== 2) throw new Error("Expected v2");
		next.status = "recovering";
		next.stages = { ...next.stages, build: { status: "failed", log: "compiler error" } };
		next.recoveries = [{ id: "repair", stage: "build", reason: "Correct the goal", baseRevision: 1, status: "pending", agentRunId: "agent", proposedAt: 5,
			plan: { ...next.plan, buildSteps: [{ cwd: "/tmp/project", command: "build-corrected" }] } }];
		const pending = review(next);
		expect(pending).toContain("Correct the goal");
		expect(pending).toContain("build-corrected");
		expect(pending).toContain("确认修订");
		expect(pending).not.toContain("继续部署</span>");
		next.recoveries[0]!.status = "approved";
		const failedAgain = review(next);
		expect(failedAgain).toBe("");
		expect(deploymentNeedsReview(next)).toBe(false);
		next.stages = { ...next.stages, build: { status: "pending", log: "" } };
		expect(review(next)).toContain("继续部署</span>");
		expect(deploymentNeedsReview(next)).toBe(true);
	});

	it("does not show a repair choice or mark action required for a failed stage", () => {
		const failed: DeploymentRun = { ...planned(), status: "recovering", stages: { ...run.stages, build: { status: "failed", log: "compiler error" } } };
		expect(review(failed)).toBe("");
		expect(deploymentNeedsReview(failed)).toBe(false);
	});

	it.each(["rejected", "approved"] as const)("does not restore a repair-choice card from an old %s proposal", (status) => {
		const failed = planned();
		if (failed.plan.version !== 2) throw new Error("Expected v2");
		failed.status = "recovering";
		failed.stages = { ...failed.stages, verify: { status: "failed", log: "HTTP 503" } };
		failed.recoveries = [{ id: "old", stage: "verify", reason: "Previous repair", baseRevision: 1, status, agentRunId: "agent", proposedAt: 5, resolvedAt: 6, plan: failed.plan }];
		expect(review(failed)).toBe("");
		expect(deploymentNeedsReview(failed)).toBe(false);
	});
});

describe("deployment history projection", () => {
	const card: ChatTimelineEntry = { key: "card", sequence: 2, final: true, message: { role: "custom", customType: "deployment", content: "API", display: true, timestamp: 2,
		details: { deploymentId: "run-1", title: "API", outcome: "success", startedAt: 1, finishedAt: 2 } } };
	it("renders the backend order without synthesizing entries from a separate catalog", () => {
		const before: ChatTimelineEntry = { key: "before", sequence: 1, final: true, message: { role: "user", content: "Before", timestamp: 3 } };
		expect(historyKeys(conversationHistory([before, card]))).toEqual(["before", "card"]);
		expect(timeline([before])).not.toContain("deployment-history-card");
		expect(timeline([before, card])).toContain('class="deployment-history-card-title" title="API">API</span>');
	});
	it("keeps planning, execution and diagnostic model prose in the main conversation", () => {
		const messages: ChatTimelineEntry[] = ["planner", "execute", "diagnose"].map((runId, index) => ({ key: runId, runId, final: true,
			message: { role: "assistant", content: [{ type: "text", text: `reply-${runId}` }], provider: "test", model: "test", stopReason: "stop", timestamp: 4 + index } }));
		const html = timeline([...messages, card]);
		for (const name of ["planner", "execute", "diagnose"]) expect(html.match(new RegExp(`reply-${name}`, "g"))).toHaveLength(1);
		expect(html).not.toContain("模型记录");
	});
	it("does not show a card-only intermediate state before initial history finishes loading", () => {
		expect(timeline([card], { loading: true })).not.toContain('data-deployment-id=');
		expect(timeline([card], { loading: false })).toContain('data-deployment-id="run-1"');
	});
	it("keeps a tool approval in the main timeline beside its tool call", () => {
		const message: ChatTimelineEntry = { key: "tool", runId: "agent", final: true, message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "remote_server_call", arguments: { command: "id" } }], provider: "test", model: "test", stopReason: "toolUse", timestamp: 4 } };
		const html = timeline([message, card], { approvals: { approval: { id: "approval", sessionId: "session-1", runId: "agent", assistantMessageId: "message", toolCallId: "call", toolName: "remote_server_call", description: "需要审批", status: "pending", createdAt: 4 } } });
		expect(html).toContain("需要审批");
		expect(html).toContain("批准远程执行");
	});
});
