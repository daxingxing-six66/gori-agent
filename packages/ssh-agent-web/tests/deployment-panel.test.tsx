import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { DeploymentReview } from "../features/deploy/components/deployment-review";
import { DeploymentTaskPage } from "../features/deploy/components/deployment-task-page";
import { deploymentModuleOptions } from "../features/deploy/components/deployment-module-picker";
import { ChatTimeline } from "../features/chat/components/chat-timeline";
import { DeploymentLogStore } from "../features/deploy/runtime/deployment-log-store";
import { conversationHistory } from "../features/deploy/model/deployment-history";
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
		discovery={{ host: "example.org", profiles: [], errors: [], latest: null, activeDiscussion: null }} logs={new DeploymentLogStore("session-1")}
		loading={false} busy={false} error={null} canPlan fullscreen={false} pending={false} onPlan={noop} onSetup={noop}
		onReturnConversation={noop} onSubmit={async () => true} {...props} />);
}
function review(value: DeploymentRun, props: Partial<Parameters<typeof DeploymentReview>[0]> = {}) {
	return localize(<DeploymentReview run={value} busy={false} canConfirm onConfirm={noop}
		onDecideFullAccess={noop} onDecideRecovery={noop} onDiscussRecovery={noop} {...props} />);
}
function timeline(messages: ChatTimelineEntry[], deployments: DeploymentRun[], extra: Partial<Parameters<typeof ChatTimeline>[0]> = {}) {
	return localize(<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false} timeline={messages} tools={{}} approvals={{}}
		approvalMutationId={null} run={null} latestUserText="" onResolveApproval={noop} onRestoreDraft={noop}
		deployments={deployments} onOpenDeployment={noop} {...extra} />);
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

describe("deployment task and conversation review", () => {
	it("keeps profile selection unselected and distinguishes identical module ids across profiles", () => {
		const profiles: DeploymentProfileSummary[] = [
			{ file: "deploy-a.md", project: "A", target: { host: "example.org" }, modules: [{ id: "api", name: "API" }, { id: "worker", name: "Worker" }] },
			{ file: "deploy-b.md", project: "B", target: { host: "example.org" }, modules: [{ id: "api", name: "API" }] },
		];
		const options = deploymentModuleOptions(profiles);
		expect(new Set(options.map((option) => option.key)).size).toBe(3);
		const html = page({ discovery: { host: "example.org", profiles, errors: [], latest: null, activeDiscussion: null } });
		expect(html).toContain("请选择打包模块");
		expect(html).toContain('aria-haspopup="listbox"');
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
		const html = page({ canPlan: false, error: "连接失败", discovery: null });
		expect(html).toContain("连接失败");
		expect(html).not.toContain("正在读取部署配置");
		const profiles: DeploymentProfileSummary[] = [{ file: "deploy-a.md", project: "A", target: { host: "example.org" }, modules: [{ id: "api", name: "API" }] }];
		expect(page({ canPlan: false, discovery: { host: "example.org", profiles, errors: [], latest: null, activeDiscussion: null } })).toMatch(/disabled=""[^>]*aria-haspopup="listbox"/);
	});

	it("reviews exact legacy commands and file overwrite targets in the conversation", () => {
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
		expect(review(next, { canConfirm: false })).toMatch(/disabled=""[^>]*>开始部署/);
	});

	it("requires exact per-command human exceptions before confirming a Full Access plan", () => {
		const full: DeploymentRun = { ...run, plan: { ...run.plan, remoteAccess: { mode: "full_access", reason: "deployment_policy" } },
			fullAccessApprovals: {
				restart: { id: "r", stage: "restart", command: run.plan.restart.command, status: "pending", requestedAt: 1 },
				verify: { id: "v", stage: "verify", command: run.plan.verify!.command, status: "pending", requestedAt: 1 },
			} };
		const html = review(full);
		expect(html).toContain("tester@example.org:22");
		expect(html).toContain("SHA256:test");
		expect(html).toContain('aria-label="批准重启命令使用 Full Access"');
		expect(html).toContain('aria-label="批准验证命令使用 Full Access"');
		expect(html).toMatch(/disabled=""[^>]*>开始部署/);
	});

	it("reviews only the exceptional stage in a mixed plan and permits a fresh human approval", () => {
		const next = planned();
		next.plan = { ...next.plan, remoteAccess: { mode: "full_access", reason: "sandbox_scope_exceeded" },
			restart: { command: "install app.conf /etc/app.conf", writePaths: ["/etc/app.conf"], access: { mode: "full_access", reason: "sandbox_scope_exceeded" } },
			verify: { command: "test -f /srv/app/api.jar", access: { mode: "workspace_write" } } };
		next.fullAccessApprovals = { restart: { id: "r", stage: "restart", command: next.plan.restart.command, status: "pending", requestedAt: 1,
			toolName: "remote_sandbox_exception", reason: "sandbox_scope_exceeded" } };
		expect(review(next).match(/批准本条命令/g)).toHaveLength(1);
		expect(review(next)).toMatch(/disabled=""[^>]*>开始部署/);
		next.fullAccessApprovals.restart = { ...next.fullAccessApprovals.restart!, status: "approved", resolvedAt: 2, expiresAt: Date.now() + 60_000 };
		expect(review(next)).not.toMatch(/disabled=""[^>]*>开始部署/);
		next.fullAccessApprovals.restart.expiresAt = 3;
		expect(review(next)).toMatch(/disabled=""[^>]*>开始部署/);
	});

	it("does not ask to renew a completed stage until that stage is invalidated by a rerun", () => {
		const full: DeploymentRun = { ...run, status: "recovering", plan: { ...run.plan, remoteAccess: { mode: "full_access", reason: "deployment_policy" } },
			stages: { ...run.stages, restart: { status: "success", log: "restarted" }, verify: { status: "failed", log: "verification failed" } },
			fullAccessApprovals: { restart: { id: "r", stage: "restart", command: run.plan.restart.command, status: "approved", requestedAt: 1, resolvedAt: 2, expiresAt: 3 },
				verify: { id: "v", stage: "verify", command: run.plan.verify!.command, status: "pending", requestedAt: 4 } } };
		expect(review(full)).not.toContain('aria-label="批准重启命令使用 Full Access"');
		expect(review(full)).toContain('aria-label="批准验证命令使用 Full Access"');
	});

	it("shows reviewed changes before retry and returns to diagnosis after a later failure", () => {
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
		expect(pending).not.toContain("继续部署</button>");
		next.recoveries[0]!.status = "approved";
		const failedAgain = review(next);
		expect(failedAgain).toContain(zhCNMessages["deploy.recovery.discuss"]);
		expect(failedAgain).not.toContain("继续部署</button>");
	});
});

describe("deployment history projection", () => {
	it("keeps legacy deployment creation position stable after execution starts", () => {
		const messages: ChatTimelineEntry[] = [
			{ key: "before", message: { role: "user", content: "before", timestamp: 1 }, final: true },
			{ key: "after", message: { role: "user", content: "after", timestamp: 3 }, final: true },
		];
		expect(historyKeys(conversationHistory(messages, [run]))).toEqual(["before", "run-1", "after"]);
		expect(historyKeys(conversationHistory(messages, [{ ...run, status: "running", startedAt: 4 }]))).toEqual(["before", "run-1", "after"]);
		expect(timeline([], [run])).toContain("部署记录");
		expect(timeline([], [run])).not.toContain("开始部署</button>");
	});

	it("keeps planning, execution, diagnosis and final text in the main conversation", () => {
		const linked: DeploymentRun = { ...run, status: "success", planningAgentRunId: "planner", agentRunId: "execute", agentRunHistory: ["execute", "diagnose"], startedAt: 3, updatedAt: 9, finishedAt: 9 };
		const messages: ChatTimelineEntry[] = ["planner", "execute", "diagnose"].map((runId, index) => ({ key: runId, runId, final: true,
			message: { role: "assistant", content: [{ type: "text", text: `reply-${runId}` }], provider: "test", model: "test", stopReason: "stop", timestamp: 4 + index } }));
		expect(historyKeys(conversationHistory(messages, [linked]))).toEqual(["run-1", "planner", "execute", "diagnose"]);
		const html = timeline(messages, [linked]);
		for (const name of ["planner", "execute", "diagnose"]) expect(html.match(new RegExp(`reply-${name}`, "g"))).toHaveLength(1);
		expect(html).not.toContain("模型记录");
	});

	it("leaves failed replies visible regardless of the deployment status", () => {
		const reply: ChatTimelineEntry = { key: "reply", runId: "agent", final: true, message: { role: "assistant", content: [{ type: "text", text: "Build failed; diagnosing" }], provider: "test", model: "test", stopReason: "stop", timestamp: 4 } };
		for (const status of ["running", "failed", "recovering"] as const) expect(historyKeys(conversationHistory([reply], [{ ...run, status, agentRunId: "agent" }]))).toEqual(["run-1", "reply"]);
	});

	it("retains a compact legacy discussion entry without an embedded task page", () => {
		const selected = { ...discussion, createdAt: 20, updatedAt: 20 };
		const messages: ChatTimelineEntry[] = [
			{ key: "same", final: true, message: { role: "user", content: "Same timestamp", timestamp: 20 } },
			{ key: "old", final: true, message: { role: "user", content: "Older", timestamp: 10 } },
		];
		expect(historyKeys(conversationHistory(messages, [], selected))).toEqual(["old", discussion.id, "same"]);
		const html = timeline(messages, [], { discussion: selected });
		expect(html).toContain("查看部署 · API");
		expect(html).not.toContain("deploy-task-page");
	});

	it("keeps a tool approval in the main timeline beside its tool call", () => {
		const message: ChatTimelineEntry = { key: "tool", runId: "agent", final: true, message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "remote_server_call", arguments: { command: "id" } }], provider: "test", model: "test", stopReason: "toolUse", timestamp: 4 } };
		const html = timeline([message], [run], { approvals: { approval: { id: "approval", sessionId: "session-1", runId: "agent", assistantMessageId: "message", toolCallId: "call", toolName: "remote_server_call", description: "需要审批", status: "pending", createdAt: 4 } } });
		expect(html).toContain("需要审批");
		expect(html).toContain("批准远程执行");
	});
});
