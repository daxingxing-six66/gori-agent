import { DatabaseSync } from "node:sqlite";
import type { TerminalChannelExit, TerminalChannelHandle, TerminalChannelBroker } from "../src/application/ssh-channel-broker.ts";
import { SessionLifecycleCoordinator } from "../src/application/services/session-lifecycle-coordinator.ts";
import { TerminalSessionService } from "../src/application/services/terminal-session-service.ts";
import { TerminalInteractionService } from "../src/application/services/terminal-interaction-service.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { SqliteTerminalRepository } from "../src/infrastructure/sqlite/sqlite-terminal-repository.ts";
import { SqliteSessionRepository } from "../src/infrastructure/sqlite/sqlite-session-repository.ts";
import { terminalTestSandbox } from "./terminal-test-sandbox.ts";

class HumanTestChannel implements TerminalChannelHandle {
	readonly connectionGeneration = 1;
	readonly writes: Uint8Array[] = [];
	readonly closed: Promise<TerminalChannelExit>;
	readonly #onData: (bytes: Uint8Array) => void;
	#finish!: (exit: TerminalChannelExit) => void;
	disposed = false;
	echo = true;
	writeGate: Promise<void> | undefined;
	writeError = false;
	constructor(onData: (bytes: Uint8Array) => void) {
		this.#onData = onData; this.closed = new Promise(resolve => { this.#finish = resolve; });
	}
	isClosed(): boolean { return this.disposed; }
	startOutput(): void {}
	emit(text: string): void { this.#onData(Buffer.from(text)); }
	async write(bytes: Uint8Array): Promise<void> {
		this.writes.push(bytes.slice());
		if (this.writeGate) await this.writeGate;
		if (this.writeError) throw new Error("simulated SSH write failure");
		if (this.echo) this.#onData(bytes);
	}
	async resize(): Promise<void> {}
	setReadPaused(): void {}
	async close(): Promise<void> { this.#finish({ kind: "closed" }); }
	dispose(): void { this.disposed = true; }
}

export async function humanFixture() {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys=ON"); applyMigrations(db);
	db.exec(`INSERT INTO workspaces (id,display_name,environment,hostname,port,default_cwd,connect_timeout_ms,keepalive_interval_ms,keepalive_max_count,revision,created_at,updated_at)
		VALUES ('w','test','development','test.invalid',22,'/tmp',1000,1000,3,1,1,1);
		INSERT INTO sessions (id,workspace_id,display_name,revision,created_at,updated_at) VALUES ('s','w','test',1,1,1);`);
	let next = 0;
	let channel!: HumanTestChannel;
	let busy = false;
	const repository = new SqliteTerminalRepository(db);
	const broker: TerminalChannelBroker = { open: async (input) => { channel = new HumanTestChannel(input.onData); return channel; } };
	const clock = { now: () => Date.now() };
	const ids = { next: () => `human-id-${++next}` };
	const service = new TerminalSessionService({ sessions: new SqliteSessionRepository(db), terminals: repository, broker,
		targets: { resolve: async () => ({ workspaceId: "w", workspaceRevision: 1, credentialId: "c", credentialAuthVersion: 1,
			hostname: "test.invalid", port: 22, remoteUser: "test", hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "SHA256:test",
			connectTimeoutMs: 1000, keepaliveIntervalMs: 1000, keepaliveMaxCount: 3, sandboxWritableRoots: ["/tmp"] }) },
		sandbox: terminalTestSandbox, lifecycle: new SessionLifecycleCoordinator(), clock, ids, hasActiveChatRun: async () => busy });
	const terminal = await service.open({ sessionId: "s", requestId: "open" });
	await new Promise<void>(resolve => setImmediate(resolve));
	const actor = service.getActor("s")!;
	channel.emit("$ "); await actor.captureCanonical();
	db.prepare(`INSERT INTO chat_runs (id,session_id,workspace_id,request_id,provider_id,model_id,thinking_level,status,created_at,updated_at,server_interaction_mode,terminal_session_id)
		VALUES ('run','s','w','run-request','fake','fake','off','running',1,1,'terminal',?)`).run(terminal.id);
	const interactions = new TerminalInteractionService({ repository, terminals: service, sessions: new SqliteSessionRepository(db),
		guards: { evaluate: async () => ({ allowed: true }) }, clock, ids });
	const attach = async () => {
		const bootstrap = await service.attach("s", ids.next());
		await actor.prepareReplay(bootstrap.attachmentId, bootstrap.snapshot.sequence);
		await service.ready("s", bootstrap.attachmentId, bootstrap.snapshot.sequence);
		return bootstrap.attachmentId;
	};
	return { db, repository, service, actor, channel, terminal, attach, interactions, setBusy: (value: boolean) => { busy = value; },
		cleanup: async () => { await service.shutdown(); db.close(); } };
}
