import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { DeploymentPanel } from "../features/deploy/components/deployment-panel";
import { ChatTimeline } from "../features/chat/components/chat-timeline";
import { DeploymentHistoryCard } from "../features/deploy/components/deployment-history-card";
import { conversationHistory } from "../features/deploy/model/deployment-history";
import type { DeploymentRun } from "../features/deploy/model/deployment";
import type { ChatTimelineEntry } from "../features/chat/model/chat-runtime-state";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";

const noop = () => undefined;
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

const base = { loading: false, busy: false, error: null, canSetup: true, canConfirm: true, onClose: noop, onPrepare: noop,
	onConfirm: noop, onDecideFullAccess: noop, onCancel: noop, onNewPlan: noop, onSetup: noop };

function render(props: Partial<Parameters<typeof DeploymentPanel>[0]>) {
	return renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
		<DeploymentPanel {...base} discovery={{ host: "example.org", profiles: [], errors: [], latest: null }} run={null} {...props} />
	</IntlProvider>);
}

describe("deployment panel", () => {
	it("offers setup when the current host has no profile", () => {
		const html = render({});
		expect(html).toContain("当前主机还没有部署配置");
		expect(html).toContain("创建部署配置");
	});

	it("shows the exact plan and all five pipeline stages before confirmation", () => {
		const html = render({ run });
		expect(html).toContain('<ol aria-label="部署流水线"');
		const stages = ["prepare", "build", "upload", "restart", "verify"];
		const positions = stages.map((stage) => html.indexOf(`data-stage="${stage}"`));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(html).toContain("npm run build");
		expect(html).toContain("本地产物");
		expect(html).toContain("远端目标");
		expect(html).toContain("/srv/app/app.tar.gz");
		expect(html).toContain("systemctl restart app");
		expect(html).toContain("确认并开始部署");
		for (const label of ["准备", "打包", "上传", "重启", "验证"]) expect(html).toContain(label);
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

	it("shows a restored cancelled run without a deploy confirmation button", () => {
		const html = render({ run: { ...run, status: "cancelled" } });
		expect(html).toContain("部署已取消");
		expect(html).toContain("选择新的模块");
		expect(html).not.toContain("确认并开始部署");
	});

	it("shows per-command Full Access actions and blocks deployment before approval", () => {
		const full: DeploymentRun = { ...run,
			plan: { ...run.plan, remoteAccess: { mode: "full_access", reason: "sandbox_unavailable" } },
			fullAccessApprovals: {
				restart: { id: "a1", stage: "restart", command: run.plan.restart.command, status: "pending", requestedAt: 1 },
				verify: { id: "a2", stage: "verify", command: run.plan.verify!.command, status: "pending", requestedAt: 1 },
			},
		};
		const html = render({ run: full });
		expect(html).toContain("远端命令需逐条批准 · Full Access");
		expect(html).toContain("tester@example.org:22");
		expect(html).toContain("SHA256:test");
		expect(html.match(/批准本条命令/g)).toHaveLength(2);
		expect(html).toContain('aria-label="批准重启命令使用 Full Access"');
		expect(html).toContain('aria-label="批准验证命令使用 Full Access"');
		expect(html).toContain("还有 2 条远端命令待批准");
		expect(html).toContain("确认并开始部署");
		expect(html).toMatch(/disabled=""[^>]*>确认并开始部署/);
	});

	it("shows deployment history chronologically and expands old plans read-only", () => {
		const messages: ChatTimelineEntry[] = [
			{ key: "before", message: { role: "user", content: "before", timestamp: 1 }, final: true },
			{ key: "after", message: { role: "user", content: "after", timestamp: 3 }, final: true },
		];
		expect(conversationHistory(messages, [run]).map((entry) => entry.kind === "deployment" ? entry.run.id : entry.entry.key))
			.toEqual(["before", "run-1", "after"]);
		expect(conversationHistory(messages, [{ ...run, status: "running", startedAt: 4 }]).map((entry) => entry.kind === "deployment" ? entry.run.id : entry.entry.key))
			.toEqual(["before", "after", "run-1"]);
		expect(conversationHistory(messages, [{ ...run, status: "running", stages: {
			...run.stages, build: { status: "running", log: "", startedAt: 4 },
		} }]).map((entry) => entry.kind === "deployment" ? entry.run.id : entry.entry.key))
			.toEqual(["before", "after", "run-1"]);
		const historyHtml = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<DeploymentHistoryCard run={run} onOpen={noop} />
		</IntlProvider>);
		expect(historyHtml).toContain("部署记录");
		expect(historyHtml).toContain("API · example.org");
		const readonly = render({ run, readOnly: true });
		expect(readonly).toContain("部署流水线");
		expect(readonly).not.toContain("确认并开始部署");
		const timeline = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}>
			<ChatTimeline showActivity={false} loading={false} loadingOlderMessages={false} timeline={[]} tools={{}} approvals={{}}
				approvalMutationId={null} run={null} latestUserText="" onResolveApproval={noop} onRestoreDraft={noop}
				deployments={[run]} expandedDeploymentId={null} expandedDeployment={null} onOpenDeployment={noop} />
		</IntlProvider>);
		expect(timeline).toContain("部署记录");
		expect(timeline).not.toContain("从这里开始一次远程协作");
	});
});
