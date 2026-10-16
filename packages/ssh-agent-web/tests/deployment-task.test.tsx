import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { DeploymentTaskPage } from "../features/deploy/components/deployment-task-page";
import { DeploymentModulePicker } from "../features/deploy/components/deployment-module-picker";
import { ChatTimeline } from "../features/chat/components/chat-timeline";
import { conversationHistory } from "../features/deploy/model/deployment-history";
import { DeploymentLogStore } from "../features/deploy/runtime/deployment-log-store";
import type { DeploymentRun } from "../features/deploy/model/deployment";
import type { DeploymentTask, DeploymentLogChunk } from "../features/deploy/model/deployment-task";
import type { ChatTimelineEntry } from "../features/chat/model/chat-runtime-state";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";

const run: DeploymentRun = {
	id: "deployment", discussionId: "deployment", sessionId: "session", workspaceId: "workspace", status: "running",
	createdAt: 1, updatedAt: 20, startedAt: 2, agentRunId: "agent", planningAgentRunId: "planning",
	plan: { version: 2, project: "test", module: { id: "api", name: "API" }, profilePath: "/project/.gori/deploy-example.md", profileHash: "a".repeat(64),
		target: { host: "example.org" }, targetBinding: { port: 22, credentialId: "credential", credentialAuthVersion: 1, remoteUser: "test", hostKeyFingerprint: "SHA256:test", writableRoot: "/srv/app" },
		remoteAccess: { mode: "workspace_write" }, buildSteps: [{ cwd: "/project", command: "mvn package" }], artifacts: [{ source: "/project/api.jar", remotePath: "/srv/app/api.jar" }], restart: { command: "restart-api" } },
	stages: { prepare: { status: "success", log: "", finishedAt: 2 }, build: { status: "success", log: "built", finishedAt: 10 },
		upload: { status: "running", log: "", executionId: "upload", logCursor: 3, startedAt: 11,
			artifact: { index: 1, count: 1, source: "/project/api.jar", remotePath: "/srv/app/api.jar", bytesTransferred: 64, totalBytes: 100 } },
		restart: { status: "pending", log: "" }, verify: { status: "pending", log: "" } },
};
const task: DeploymentTask = { deployment: { id: run.id, sessionId: run.sessionId, workspaceId: run.workspaceId, title: "API", createdAt: 1 }, run, phase: "execution", stage: "upload", stageStatus: "running", nextStage: "restart" };
const localized = (element: React.ReactNode) => renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages }, element));

describe("deployment task presentation", () => {
	it("shows the five stable stages and actual artifact bytes without decision controls or model prose", () => {
		const html = localized(createElement(DeploymentTaskPage, { sessionId: "session", task, run, discussion: null,
			logs: new DeploymentLogStore("session"), loading: false, busy: false, error: null, fullscreen: true, pending: true,
			onExit: vi.fn(), onReturnConversation: vi.fn(), onSubmit: async () => true }));
		expect(html.match(/<li data-status=/gu)).toHaveLength(5);
		expect(html).toContain('data-current="true" data-selected="true"');
		expect(html).toContain("64%");
		expect(html).toContain("/srv/app/api.jar");
		expect(html).toContain("补充部署要求…");
		expect(html).toContain("返回对话");
		expect(html).toContain("退出部署");
		expect(html).not.toContain(zhCNMessages["deploy.confirm"]);
		expect(html).not.toContain("2-1");
	});

	it("offers missing service setup even when another service profile exists", () => {
		const html = localized(createElement(DeploymentModulePicker, {
			discovery: { host: "example.org", profiles: [{ file: "deploy-example.md", project: "test", target: { host: "example.org" }, modules: [{ id: "api", name: "API" }] }], errors: [], latest: null, activeDiscussion: null },
			loading: false, busy: false, disabled: false, error: null, onSelect: async () => undefined, onSetup: vi.fn(), onClose: vi.fn(), onRetry: vi.fn() }));
		expect(html).toContain("添加服务配置");
		expect(html).toContain("API");
		expect(html).toContain('role="dialog"');
	});

	it("keeps the formal entry at its Chat sequence position and all model messages in the main timeline", () => {
		const messages: ChatTimelineEntry[] = [
			{ key: "before", final: true, sequence: 10, message: { role: "user", content: "Before", timestamp: 100 } },
			{ key: "deployment", final: true, sequence: 11, message: { role: "custom", customType: "deployment", display: true, content: "API", details: { deploymentId: run.id, title: "Stable title" }, timestamp: 50 } },
			{ key: "diagnosis", final: true, runId: "agent", sequence: 12, message: { role: "assistant", content: [{ type: "text", text: "Diagnose in the main conversation" }], provider: "test", model: "test", stopReason: "stop", timestamp: 51 } },
		];
		const projected = conversationHistory(messages);
		expect(projected.map((entry) => entry.kind)).toEqual(["message", "deploymentMessage", "message"]);
		const html = localized(createElement(ChatTimeline, { timeline: messages, showActivity: false, loading: false,
			loadingOlderMessages: false, tools: {}, approvals: {}, approvalMutationId: null, run: null, latestUserText: "", onResolveApproval: vi.fn(), onRestoreDraft: vi.fn(), onOpenDeployment: vi.fn() }));
		expect(html).toContain("Stable title");
		expect(html).toContain("Diagnose in the main conversation");
		expect(html).not.toContain("deploy-model");
	});
});

describe("deployment log cache", () => {
	it("deduplicates SSE against REST history and fills gaps from the durable cursor", async () => {
		const chunk = (sequence: number): DeploymentLogChunk => ({ deploymentRunId: run.id, executionId: "build", stage: "build", sequence, timestamp: sequence, kind: "output", text: `${sequence}\n` });
		let complete!: (value: { chunks: DeploymentLogChunk[]; nextSequence: number; hasMore: boolean }) => void;
		const read = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
			.mockResolvedValueOnce({ chunks: [chunk(3)], nextSequence: 3, hasMore: false });
		const store = new DeploymentLogStore("session", read);
		const loading = store.load(run.id, "build");
		store.append(chunk(3)); store.append(chunk(3));
		complete({ chunks: [chunk(1), chunk(2), chunk(3)], nextSequence: 3, hasMore: false });
		await loading;
		expect(store.snapshot(run.id, "build").chunks.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
		await store.load(run.id, "build");
		expect(read.mock.calls[1]).toEqual(["session", run.id, "build", 3]);
	});
});
