import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDeploymentRoute } from "../src/api/deployment-routes.ts";
import { DeploymentModeService } from "../src/application/services/deployment-mode-service.ts";
import { DeploymentService } from "../src/application/services/deployment-service.ts";
import { RemoteSandboxApprovalStore } from "../src/application/services/remote-sandbox-approval-store.ts";
import { WorkspaceEventHub } from "../src/application/workspace-event-hub.ts";
import { deploymentProviderMessages } from "../src/application/deployment-runtime-context.ts";
import { createChatContext } from "../src/application/chat-context.ts";
import { modelVisibleMessages } from "../src/application/deployment-history-message.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteChatRepository } from "../src/infrastructure/sqlite/sqlite-chat-repository.ts";
import { SqliteDeploymentDiscussionRepository } from "../src/infrastructure/sqlite/sqlite-deployment-discussion-repository.ts";
import { SqliteDeploymentRepository } from "../src/infrastructure/sqlite/sqlite-deployment-repository.ts";
import { SqliteDeploymentSessionRepository } from "../src/infrastructure/sqlite/sqlite-deployment-session-repository.ts";
import { SqliteDeploymentExecutionRepository } from "../src/infrastructure/sqlite/sqlite-deployment-execution-repository.ts";
import { SqliteTransactionRunner } from "../src/infrastructure/sqlite/sqlite-transaction-runner.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function harness(options: { sandboxEnabled?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "gori-deploy-mode-"));
	await mkdir(join(root, ".gori"));
	await writeFile(join(root, ".gori", "deploy-example.org.md"), `---
version: 2
project: test
target:
  host: example.org
connection:
  profile: current
modules:
  - id: api
    name: API
    workdir: .
    build:
      instructions: Build the API
    upload:
      allowedDirectories:
        - /srv/api
    restart:
      instructions: Restart the API
---
`);
	const database = new DatabaseSync(join(root, "state.sqlite"));
	database.exec("PRAGMA foreign_keys = ON");
	applyMigrations(database);
	database.exec(`INSERT INTO workspaces (id, display_name, environment, hostname, port, default_cwd,
		connect_timeout_ms, keepalive_interval_ms, keepalive_max_count, revision, created_at, updated_at)
		VALUES ('workspace', 'test', 'development', 'example.org', 22, '/srv/api', 1000, 1000, 3, 1, 1, 1);
		INSERT INTO sessions (id, workspace_id, display_name, revision, created_at, updated_at)
		VALUES ('session', 'workspace', 'test', 1, 1, 1);`);
	const transactions = new SqliteTransactionRunner(database);
	const sessions = new SqliteDeploymentSessionRepository(database);
	const discussions = new SqliteDeploymentDiscussionRepository(database);
	const runs = new SqliteDeploymentRepository(database);
	const executions = new SqliteDeploymentExecutionRepository(database);
	const events = new WorkspaceEventHub();
	const modes = new DeploymentModeService({ sessions, discussions, runs, transactions, events });
	const target = { workspaceId: "workspace", workspaceRevision: 1, hostname: "example.org", port: 22,
		hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "SHA256:test", credentialId: "credential",
		credentialAuthVersion: 1, remoteUser: "test", sandboxWritableRoots: ["/srv/api"] };
	const submit = vi.fn(async () => ({ operation: { id: "operation", status: "completed", exitCode: 0 } }));
	const service = new DeploymentService({
		sessions: { findById: async () => ({ id: "session", workspaceId: "workspace", workDir: root,
			sandboxEnabled: options.sandboxEnabled ?? false }) } as never,
		workspaces: { findById: async () => ({ id: "workspace", host: { hostname: "example.org" } }) } as never,
		targets: { resolve: async () => target } as never,
		commands: { preflightGuard: async () => ({ allowed: true }), submit } as never,
		transfers: { listDirectory: async (_workspace: string, path: string) => ({ path, entries: [] }),
			create: async () => ({ id: "transfer", target }), upload: async () => ({ status: "completed", bytesTransferred: 5 }),
			get: async () => ({ bytesTransferred: 5 }) } as never,
		sandboxApprovals: new RemoteSandboxApprovalStore(), repository: runs, discussions, modes, executions, transactions, events, localCwd: root,
	});
	cleanups.push(async () => { await service.close(); events.close(); database.close(); await rm(root, { recursive: true, force: true }); });
	const begin = () => service.beginDiscussion("session", "deploy-example.org.md", "api");
	const propose = async (command = "printf ready > api.jar") => {
		const discussion = await begin();
		const binding = await service.bindPlanningRun("session", discussion.id, "planning");
		return service.proposeForDiscussion("session", discussion.id, binding.revision, "planning", {
			buildSteps: [{ workdir: ".", command }],
			artifacts: [{ source: "api.jar", target: "/srv/api/api.jar" }], restart: { command: "restart-api" },
		}, new AbortController().signal);
	};
	return { root, database, sessions, discussions, runs, executions, events, modes, service, begin, propose, submit };
}

describe("durable deployment mode", () => {
	it.each(["failed", "cancelled"] as const)("moves the same formal message to the %s finish boundary even without a plan", async (outcome) => {
		const { database, begin, service, events } = await harness();
		const publish = vi.spyOn(events, "publish");
		const discussion = await begin();
		const repository = new SqliteChatRepository(database);
		const initial = repository.listMessages("session")[0]!;
		const text = JSON.stringify({ role: "user", content: "Discuss before finishing", timestamp: Date.now() });
		database.prepare("INSERT INTO chat_messages (id,session_id,sequence,message_type,message_json,created_at) VALUES ('discussion-text','session',2,'user',?,?)").run(text, Date.now());
		const finished = await service.finishDeployment("session", discussion.id, outcome, "User requested an end");
		const history = repository.listMessages("session");
		expect(history.map((entry) => entry.id)).toEqual(["discussion-text", initial.id]);
		expect(history[1]).toMatchObject({ sequence: 3, createdAt: finished.deployment.finishedAt,
			message: { timestamp: finished.deployment.finishedAt, details: { position: "finished", outcome, finishedAt: finished.deployment.finishedAt, reason: "User requested an end" } } });
		expect(history.filter((entry) => entry.message.role === "custom")).toHaveLength(1);
		expect(publish).toHaveBeenCalledWith("workspace", { type: "deployment.message.updated", data: { sessionId: "session", message: history[1] } });
		await service.finishDeployment("session", discussion.id, "cancelled");
		expect(repository.listMessages("session")).toEqual(history);
		expect(database.prepare("SELECT message_json FROM chat_messages WHERE id='discussion-text'").get()?.message_json).toBe(text);
	});

	it("backfills finished metadata from frozen v32 without reordering normal messages or inventing another entry", () => {
		const database = new DatabaseSync(":memory:");
		try {
			database.exec(readFileSync(new URL("./fixtures/schema-v27-sandbox.sql", import.meta.url), "utf8"));
			database.exec(readFileSync(new URL("./fixtures/schema-v32-deployment.sql", import.meta.url), "utf8"));
			database.exec(`INSERT INTO deployment_discussions VALUES ('old','s-app','w-app','discussing',1,'{}',10,10);
				INSERT INTO deployment_sessions (id,session_id,workspace_id,title,created_at) VALUES ('old','s-app','w-app','API',10);
				INSERT INTO chat_messages (id,session_id,sequence,message_type,message_json,created_at) VALUES ('text','s-app',2,'user','{"role":"user","content":"keep","timestamp":20}',20);
				UPDATE deployment_sessions SET outcome='failed',reason='Old failure',finished_at=30 WHERE id='old';`);
			const before = database.prepare("SELECT * FROM chat_messages WHERE id='text'").get();
			applyMigrations(database);
			const message = new SqliteDeploymentSessionRepository(database).historyMessage("s-app", "old");
			expect(message).toMatchObject({ id: "deployment:old", sequence: 1, message: { details: { position: "legacy_finished", outcome: "failed", finishedAt: 30, reason: "Old failure" } } });
			expect(database.prepare("SELECT * FROM chat_messages WHERE id='text'").get()).toEqual(before);
			applyMigrations(database);
			expect(new SqliteDeploymentSessionRepository(database).historyMessage("s-app", "old")).toEqual(message);
			expect(database.prepare("SELECT count(*) AS n FROM chat_messages WHERE message_type='deployment'").get()?.n).toBe(1);
			expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally { database.close(); }
	});
	it("counts deployment tools in offline contexts only while the current mode permits them", async () => {
		const names = (service: DeploymentService) => createChatContext("snapshot", [], service.activeMode("session"))
			.tools!.filter((tool) => tool.name.startsWith("deployment_")).map((tool) => tool.name).sort();
		const discussion = await harness();
		expect(names(discussion.service)).toEqual([]);
		const started = await discussion.begin();
		expect(names(discussion.service)).toEqual(["deployment_finish", "deployment_propose_plan"]);
		await discussion.service.finishDeployment("session", started.id, "cancelled");
		expect(names(discussion.service)).toEqual([]);

		const execution = await harness();
		const planned = await execution.propose();
		expect(names(execution.service)).toEqual(["deployment_finish", "deployment_inspect"]);
		await execution.service.claimForAgent("session", planned.id, "execution");
		expect(names(execution.service)).toEqual(["deployment_execute_next", "deployment_finish", "deployment_inspect", "deployment_propose_recovery"]);
		const finished = await execution.service.finishDeployment("session", planned.id, "failed", "Cannot deploy");
		expect(names(execution.service)).toEqual([]);
		expect(createChatContext("snapshot", [], finished).tools!.some((tool) => tool.name.startsWith("deployment_"))).toBe(false);
	});

	it("creates one ordered formal history message and restores mode from SQLite", async () => {
		const { database, service, begin, sessions } = await harness();
		const discussion = await begin();
		await service.bindPlanningRun("session", discussion.id, "planning-1");
		await service.finishPlanningAgent("session", "planning-1", "failed");
		await service.bindPlanningRun("session", discussion.id, "planning-2");
		const restored = new SqliteDeploymentSessionRepository(database).active("session");
		expect(restored).toEqual(sessions.active("session"));
		expect(restored?.id).toBe(discussion.id);
		const history = new SqliteChatRepository(database).listMessages("session");
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({ sequence: 1, message: { role: "custom", customType: "deployment",
			details: { deploymentId: discussion.id, title: "API" } } });
		expect(modelVisibleMessages(history.map((entry) => entry.message))).toEqual([]);
		await expect(begin()).rejects.toMatchObject({ code: "deployment_session_busy" });
	});

	it("rolls back the Discussion and message together when entering mode fails", async () => {
		const { database, sessions, begin, service } = await harness();
		vi.spyOn(sessions, "insert").mockImplementationOnce(() => { throw new Error("disk full"); });
		await expect(begin()).rejects.toThrow("disk full");
		expect(service.activeDiscussion("session")).toBeNull();
		expect(new SqliteChatRepository(database).listMessages("session")).toEqual([]);
		expect(database.prepare("SELECT count(*) AS count FROM deployment_discussions").get()?.count).toBe(0);
	});

	it("keeps an unplanned discussion active during conservative restart recovery", async () => {
		const { begin, runs, executions, sessions, service } = await harness();
		const discussion = await begin();
		runs.recoverInterrupted(Date.now()); executions.recoverInterrupted(Date.now()); sessions.recoverInterrupted(Date.now());
		expect(service.activeMode("session")).toMatchObject({ phase: "discussion", deployment: { id: discussion.id }, run: null });
	});

	it("settles an invalidated plan's mode even when the clock moves backwards during restart", async () => {
		const { propose, runs, executions, sessions, service } = await harness();
		const planned = await propose();
		runs.recoverInterrupted(0); executions.recoverInterrupted(0); sessions.recoverInterrupted(0);
		expect(service.activeMode("session")).toBeNull();
		const recovered = service.getMode("session", planned.id);
		expect(recovered.deployment.outcome).toBe("cancelled");
		expect(recovered.deployment.finishedAt).toBeGreaterThanOrEqual(recovered.deployment.createdAt);
		expect(recovered.run?.stages.build.status).toBe("pending");
	});

	it("keeps a rejected sandbox exception in review until an explicit exit", async () => {
		const { service, propose } = await harness({ sandboxEnabled: true });
		const planned = await propose();
		const approval = planned.fullAccessApprovals!.restart!;
		const rejected = service.decideFullAccess("session", planned.id, "restart", approval.id, false);
		expect(rejected.status).toBe("preparing");
		expect(service.activeMode("session")?.phase).toBe("review");
		await expect(service.claimForAgent("session", planned.id, "execution")).rejects.toMatchObject({ code: "deployment_full_access_approval_required" });
		service.decideFullAccess("session", planned.id, "restart", approval.id, true);
		expect(service.activeMode("session")?.run?.fullAccessApprovals?.restart?.status).toBe("approved");
		await service.finishDeployment("session", planned.id, "failed", "User declined deployment");
		expect(service.activeMode("session")).toBeNull();
	});

	it("keeps the same identity through planning and multiple execution Runs, then explicitly succeeds", async () => {
		const { service, propose, database, submit } = await harness();
		const planned = await propose();
		expect(planned.id).toBe(planned.discussionId);
		await service.finishPlanningAgent("session", "planning", "cancelled");
		expect(service.activeMode("session")?.phase).toBe("review");
		await service.claimForAgent("session", planned.id, "execution-1");
		await service.executeStageForAgent("session", planned.id, "execution-1", "build", new AbortController().signal);
		await service.finishAgent("session", planned.id, "execution-1", "completed");
		expect(service.activeMode("session")?.run?.status).toBe("running");
		await service.claimForAgent("session", planned.id, "execution-2");
		for (const stage of ["upload", "restart", "verify"] as const)
			await service.executeStageForAgent("session", planned.id, "execution-2", stage, new AbortController().signal);
		expect(service.activeMode("session")?.run?.status).toBe("running");
		const finished = await service.finishDeployment("session", planned.id, "success", undefined, "execution-2");
		expect(finished.deployment.outcome).toBe("success");
		expect(finished.run?.status).toBe("success");
		expect(service.activeMode("session")).toBeNull();
		await service.finishAgent("session", planned.id, "execution-2", "completed");
		expect(submit).toHaveBeenCalledOnce();
		expect(new SqliteChatRepository(database).listMessages("session")).toHaveLength(1);
		await expect(service.executeStageForAgent("session", planned.id, "execution-2", "build", new AbortController().signal))
			.rejects.toMatchObject({ code: "deployment_mode_inactive" });
	});

	it("rejects premature success and preserves a failed settlement request for retry", async () => {
		const { service, propose, sessions, modes } = await harness();
		const planned = await propose();
		await expect(service.finishDeployment("session", planned.id, "success")).rejects.toMatchObject({ code: "deployment_incomplete" });
		expect(service.activeMode("session")).not.toBeNull();
		vi.spyOn(sessions, "finish").mockImplementationOnce(() => { throw new Error("commit unavailable"); });
		await expect(service.finishDeployment("session", planned.id, "failed", "Cannot deploy this release")).rejects.toThrow("commit unavailable");
		expect(() => modes.assertActive("session", planned.id)).toThrowError(/being settled/u);
		const final = await service.finishDeployment("session", planned.id, "cancelled");
		expect(final.deployment).toMatchObject({ outcome: "failed", reason: "Cannot deploy this release" });
		expect(final.run).toMatchObject({ status: "failed", error: "Cannot deploy this release" });
	});

	it("settles competing exits once and rejects stale planning calls", async () => {
		const { service, begin } = await harness();
		const discussion = await begin();
		const bound = await service.bindPlanningRun("session", discussion.id, "planning");
		const [cancelled, competing] = await Promise.all([
			service.finishDeployment("session", discussion.id, "cancelled"),
			service.finishDeployment("session", discussion.id, "failed", "Unable to deploy"),
		]);
		expect(cancelled.deployment).toEqual(competing.deployment);
		expect(cancelled.deployment.outcome).toBe("cancelled");
		await expect(service.proposeForDiscussion("session", discussion.id, bound.revision, "planning", {} as never, new AbortController().signal))
			.rejects.toMatchObject({ code: "deployment_discussion_conflict" });
		expect(service.activeMode("session")).toBeNull();
	});

	it("projects trusted state onto diagnostic results without growing stored messages", async () => {
		const { service, begin } = await harness();
		await begin();
		const messages = [{ role: "toolResult" as const, toolCallId: "diagnostic", toolName: "terminal_interaction",
			content: [{ type: "text" as const, text: "Linux" }], isError: false, timestamp: 1 }];
		const projected = deploymentProviderMessages(messages, service.activeMode("session"));
		expect(JSON.stringify(projected)).toContain('"deploymentMode\\":true');
		expect(messages[0]?.content).toHaveLength(1);
		expect(deploymentProviderMessages(messages, null)).toEqual(messages);
	});

	it("exposes explicit user exit through strict HTTP input", async () => {
		const { service, begin } = await harness();
		const discussion = await begin();
		const segments = ["api", "sessions", "session", "deployments", "tasks", discussion.id, "finish"];
		const request = (body: unknown) => new Request(`http://localhost/${segments.join("/")}`, {
			method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
		});
		await expect(handleDeploymentRoute(service, request({ outcome: "cancelled", unknown: true }), segments))
			.rejects.toMatchObject({ code: "deployment_request_invalid" });
		await expect(handleDeploymentRoute(service, request({ outcome: "failed" }), segments))
			.rejects.toMatchObject({ code: "deployment_request_invalid" });
		const response = await handleDeploymentRoute(service, request({ outcome: "cancelled" }), segments);
		expect(await response?.json()).toMatchObject({ phase: "finished", deployment: { outcome: "cancelled" } });
	});

	it("deduplicates one execution request and invalidates downstream facts on an explicit upstream rerun", async () => {
		const { service, propose, root } = await harness();
		const planned = await propose("printf x >> builds; printf ready > api.jar");
		await service.claimForAgent("session", planned.id, "execution");
		const execute = (stage: "build" | "upload" | "restart" | "verify", request: string) =>
			service.executeStageForAgent("session", planned.id, "execution", stage, new AbortController().signal, request);
		await Promise.all([execute("build", "build-1"), execute("build", "build-1")]);
		await execute("upload", "upload-1");
		await execute("restart", "restart-1");
		await execute("build", "build-1");
		expect(service.get("session", planned.id).stages.restart.status).toBe("success");
		expect(await readFile(join(root, "builds"), "utf8")).toBe("x");
		const rerun = await execute("build", "build-2");
		expect(await readFile(join(root, "builds"), "utf8")).toBe("xx");
		expect(rerun.stages.build.status).toBe("success");
		for (const stage of ["upload", "restart", "verify"] as const) expect(rerun.stages[stage].status).toBe("pending");
		expect(rerun.stageAttempts?.build).toHaveLength(2);
		expect(rerun.stages.upload.log).toContain("Uploaded");
		await expect(execute("restart", "skip-upload")).rejects.toMatchObject({ code: "deployment_stage_out_of_order" });
	});

	it("requires a new one-use sandbox exception before rerunning a completed remote stage", async () => {
		const { service, propose, submit } = await harness({ sandboxEnabled: true });
		const planned = await propose();
		const original = planned.fullAccessApprovals!.restart!;
		service.decideFullAccess("session", planned.id, "restart", original.id, true);
		await service.claimForAgent("session", planned.id, "execution");
		for (const stage of ["build", "upload", "restart"] as const)
			await service.executeStageForAgent("session", planned.id, "execution", stage, new AbortController().signal, stage);
		await expect(service.executeStageForAgent("session", planned.id, "execution", "restart", new AbortController().signal, "rerun"))
			.rejects.toMatchObject({ code: "deployment_full_access_approval_required" });
		expect(submit).toHaveBeenCalledOnce();
		const pending = service.get("session", planned.id).fullAccessApprovals!.restart!;
		expect(pending.id).not.toBe(original.id);
		expect(pending.status).toBe("pending");
		service.decideFullAccess("session", planned.id, "restart", pending.id, true);
		await service.executeStageForAgent("session", planned.id, "execution", "restart", new AbortController().signal, "rerun-approved");
		expect(submit).toHaveBeenCalledTimes(2);
	});

	it("keeps failed output and appends a successful retry in the same stage", async () => {
		const { service, propose, root } = await harness();
		const planned = await propose("printf build-output; test -f fixed && printf ready > api.jar");
		await service.claimForAgent("session", planned.id, "execution");
		const execute = (request: string) => service.executeStageForAgent("session", planned.id, "execution", "build", new AbortController().signal, request);
		const failed = await execute("first");
		expect(failed).toMatchObject({ status: "recovering", stages: { build: { status: "failed" } } });
		const before = service.logs("session", planned.id, "build");
		await writeFile(join(root, "fixed"), "fixed");
		expect((await execute("first")).stages.build.status).toBe("failed");
		const retried = await execute("retry");
		expect(retried.stages.build.status).toBe("success");
		expect(retried.stages.build.log).toContain("failed");
		const appended = service.logs("session", planned.id, "build", before.nextSequence);
		expect(appended.chunks[0]?.kind).toBe("boundary");
		expect(appended.chunks.map((chunk) => chunk.text).join("")).toContain("build-output");
		expect(new Set([...before.chunks, ...appended.chunks].map((chunk) => chunk.sequence)).size)
			.toBe(before.chunks.length + appended.chunks.length);
	});

	it("retries a failed result commit without repeating the build side effect", async () => {
		const { service, propose, executions, root } = await harness();
		const planned = await propose("printf x >> builds; printf ready > api.jar");
		await service.claimForAgent("session", planned.id, "execution");
		vi.spyOn(executions, "finish").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
		const execute = () => service.executeStageForAgent("session", planned.id, "execution", "build", new AbortController().signal, "same-request");
		await expect(execute()).rejects.toThrow("disk unavailable");
		const [first, second] = await Promise.all([execute(), execute()]);
		expect(first.stages.build.status).toBe("success");
		expect(second.stages.build.status).toBe("success");
		expect(await readFile(join(root, "builds"), "utf8")).toBe("x");
		expect(executions.findRequest(planned.id, "execution:same-request")?.status).toBe("success");
	});

	it("settles competing exits during a live build and rejects its late output", async () => {
		const { service, propose, executions, root } = await harness();
		const planned = await propose(`node -e "require('node:fs').writeFileSync('started', 'yes'); process.stdout.write('building\\n'); setInterval(() => {}, 1000)"`);
		await service.claimForAgent("session", planned.id, "execution");
		const building = service.executeStageForAgent("session", planned.id, "execution", "build", new AbortController().signal, "live-build");
		await vi.waitFor(async () => expect(await readFile(join(root, "started"), "utf8")).toBe("yes"));
		expect(executions.findRequest(planned.id, "execution:live-build")?.status).toBe("running");
		await expect(service.executeStageForAgent("session", planned.id, "execution", "build", new AbortController().signal, "second-build"))
			.rejects.toMatchObject({ code: "deployment_stage_busy" });
		await expect(service.executeStageForAgent("session", planned.id, "execution", "upload", new AbortController().signal, "early-upload"))
			.rejects.toMatchObject({ code: "deployment_stage_out_of_order" });
		expect(executions.findRequest(planned.id, "execution:second-build")).toBeUndefined();
		expect(executions.findRequest(planned.id, "execution:early-upload")).toBeUndefined();
		const [cancelled, competing] = await Promise.all([
			service.finishDeployment("session", planned.id, "cancelled"),
			service.finishDeployment("session", planned.id, "failed", "User requested an end"),
		]);
		await building;
		expect(cancelled.deployment).toEqual(competing.deployment);
		expect(cancelled.deployment.outcome).toBe("cancelled");
		expect(cancelled.run).toMatchObject({ status: "cancelled", stages: { build: { status: "failed" } } });
		expect(service.activeMode("session")).toBeNull();
		const execution = executions.findRequest(planned.id, "execution:live-build")!;
		expect(execution.status).toBe("failed");
		const before = service.logs("session", planned.id, "build");
		expect(before.chunks.map((chunk) => chunk.text).join("")).toContain("building");
		expect(() => executions.append({ deploymentRunId: planned.id, executionId: execution.id, stage: "build",
			timestamp: Date.now(), kind: "output", text: "late callback" })).toThrow();
		expect(service.logs("session", planned.id, "build")).toEqual(before);
		expect(service.getMode("session", planned.id).deployment.outcome).toBe("cancelled");
	});

	it("reconciles an uncommitted execution before explicit failure without rebuilding", async () => {
		const { service, propose, executions, root } = await harness();
		const planned = await propose("printf x >> builds; printf ready > api.jar");
		await service.claimForAgent("session", planned.id, "execution");
		vi.spyOn(executions, "finish").mockImplementationOnce(() => { throw new Error("commit unavailable"); });
		await expect(service.executeStageForAgent("session", planned.id, "execution", "build", new AbortController().signal, "build"))
			.rejects.toThrow("commit unavailable");
		const finished = await service.finishDeployment("session", planned.id, "failed", "Stop after checking the saved build");
		expect(finished.run).toMatchObject({ status: "failed", stages: { build: { status: "success" } } });
		expect(executions.findRequest(planned.id, "execution:build")?.status).toBe("success");
		expect(await readFile(join(root, "builds"), "utf8")).toBe("x");
		expect(service.activeMode("session")).toBeNull();
	});

	it("persists complete paged output beyond the model snapshot tail", async () => {
		const { service, propose } = await harness();
		const planned = await propose(`node -e "process.stdout.write('x'.repeat(160000))"; printf ready > api.jar`);
		await service.claimForAgent("session", planned.id, "execution");
		const run = await service.executeStageForAgent("session", planned.id, "execution", "build", new AbortController().signal, "large-log");
		expect(run.stages.build.logTruncated).toBe(true);
		expect(run.stages.build.log.length).toBeLessThanOrEqual(128 * 1024);
		let cursor = 0;
		let output = "";
		let more = true;
		while (more) {
			const page = service.logs("session", planned.id, "build", cursor, 2);
			output += page.chunks.filter((chunk) => chunk.kind === "output").map((chunk) => chunk.text).join("");
			cursor = page.nextSequence;
			more = page.hasMore;
		}
		expect(output).toContain("x".repeat(160000));
		expect(cursor).toBe(run.stages.build.logCursor);
		const segments = ["api", "sessions", "session", "deployments", planned.id, "logs"];
		const response = await handleDeploymentRoute(service, new Request(`http://localhost/${segments.join("/")}?stage=build&afterSequence=${cursor}`), segments);
		expect(await response?.json()).toMatchObject({ chunks: [], nextSequence: cursor, hasMore: false });
	});

	it("reviews a build repair after a restart failure and preserves prior stage logs", async () => {
		const { service, propose, submit } = await harness();
		const planned = await propose();
		await service.claimForAgent("session", planned.id, "execution");
		for (const stage of ["build", "upload"] as const)
			await service.executeStageForAgent("session", planned.id, "execution", stage, new AbortController().signal, stage);
		submit.mockResolvedValueOnce({ operation: { id: "operation", status: "failed", exitCode: 1 } });
		await service.executeStageForAgent("session", planned.id, "execution", "restart", new AbortController().signal, "restart");
		const previous = service.get("session", planned.id).stages.build.log;
		const proposed = await service.proposeRecoveryForAgent("session", planned.id, "execution", 1, {
			stage: "build", reason: "Rebuild a corrected artifact", buildSteps: [{ workdir: ".", command: "printf repaired > api.jar" }],
		}, new AbortController().signal);
		await expect(service.executeStageForAgent("session", planned.id, "execution", "build", new AbortController().signal, "unreviewed"))
			.rejects.toMatchObject({ code: "deployment_review_required" });
		const approved = await service.decideRecovery("session", planned.id, proposed.recoveries!.at(-1)!.id, true);
		expect(approved.planRevision).toBe(2);
		expect(approved.stages.build).toMatchObject({ status: "pending", log: previous });
		expect(approved.stages.restart.status).toBe("pending");
		expect(approved.stages.restart.log).toContain("failed");
		const rebuilt = await service.executeStageForAgent("session", planned.id, "execution", "build", new AbortController().signal, "rebuild");
		expect(rebuilt.stages.build.status).toBe("success");
		await service.executeStageForAgent("session", planned.id, "execution", "upload", new AbortController().signal, "upload-again");
		submit.mockResolvedValueOnce({ operation: { id: "operation", status: "failed", exitCode: 1 } });
		await service.executeStageForAgent("session", planned.id, "execution", "restart", new AbortController().signal, "restart-again");
		await service.finishAgent("session", planned.id, "execution", "completed");
		await service.bindRecoveryAgent("session", planned.id, "diagnosis-2");
		const nextRepair = await service.proposeRecoveryForAgent("session", planned.id, "diagnosis-2", 2, {
			stage: "restart", reason: "Correct the restart invocation", command: "restart-api-corrected",
		}, new AbortController().signal);
		expect(nextRepair.recoveries).toHaveLength(2);
		expect(nextRepair.recoveries?.at(-1)?.status).toBe("pending");
	});
});
