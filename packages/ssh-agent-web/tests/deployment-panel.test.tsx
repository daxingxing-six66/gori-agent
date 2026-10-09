import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { DeploymentPanel } from "../features/deploy/components/deployment-panel";
import { deploymentModuleOptions } from "../features/deploy/components/deployment-module-picker";
import { ChatTimeline } from "../features/chat/components/chat-timeline";
import { DeploymentHistoryCard } from "../features/deploy/components/deployment-history-card";
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

const base = { loading: false, busy: false, planning: false, error: null, canSetup: true, canPlan: true, canConfirm: true, canRecover: true, onClose: noop, onPlan: noop,
	onConfirm: noop, onDecideFullAccess: noop, onDecideRecovery: noop, onDiscussRecovery: noop, onCancel: noop, onCancelDiscussion: noop, onRefresh: noop, onNewPlan: noop, onSetup: noop };

function render(props: Partial<Parameters<typeof DeploymentPanel>[0]>) {
	return renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
		<DeploymentPanel {...base} discovery={{ host: "example.org", profiles: [], errors: [], latest: null, activeDiscussion: null }} run={null} {...props} />
	</IntlProvider>);
}

function historyKeys(history: ReturnType<typeof conversationHistory>): string[] {
	return history.map((entry) => {
		if (entry.kind === "deployment") return entry.run.id;
		if (entry.kind === "discussion") return entry.discussion.id;
		return entry.entry.key;
	});
}

describe("deployment panel", () => {
	it("offers one unselected build module picker across all deployment profiles", () => {
		const profiles: DeploymentProfileSummary[] = [
			{ file: "deploy-a.md", project: "project A", target: { host: "example.org" }, modules: [
				{ id: "api", name: "API" }, { id: "worker", name: "Worker" },
			] },
			{ file: "deploy-b.md", project: "project B", target: { host: "example.org" }, modules: [
				{ id: "api", name: "API" },
			] },
		];
		const options = deploymentModuleOptions(profiles);
		expect(options.map(({ file, moduleId }) => [file, moduleId])).toEqual([
			["deploy-a.md", "api"], ["deploy-a.md", "worker"], ["deploy-b.md", "api"],
		]);
		expect(new Set(options.map((option) => option.key)).size).toBe(3);
		const html = render({ discovery: { host: "example.org", profiles, errors: [], latest: null, activeDiscussion: null } });
		expect(html).toContain("请选择打包模块");
		expect(html).toContain('aria-haspopup="listbox"');
		expect(html).not.toContain('<ol aria-label="部署流水线"');
		expect(html).not.toContain("查看部署计划");
		expect(html).not.toContain("部署配置</label>");
		expect(html).not.toContain("<select");
	});

	it("shows a discussion instead of an empty pipeline after module selection", () => {
		const profiles: DeploymentProfileSummary[] = [{ file: "deploy-a.md", project: "project A", target: { host: "example.org" }, modules: [{ id: "api", name: "API" }] }];
		const html = render({ discovery: { host: "example.org", profiles, errors: [], latest: null, activeDiscussion: discussion }, discussion, planning: true });
		expect(html).toContain("正在讨论本次发布");
		expect(html).toContain("与模型确认发布范围和细节");
		expect(html).toMatch(/>结束讨论<\/button>/);
		expect(html).not.toContain('<ol aria-label="部署流水线"');
		expect(html).not.toContain("开始部署</button>");
	});

	it("keeps module planning disabled until a model is available", () => {
		const profiles: DeploymentProfileSummary[] = [{ file: "deploy-a.md", project: "project A", target: { host: "example.org" }, modules: [{ id: "api", name: "API" }] }];
		const html = render({ discovery: { host: "example.org", profiles, errors: [], latest: null, activeDiscussion: null }, canPlan: false, planHint: "请先选择模型" });
		expect(html).toContain("请先选择模型");
		expect(html).toMatch(/disabled=""[^>]*aria-haspopup="listbox"/);
		expect(html).not.toContain("开始部署</button>");
	});

	it("offers setup when the current host has no profile", () => {
		const html = render({});
		expect(html).toContain("当前主机还没有部署配置");
		expect(html).toContain("创建部署配置");
	});

	it("stops showing a loading message after discovery fails", () => {
		const html = render({ discovery: null, error: "连接失败", loading: false });
		expect(html).toContain("连接失败");
		expect(html).not.toContain("正在读取部署配置");
	});

	it("shows the exact plan and all five pipeline stages before confirmation", () => {
		const html = render({ run });
		expect(html).toContain('<ol aria-label="部署流水线"');
		const stages = ["prepare", "build", "upload", "restart", "verify"];
		const positions = stages.map((stage) => html.indexOf(`data-stage="${stage}"`));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(html).toContain("npm run build");
		expect(html).toContain("/tmp/project/app.tar.gz");
		expect(html).toContain("/srv/app/app.tar.gz");
		expect(html).toContain("systemctl restart app");
		expect(html).toContain("开始部署");
		for (const label of ["准备", "打包", "上传", "重启", "验证"]) expect(html).toContain(label);
	});

	it("shows every model-selected build step and upload artifact before confirmation", () => {
		const html = render({ run: { ...run, plan: {
			version: 2, profilePath: run.plan.profilePath, profileHash: run.plan.profileHash,
			remoteAccess: run.plan.remoteAccess, project: run.plan.project, target: run.plan.target,
			targetBinding: run.plan.targetBinding, module: run.plan.module,
			buildSteps: [
				{ cwd: "/tmp/project/common", command: "npm run build:common" },
				{ cwd: "/tmp/project/api", command: "npm run build:api" },
			],
			artifacts: [
				{ source: "/tmp/project/common.jar", remotePath: "/srv/app/common.jar" },
				{ source: "/tmp/project/api.jar", remotePath: "/srv/app/api.jar" },
			],
			restart: run.plan.restart, verify: run.plan.verify,
		} } });
		for (const detail of ["npm run build:common", "npm run build:api", "/tmp/project/common.jar", "/srv/app/common.jar", "/tmp/project/api.jar", "/srv/app/api.jar"]) expect(html).toContain(detail);
		const first = html.indexOf("/srv/app/common.jar");
		const second = html.indexOf("/srv/app/api.jar");
		expect(first).toBeGreaterThan(0);
		expect(second).toBeGreaterThan(first);
	});

	it("highlights the running pipeline node and keeps its log collapsed by default", () => {
		const html = render({ run: { ...run, status: "running", stages: {
			...run.stages,
			build: { status: "running", log: "Compiling\nFinished module A", progress: { current: 3, total: 4 } },
		} } });
		expect(html).toMatch(/data-stage="build" data-status="running" aria-current="step"/);
		expect(html).toContain("75%");
		expect(html).toMatch(/<progress[^>]*aria-label="打包"/);
		expect(html).toContain('aria-label="查看打包日志"');
		expect(html).toMatch(/<details[^>]*><summary[^>]*>查看阶段日志/);
		expect(html).not.toContain('<details open=""');
	});

	it("shows a failed node beside its error without duplicating the same run error", () => {
		const message = "Remote command exited with a non-zero status";
		const html = render({ run: { ...run, status: "failed", error: message, stages: {
			...run.stages, restart: { status: "failed", log: "restart failed", error: message, exitCode: 1, failureCode: "remote_exit_non_zero", operationId: "operation-1" },
		} } });
		expect(html).toMatch(/data-stage="restart" data-status="failed"/);
		expect(html.match(/Remote command exited with a non-zero status/g)).toHaveLength(1);
		expect(html).toContain("退出码 1");
		expect(html).toContain("错误码 remote_exit_non_zero");
		expect(html).toContain("命令记录 operation-1");
	});

	it("keeps failed commands and prior attempts in closed details while surfacing the repair decision", () => {
		if (run.plan.version === 2) throw new Error("Expected legacy fixture");
		const { build: _build, upload: _upload, ...common } = run.plan;
		const plan = { ...common, version: 2 as const,
			buildSteps: [{ cwd: "/tmp/project", command: "npm run build" }],
			artifacts: [{ source: "/tmp/project/app.tar.gz", remotePath: "/srv/app/app.tar.gz" }] };
		const repaired = { ...plan, buildSteps: [{ cwd: "/tmp/project", command: "npm run build -- --fix" }] };
		const failed = { status: "failed" as const, log: "compiler error", error: "Build exited with status 1" };
		const recovering: DeploymentRun = { ...run, status: "recovering", plan, initialPlan: plan,
			startedAt: 3, updatedAt: 6, agentRunId: "agent-1", agentRunHistory: ["agent-1"], planRevision: 1,
			stages: { ...run.stages, build: failed },
			stageAttempts: { build: [{ agentRunId: "agent-1", planRevision: 1, result: failed }] },
			recoveries: [{ id: "repair-1", stage: "build", reason: "Fix the build goal", plan: repaired,
				baseRevision: 1, status: "pending", agentRunId: "agent-1", proposedAt: 5 }],
		};
		const html = render({ run: recovering });
		expect(html).toContain("待确认修订");
		expect(html).toContain("Build exited with status 1");
		expect(html).toContain("Fix the build goal");
		expect(html).toContain("npm run build -- --fix");
		expect(html).not.toContain('<details open=""');
		expect(html).toContain("确认修订");
		expect(html).not.toContain("继续部署</button>");
	});

	it("shows a restored cancelled run without a deploy confirmation button", () => {
		const html = render({ run: { ...run, status: "cancelled" } });
		expect(html).toContain("部署已取消");
		expect(html).toContain("选择新的模块");
		expect(html).not.toContain("开始部署</button>");
	});

	it("shows per-command Full Access actions and blocks deployment before approval", () => {
		const full: DeploymentRun = { ...run,
			plan: { ...run.plan, remoteAccess: { mode: "full_access", reason: "deployment_policy" } },
			fullAccessApprovals: {
				restart: { id: "a1", stage: "restart", command: run.plan.restart.command, status: "pending", requestedAt: 1 },
				verify: { id: "a2", stage: "verify", command: run.plan.verify!.command, status: "pending", requestedAt: 1 },
			},
		};
		const html = render({ run: full });
		expect(html).toContain("远端 Full Access 命令需逐条批准");
		expect(html).toContain("此命令使用 Full Access");
		expect(html).toContain("tester@example.org:22");
		expect(html).toContain("SHA256:test");
		expect(html.match(/批准本条命令/g)).toHaveLength(2);
		expect(html).toContain('aria-label="批准重启命令使用 Full Access"');
		expect(html).toContain('aria-label="批准验证命令使用 Full Access"');
		expect(html).toContain("还有 2 条远端命令待批准");
		expect(html).toContain("开始部署");
		expect(html).toMatch(/disabled=""[^>]*>开始部署/);
	});

	it("reviews only the exceptional remote stage in a mixed v2 plan", () => {
		if (run.plan.version === 2) throw new Error("Expected legacy fixture");
		const { build: _build, upload: _upload, ...common } = run.plan;
		const plan = { ...common, version: 2 as const,
			remoteAccess: { mode: "full_access" as const, reason: "sandbox_scope_exceeded" as const },
			buildSteps: [{ cwd: "/tmp/project", command: "npm run build" }],
			artifacts: [{ source: "/tmp/project/app.tar.gz", remotePath: "/srv/app/app.tar.gz" }],
			restart: { command: "install app.conf /etc/app.conf", writePaths: ["/etc/app.conf"],
				access: { mode: "full_access" as const, reason: "sandbox_scope_exceeded" as const } },
			verify: { command: "test -f /srv/app/app.tar.gz", writePaths: ["/srv/app/app.tar.gz"],
				access: { mode: "workspace_write" as const } },
		};
		const approval = { id: "restart-approval", stage: "restart" as const, command: plan.restart.command,
			status: "pending" as const, requestedAt: 1, toolName: "remote_sandbox_exception" as const,
			reason: "sandbox_scope_exceeded" as const };
		const mixed: DeploymentRun = { ...run, plan, fullAccessApprovals: { restart: approval } };
		const pending = render({ run: mixed });
		expect(pending).toContain("仅标记的远端命令使用 Full Access");
		expect(pending).toContain("此命令已声明的写入路径超出沙箱可写范围");
		expect(pending).toContain("沙箱例外 · Full Access");
		expect(pending.match(/批准本条命令/g)).toHaveLength(1);
		expect(pending).toContain("还有 1 条远端命令待批准");
		expect(pending).toMatch(/disabled=""[^>]*>开始部署/);
		const approved = render({ run: { ...mixed, fullAccessApprovals: { restart: {
			...approval, status: "approved", resolvedAt: 2, expiresAt: Date.now() + 60_000,
		} } } });
		expect(approved).not.toMatch(/disabled=""[^>]*>开始部署/);
		expect(approved).not.toContain("还有 1 条远端命令待批准");
	});

	it("requires two approvals when both v2 remote stages exceed sandbox scope", () => {
		if (run.plan.version === 2) throw new Error("Expected legacy fixture");
		const { build: _build, upload: _upload, ...common } = run.plan;
		const access = { mode: "full_access" as const, reason: "sandbox_scope_exceeded" as const };
		const plan = { ...common, version: 2 as const, remoteAccess: access,
			buildSteps: [{ cwd: "/tmp/project", command: "npm run build" }],
			artifacts: [{ source: "/tmp/project/app.tar.gz", remotePath: "/srv/app/app.tar.gz" }],
			restart: { command: "install app.conf /etc/app.conf", access },
			verify: { command: "install status.txt /etc/status.txt", access },
		};
		const full: DeploymentRun = { ...run, plan, fullAccessApprovals: {
			restart: { id: "r", stage: "restart", command: plan.restart.command, status: "pending", requestedAt: 1,
				toolName: "remote_sandbox_exception", reason: "sandbox_scope_exceeded" },
			verify: { id: "v", stage: "verify", command: plan.verify.command, status: "pending", requestedAt: 1,
				toolName: "remote_sandbox_exception", reason: "sandbox_scope_exceeded" },
		} };
		const html = render({ run: full });
		expect(html.match(/批准本条命令/g)).toHaveLength(2);
		expect(html).toContain("还有 2 条远端命令待批准");
	});

	it("does not request renewed approval for an already completed remote stage", () => {
		const full: DeploymentRun = { ...run, status: "recovering",
			plan: { ...run.plan, remoteAccess: { mode: "full_access", reason: "deployment_policy" } },
			stages: { ...run.stages, restart: { status: "success", log: "restarted" }, verify: { status: "failed", log: "verification failed" } },
			fullAccessApprovals: {
				restart: { id: "restart-old", stage: "restart", command: run.plan.restart.command,
					status: "approved", requestedAt: 1, resolvedAt: 2, expiresAt: 3 },
				verify: { id: "verify-new", stage: "verify", command: run.plan.verify!.command,
					status: "pending", requestedAt: 4 },
			},
		};
		const html = render({ run: full });
		expect(html).not.toContain('aria-label="批准重启命令使用 Full Access"');
		expect(html).toContain('aria-label="批准验证命令使用 Full Access"');
		expect(html).toContain("还有 1 条远端命令待批准");
	});

	it("shows deployment history chronologically and expands old plans read-only", () => {
		const messages: ChatTimelineEntry[] = [
			{ key: "before", message: { role: "user", content: "before", timestamp: 1 }, final: true },
			{ key: "after", message: { role: "user", content: "after", timestamp: 3 }, final: true },
		];
		expect(historyKeys(conversationHistory(messages, [run])))
			.toEqual(["before", "run-1", "after"]);
		expect(historyKeys(conversationHistory(messages, [{ ...run, status: "running", startedAt: 4 }])))
			.toEqual(["before", "run-1", "after"]);
		expect(historyKeys(conversationHistory(messages, [{ ...run, status: "running", stages: {
			...run.stages, build: { status: "running", log: "", startedAt: 4 },
		} }])))
			.toEqual(["before", "run-1", "after"]);
		const historyHtml = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<DeploymentHistoryCard run={run} onOpen={noop} />
		</IntlProvider>);
		expect(historyHtml).toContain("部署记录");
		expect(historyHtml).toContain("API · example.org");
		const readonly = render({ run, readOnly: true });
		expect(readonly).toContain("部署流水线");
		expect(readonly).not.toContain("开始部署</button>");
		const timeline = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false} timeline={[]} tools={{}} approvals={{}}
				approvalMutationId={null} run={null} latestUserText="" onResolveApproval={noop} onRestoreDraft={noop}
				deployments={[run]} expandedDeploymentId={null} expandedDeployment={null} onOpenDeployment={noop} />
		</IntlProvider>);
		expect(timeline).toContain("部署记录");
		expect(timeline).not.toContain("从这里开始一次远程协作");
	});

	it("groups only messages from the bound Agent Run inside the deployment card", () => {
		const linked: DeploymentRun = { ...run, status: "running", agentRunId: "agent-1", startedAt: 3, updatedAt: 3 };
		const messages: ChatTimelineEntry[] = [
			{ key: "before", message: { role: "user", content: "before", timestamp: 1 }, final: true },
			{ key: "agent", runId: "agent-1", message: { role: "assistant", content: [{ type: "text", text: "正在检查构建结果" }], provider: "test", model: "test", stopReason: "stop", timestamp: 4 }, final: true },
			{ key: "other", runId: "agent-2", message: { role: "user", content: "after", timestamp: 5 }, final: true },
		];
		const history = conversationHistory(messages, [linked]);
		expect(historyKeys(history)).toEqual(["before", "run-1", "other"]);
		expect(history[1]).toMatchObject({ kind: "deployment", messages: [{ key: "agent" }] });
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false} timeline={messages} tools={{}} approvals={{}}
				approvalMutationId={null} run={null} latestUserText="" onResolveApproval={noop} onRestoreDraft={noop}
				deployments={[linked]} expandedDeploymentId={linked.id} expandedDeployment={(activity) => <DeploymentPanel {...base} discovery={null} run={linked} readOnly activity={activity} />} />
		</IntlProvider>);
		expect(html).toContain('<section aria-label="模型记录"');
		expect(html).toContain("正在检查构建结果");
		expect(html.indexOf("正在检查构建结果")).toBeGreaterThan(html.indexOf("部署流水线"));
	});

	it("groups model planning and execution messages under their one deployment card", () => {
		const linked: DeploymentRun = { ...run, status: "running", planningAgentRunId: "planner-1", agentRunId: "agent-1", startedAt: 3, updatedAt: 6 };
		const messages: ChatTimelineEntry[] = [
			{ key: "plan", runId: "planner-1", message: { role: "assistant", content: [{ type: "text", text: "构建两个产物" }], provider: "test", model: "test", stopReason: "stop", timestamp: 3 }, final: true },
			{ key: "execute", runId: "agent-1", message: { role: "assistant", content: [{ type: "text", text: "正在上传" }], provider: "test", model: "test", stopReason: "stop", timestamp: 4 }, final: true },
		];
		const history = conversationHistory(messages, [linked]);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({ kind: "deployment", messages: [{ key: "plan" }, { key: "execute" }] });
	});

	it("shows a successful deployment's final model summary in the main chat timeline", () => {
		const linked: DeploymentRun = { ...run, status: "success", agentRunId: "agent-1", startedAt: 3, updatedAt: 9, finishedAt: 9,
			stages: Object.fromEntries(Object.keys(run.stages).map((stage) => [stage, { status: "success", log: "" }])) as DeploymentRun["stages"] };
		const messages: ChatTimelineEntry[] = [
			{ key: "progress", runId: "agent-1", message: { role: "assistant", content: [
				{ type: "text", text: "正在执行验证" },
				{ type: "toolCall", id: "verify-call", name: "deployment_execute_next", arguments: { stage: "verify" } },
			], provider: "test", model: "test", stopReason: "toolUse", timestamp: 4 }, final: true },
			{ key: "verify-result", runId: "agent-1", message: { role: "toolResult", toolCallId: "verify-call", toolName: "deployment_execute_next",
				content: [{ type: "text", text: "verification passed" }], isError: false, timestamp: 5 }, final: true },
			{ key: "summary", runId: "agent-1", message: { role: "assistant", content: [{ type: "text", text: "部署完成，验证通过" }],
				provider: "test", model: "test", stopReason: "stop", timestamp: 8 }, final: true },
		];
		const history = conversationHistory(messages, [linked]);
		expect(historyKeys(history)).toEqual(["run-1", "summary"]);
		expect(history[0]).toMatchObject({ kind: "deployment", messages: [{ key: "progress" }, { key: "verify-result" }] });
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false} timeline={messages} tools={{}} approvals={{}}
				approvalMutationId={null} run={null} latestUserText="" onResolveApproval={noop} onRestoreDraft={noop}
				deployments={[linked]} expandedDeploymentId={linked.id} expandedDeployment={(activity) => <DeploymentPanel {...base} discovery={null} run={linked} readOnly activity={activity} />} />
		</IntlProvider>);
		expect(html.match(/部署完成，验证通过/g)).toHaveLength(1);
		expect(html).toContain("max-h-[34rem]");
	});

	it("keeps failed or unfinished execution replies within the workflow", () => {
		const reply: ChatTimelineEntry = { key: "reply", runId: "agent-1", message: { role: "assistant",
			content: [{ type: "text", text: "构建失败，正在诊断" }], provider: "test", model: "test", stopReason: "stop", timestamp: 4 }, final: true };
		for (const status of ["running", "failed", "recovering"] as const) {
			const linked: DeploymentRun = { ...run, status, agentRunId: "agent-1", startedAt: 3, updatedAt: 5,
				...(status === "running" ? {} : { finishedAt: 5 }) };
			expect(conversationHistory([reply], [linked])).toMatchObject([{ kind: "deployment", messages: [{ key: "reply" }] }]);
		}
	});

	it("keeps diagnosis and retry messages inside the original deployment card", () => {
		const linked: DeploymentRun = { ...run, status: "running", agentRunId: "retry-1",
			agentRunHistory: ["execute-1", "diagnose-1", "retry-1"], startedAt: 3, updatedAt: 7 };
		const messages: ChatTimelineEntry[] = ["execute-1", "diagnose-1", "retry-1"].map((runId, index) => ({
			key: runId, runId, message: { role: "user", content: runId, timestamp: 4 + index }, final: true,
		}));
		expect(conversationHistory(messages, [linked])).toMatchObject([
			{ kind: "deployment", messages: [{ key: "execute-1" }, { key: "diagnose-1" }, { key: "retry-1" }] },
		]);
	});

	it("keeps discussion messages in chat until a plan has been proposed", () => {
		const message: ChatTimelineEntry = { key: "plan", runId: "planner-1", message: {
			role: "assistant", content: [{ type: "text", text: "规划两个构建包" }], provider: "test", model: "test", stopReason: "stop", timestamp: 3,
		}, final: true };
		const timeline = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false} timeline={[message]} tools={{}} approvals={{}}
			approvalMutationId={null} run={null} latestUserText="" onResolveApproval={noop} onRestoreDraft={noop} />
		</IntlProvider>);
		const panel = render({ discussion });
		expect(timeline).toContain("规划两个构建包");
		expect(panel).toContain("正在讨论本次发布");
		expect(panel).not.toContain("规划两个构建包");
		expect(panel).not.toContain('<ol aria-label="部署流水线"');
	});

	it("restores the selected module card between older chat and persisted planning messages", () => {
		const restoredDiscussion: DeploymentDiscussion = { ...discussion, createdAt: 20, updatedAt: 20 };
		const persistedMessages: ChatTimelineEntry[] = [
			{ key: "older", message: { role: "user", content: "先前的普通聊天", timestamp: 10 }, final: true },
			{ key: "request", runId: "planner-1", message: { role: "user", content: "请检查这次发布范围", timestamp: 21 }, final: true },
			{ key: "reply", runId: "planner-1", message: { role: "assistant", content: [{ type: "text", text: "先检查构建产物" }],
				provider: "test", model: "test", stopReason: "stop", timestamp: 30 }, final: true },
		];
		expect(historyKeys(conversationHistory(persistedMessages, [], restoredDiscussion)))
			.toEqual(["older", "discussion-1", "request", "reply"]);
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false} timeline={persistedMessages} tools={{}} approvals={{}}
				approvalMutationId={null} run={null} latestUserText="" onResolveApproval={noop} onRestoreDraft={noop}
				discussion={restoredDiscussion} discussionPanel={<DeploymentPanel {...base} discovery={null} discussion={restoredDiscussion} run={null} />} />
		</IntlProvider>);
		const older = html.indexOf("先前的普通聊天");
		const card = html.indexOf('data-deployment-discussion-id="discussion-1"');
		const request = html.indexOf("请检查这次发布范围");
		const reply = html.indexOf("先检查构建产物");
		expect(older).toBeGreaterThan(-1);
		expect(card).toBeGreaterThan(older);
		expect(html).toContain("正在讨论本次发布");
		expect(request).toBeGreaterThan(card);
		expect(reply).toBeGreaterThan(request);
		expect(html.match(/data-deployment-discussion-id=/g)).toHaveLength(1);
	});

	it("places a newly selected module card before planning messages with the same timestamp", () => {
		const selected: DeploymentDiscussion = { ...discussion, createdAt: 20, updatedAt: 20 };
		const messages: ChatTimelineEntry[] = [
			{ key: "same-time", runId: "planner-1", message: { role: "user", content: "同毫秒的讨论消息", timestamp: 20 }, final: true },
			{ key: "older", message: { role: "user", content: "更早的消息", timestamp: 10 }, final: true },
		];
		expect(historyKeys(conversationHistory(messages, [], selected)))
			.toEqual(["older", "discussion-1", "same-time"]);
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false} timeline={messages} tools={{}} approvals={{}}
				approvalMutationId={null} run={null} latestUserText="" onResolveApproval={noop} onRestoreDraft={noop}
				discussion={selected} discussionPanel={<DeploymentPanel {...base} discovery={null} discussion={selected} run={null} />} />
		</IntlProvider>);
		expect(html.indexOf('data-deployment-discussion-id="discussion-1"')).toBeGreaterThan(html.indexOf("更早的消息"));
		expect(html.indexOf("同毫秒的讨论消息")).toBeGreaterThan(html.indexOf('data-deployment-discussion-id="discussion-1"'));
	});

	it("replaces the discussion card with one deployment card when its proposal run is available", () => {
		const proposed: DeploymentDiscussion = { ...discussion, status: "proposed", deploymentRunId: run.id, updatedAt: 3 };
		const linked: DeploymentRun = { ...run, discussionId: proposed.id, planningAgentRunId: "planner-1" };
		const planningMessage: ChatTimelineEntry = { key: "planning-result", runId: "planner-1", message: {
			role: "assistant", content: [{ type: "text", text: "规划产物已经确定" }], provider: "test", model: "test", stopReason: "stop", timestamp: 4,
		}, final: true };
		// ChatConsole passes no inline discussion once the selected Deployment Run is loaded.
		expect(historyKeys(conversationHistory([planningMessage], [linked], null))).toEqual(["run-1"]);
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false} timeline={[planningMessage]} tools={{}} approvals={{}}
				approvalMutationId={null} run={null} latestUserText="" onResolveApproval={noop} onRestoreDraft={noop}
				deployments={[linked]} discussion={null} expandedDeploymentId={linked.id}
				expandedDeployment={(activity) => <DeploymentPanel {...base} discovery={null} discussion={proposed} run={linked} readOnly activity={activity} />} />
		</IntlProvider>);
		expect(html).not.toContain("data-deployment-discussion-id=");
		expect(html.match(/data-deployment-id=/g)).toHaveLength(1);
		expect(html).toContain("规划产物已经确定");
		// The expanded card includes a text preview and a details copy of the same message.
		expect(html.match(/chat-assistant-message/g)).toHaveLength(1);
		expect(html.indexOf("chat-assistant-message")).toBeGreaterThan(html.indexOf('data-deployment-id="run-1"'));
	});

	it("leaves ambiguous Agent links ungrouped and keeps pending approvals visible on collapsed cards", () => {
		const linked: DeploymentRun = { ...run, status: "running", agentRunId: "agent-1", startedAt: 3, updatedAt: 3 };
		const toolMessage: ChatTimelineEntry = { key: "agent-tool", runId: "agent-1", message: {
			role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "remote_server_call", arguments: { command: "id" } }],
			provider: "test", model: "test", stopReason: "toolUse", timestamp: 4,
		}, final: true };
		const duplicate: DeploymentRun = { ...linked, id: "run-2" };
		expect(conversationHistory([toolMessage], [linked, duplicate]).filter((entry) => entry.kind === "message")).toHaveLength(1);
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false} timeline={[toolMessage]} tools={{}}
				approvals={{ "approval-1": { id: "approval-1", sessionId: "session-1", runId: "agent-1", assistantMessageId: "message-1", toolCallId: "tool-1", toolName: "remote_server_call", description: "需要审批", status: "pending", createdAt: 4 } }}
				approvalMutationId={null} run={null} latestUserText="" onResolveApproval={noop} onRestoreDraft={noop}
				deployments={[linked]} expandedDeploymentId={null} expandedDeployment={null} onOpenDeployment={noop} />
		</IntlProvider>);
		expect(html).toContain("需要审批");
		expect(html).toContain("批准远程执行");
	});

	it("labels loaded model activity as partial while older chat messages remain paginated", () => {
		const linked: DeploymentRun = { ...run, status: "success", agentRunId: "agent-1", startedAt: 3, updatedAt: 4, finishedAt: 4 };
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false} hasOlderMessages timeline={[]} tools={{}} approvals={{}}
				approvalMutationId={null} run={null} latestUserText="" onResolveApproval={noop} onRestoreDraft={noop}
				deployments={[linked]} expandedDeploymentId={linked.id} expandedDeployment={(activity) => <DeploymentPanel {...base} discovery={null} run={linked} readOnly activity={activity} />} />
		</IntlProvider>);
		expect(html).toContain("仅显示已加载的模型记录");
	});
});
