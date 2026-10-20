import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSshAgentDatabase } from "../src/infrastructure/sqlite/database.ts";
import { hasActiveDeploymentTask } from "../src/infrastructure/sqlite/sqlite-session-task-mode-facts.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteDiagnoseRepository } from "../src/infrastructure/sqlite/sqlite-diagnose-repository.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { SqliteTransactionRunner } from "../src/infrastructure/sqlite/sqlite-transaction-runner.ts";
import { SqliteChatRepository } from "../src/infrastructure/sqlite/sqlite-chat-repository.ts";
import { DiagnoseService } from "../src/application/services/diagnose-service.ts";
import { SessionTaskModePolicy } from "../src/application/services/session-task-mode-policy.ts";
import { WorkspaceEventHub } from "../src/application/workspace-event-hub.ts";
import { DiagnoseRuntime } from "../src/application/diagnose-runtime.ts";
import { createChatContext } from "../src/application/chat-context.ts";
import { modelVisibleMessages } from "../src/application/chat-ui-history-message.ts";
import type { DiagnoseToolBinding } from "../src/domain/diagnose.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function harness(path = ":memory:") {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA foreign_keys = ON"); applyMigrations(db);
	db.exec(`INSERT INTO workspaces (id,display_name,environment,hostname,port,default_cwd,connect_timeout_ms,keepalive_interval_ms,keepalive_max_count,revision,created_at,updated_at)
		VALUES ('w','test','development','test.invalid',22,'/tmp',1000,1000,3,1,1,1);
		INSERT INTO sessions (id,workspace_id,display_name,revision,created_at,updated_at) VALUES ('s','w','test',1,1,1);
		INSERT INTO sessions (id,workspace_id,display_name,revision,created_at,updated_at) VALUES ('other','w','other',1,1,1);`);
	const transactions = new SqliteTransactionRunner(db);
	const repository = new SqliteDiagnoseRepository(db);
	const events = new WorkspaceEventHub();
	const publish = vi.spyOn(events, "publish");
	let id = 0; let deploy = false;
	const modes = new SessionTaskModePolicy({ hasDiagnose: (sessionId) => !!repository.active(sessionId), hasDeploy: (sessionId) => deploy || hasActiveDeploymentTask(db, sessionId) });
	const service = new DiagnoseService({ repository, sessions: new SqliteSessionRepository(db), transactions, events, modes,
		clock: { now: () => 100 }, ids: { next: () => `task-${++id}` } });
	const task = await service.create("s", "start");
	const chat = new SqliteChatRepository(db);
	chat.insertRun({ id: "run", requestId: "run", sessionId: "s", workspaceId: "w", providerId: "fake", modelId: "fake", thinkingLevel: "off",
		serverInteractionMode: "command", terminalSessionId: null, status: "completed", createdAt: 1, updatedAt: 1 });
	service.bindRun("s", task.id, "run");
	const binding = (toolCallId: string): DiagnoseToolBinding => ({ sessionId: "s", taskId: task.id, runId: "run", toolCallId });
	cleanups.push(() => { events.close(); db.close(); });
	return { db, repository, service, task, binding, publish, chat, modes, setDeploy: (value: boolean) => { deploy = value; } };
}

describe("durable diagnosis aggregate", () => {
	it("updates titles independently, gates append, permits uncertainty and freezes old records in SQL", async () => {
		const { service, task, binding, db } = await harness();
		await service.update(binding("title"), { title: "API intermittent errors" });
		expect(service.nodes("s", task.id).nodes).toEqual([]);
		await service.update(binding("first"), { node: { action: "append", direction: "Inspect proxy" } });
		await expect(service.update(binding("early"), { node: { action: "append", direction: "Inspect app" } })).rejects.toMatchObject({ code: "diagnose_current_unfinished" });
		await expect(service.update(binding("empty"), { node: { action: "update_current", status: "confirmed" } })).rejects.toMatchObject({ field: "node.explanation" });
		await service.update(binding("uncertain"), { node: { action: "update_current", status: "unconfirmed", explanation: "No correlated proxy error; check application logs next." } });
		await service.update(binding("second"), { node: { action: "append", direction: "Inspect app" } });
		expect(service.nodes("s", task.id).nodes.map((node) => node.status)).toEqual(["unconfirmed", "diagnosing"]);
		expect(() => db.prepare("UPDATE diagnose_nodes SET explanation='rewrite' WHERE task_id=? AND sequence=1").run(task.id)).toThrow(/current/u);
		expect(() => service.get("other", task.id)).toThrow(/not found/u);
	});
	it("replays committed tool calls after finish and rejects changed replay or late writes", async () => {
		const { service, task, binding } = await harness();
		const input = { node: { action: "append", direction: "Application logs" } };
		const first = await service.update(binding("first"), input);
		expect(await service.update(binding("first"), input)).toEqual(first);
		const final = await service.finish(binding("finish"), "# Inconclusive\n\nLogs are unavailable; no root cause established.");
		expect(final.status).toBe("completed");
		expect(await service.update(binding("first"), input)).toEqual(first);
		expect(await service.finish(binding("finish"), service.conclusion("s", task.id))).toEqual(final);
		await expect(service.update(binding("first"), { title: "other" })).rejects.toMatchObject({ code: "diagnose_replay_conflict" });
		await expect(service.update(binding("late"), { title: "late" })).rejects.toMatchObject({ code: "diagnose_inactive" });
		expect(service.current("s", task.id)).toMatchObject({ status: "unconfirmed", explanation: expect.stringContaining("before this direction was separately confirmed") });
		expect(service.active("s")).toBeNull();
	});
	it("rolls back report, sealing and receipts on failure, then lets the first terminal commit win", async () => {
		const { service, task, binding, repository, publish } = await harness();
		await service.update(binding("first"), { node: { action: "append", direction: "Check logs", explanation: "original observation" } });
		publish.mockClear();
		vi.spyOn(repository, "saveReceipt").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
		await expect(service.finish(binding("failed"), "# Report")).rejects.toThrow("disk unavailable");
		expect(service.get("s", task.id).status).toBe("active");
		expect(service.current("s", task.id)?.explanation).toBe("original observation");
		expect(publish).not.toHaveBeenCalled();
		await service.cancel("s", task.id);
		await expect(service.finish(binding("late"), "# Late report")).rejects.toMatchObject({ code: "diagnose_inactive" });
		expect(service.get("s", task.id)).toMatchObject({ status: "cancelled", conclusionAvailable: false });
	});
	it("persists one unified UI message and keeps unknown custom messages visible to the model", async () => {
		const { service, task, binding, chat, db } = await harness();
		chat.appendMessage("normal", "s", "run", { role: "user", content: "check", timestamp: 2 }, 2);
		await service.update(binding("title"), { title: "Request latency" });
		await service.finish(binding("end"), "# Conclusion");
		const history = chat.listHistoryPage!("s", { direction: "latest" }, 20).messages;
		expect(history.map((message) => message.id)).toEqual(["normal", `diagnose:${task.id}`]);
		expect(modelVisibleMessages(history.map((message) => message.message))).toHaveLength(1);
		expect(modelVisibleMessages([{ role: "custom", customType: "other", content: "keep", display: true, timestamp: 1 }])).toHaveLength(1);
		expect(new SqliteDiagnoseRepository(db).find("s", task.id)?.status).toBe("completed");
	});
	it("uses only three brief fields without accumulation and keeps complete bounded pages", async () => {
		const { service, task, binding } = await harness();
		await service.update(binding("first"), { node: { action: "append", direction: "Logs", status: "unconfirmed", explanation: "证".repeat(4000) } });
		for (let index = 0; index < 8; index++) await service.update(binding(`next${index}`), { node: { action: "append", direction: `Next ${index}`, status: "unconfirmed", explanation: "据".repeat(4000) } });
		const page = service.nodes("s", task.id);
		expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(65536);
		expect(page.nextBeforeSequence).not.toBeNull();
		expect(page.nodes[0]!.explanation).toHaveLength(4000);
		const runtime = new DiagnoseRuntime(service);
		const initial = runtime.context(createChatContext("immutable", []), "s");
		const projected = runtime.project(initial, "s", task.id);
		expect(projected.systemPrompt).toBe(initial.systemPrompt);
		const skill = readFileSync(new URL("../resources/skills/gori-diagnosis/SKILL.md", import.meta.url), "utf8").trim();
		expect(projected.systemPrompt.split("<diagnose-skill>\n")[1]!.split("\n</diagnose-skill>")[0]).toBe(skill);
		expect(projected.messages).toEqual([]);
		expect(runtime.context(createChatContext("ordinary session", []), "other").systemPrompt).toBe("ordinary session");
		const brief = JSON.parse(projected.systemPrompt.split("<brief-data>")[1]!.split("</brief-data>")[0]!);
		expect(Object.keys(brief)).toEqual(["direction", "status", "explanation"]);
		expect(Array.from(brief.explanation)).toHaveLength(300);
		expect(runtime.tools("s", task.id, "run").map((tool) => tool.name)).toEqual(["diagnose_update", "diagnose_inspect", "diagnose_finish"]);
		await service.cancel("s", task.id);
		expect(runtime.tools("s", task.id, "run")).toEqual([]);
		expect(runtime.project(projected, "s", task.id).systemPrompt).toBe("immutable");
	});
	it("enforces mutual mode exclusion and UTF-8 input limits", async () => {
		const { service, binding, modes, db } = await harness();
		expect(() => modes.assertCanStart("s", "deploy")).toThrow(/active/u);
		db.exec(`INSERT INTO deployment_runs (id,session_id,workspace_id,status,snapshot_json,created_at,updated_at) VALUES ('legacy','other','w','preparing','{}',1,1)`);
		await expect(service.create("other", "new")).rejects.toMatchObject({ code: "session_task_mode_conflict" });
		await expect(service.update(binding("large"), { node: { action: "append", direction: "logs", explanation: "汉".repeat(6000) } })).rejects.toMatchObject({ field: "node.explanation" });
	});
	it("serializes competing terminal commits without overwriting the winner", async () => {
		const { service, task, binding } = await harness();
		const [finished, cancelled] = await Promise.all([service.finish(binding("finish"), "# Saved first"), service.cancel("s", task.id)]);
		expect(finished.status).toBe("completed"); expect(cancelled.status).toBe("completed");
		expect(service.conclusion("s", task.id)).toBe("# Saved first");
	});
	it("restores an active task after reopening the database and allows Session cascade deletion", async () => {
		const root = mkdtempSync(join(tmpdir(), "gori-diagnose-db-"));
		const path = join(root, "state.sqlite");
		const { service, task, binding } = await harness(path);
		await service.update(binding("save"), { node: { action: "append", direction: "Proxy errors", explanation: "Observed 502" } });
		cleanups.pop()!();
		const reopened = openSshAgentDatabase(path);
		try {
			const restored = new SqliteDiagnoseRepository(reopened);
			expect(restored.active("s")).toMatchObject({ id: task.id, currentSequence: 1, status: "active" });
			expect(restored.current(task.id)?.explanation).toBe("Observed 502");
			expect(restored.boundTask("run")).toBe(task.id);
			expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			reopened.prepare("DELETE FROM sessions WHERE id='s'").run();
			expect(restored.active("s")).toBeUndefined();
			expect(restored.current(task.id)).toBeUndefined();
		} finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
	});
});
