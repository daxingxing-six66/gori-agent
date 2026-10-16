import { deploymentApi } from "../api/deployment-api";
import type { DeploymentExecutableStage } from "../model/deployment";
import type { DeploymentLogChunk, DeploymentLogPage } from "../model/deployment-task";

export interface DeploymentLogSnapshot { chunks: DeploymentLogChunk[]; loading: boolean; error: string | null }
const EMPTY: DeploymentLogSnapshot = { chunks: [], loading: false, error: null };
interface Entry { runId: string; stage: DeploymentExecutableStage; cursor: number; value: DeploymentLogSnapshot; request?: Promise<void>; refreshAgain: boolean }

/** One cache per mounted Session. SSE and REST share ordered, deduplicated chunks. */
export class DeploymentLogStore {
	private readonly entries = new Map<string, Entry>();
	private readonly listeners = new Set<() => void>();
	private disposed = false;
	constructor(privateSessionId: string, read = deploymentApi.logs) { this.sessionId = privateSessionId; this.read = read; }
	private readonly sessionId: string;
	private readonly read: (sessionId: string, id: string, stage: DeploymentExecutableStage, cursor: number) => Promise<DeploymentLogPage>;
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
	snapshot(runId: string, stage: DeploymentExecutableStage): DeploymentLogSnapshot { return this.entries.get(`${runId}:${stage}`)?.value ?? EMPTY; }
	append(chunk: DeploymentLogChunk): void {
		const entry = this.entries.get(`${chunk.deploymentRunId}:${chunk.stage}`);
		if (entry) this.merge(entry, [chunk]); // Unopened stages are read from durable history when selected.
	}
	load(runId: string, stage: DeploymentExecutableStage): Promise<void> {
		const key = `${runId}:${stage}`;
		let entry = this.entries.get(key);
		if (!entry) { entry = { runId, stage, cursor: 0, value: EMPTY, refreshAgain: false }; this.entries.set(key, entry); }
		if (entry.request) { entry.refreshAgain = true; return entry.request; }
		const current = entry;
		current.value = { ...current.value, loading: true, error: null }; this.notify();
		const task = this.catchUp(current).catch((failure: unknown) => {
			if (!this.disposed) current.value = { ...current.value, error: failure instanceof Error ? failure.message : String(failure) };
		}).finally(() => {
			current.request = undefined;
			current.value = { ...current.value, loading: false }; this.notify();
			if (current.refreshAgain && !this.disposed) { current.refreshAgain = false; void this.load(runId, stage); }
		});
		current.request = task;
		return task;
	}
	refresh(): void { for (const entry of this.entries.values()) void this.load(entry.runId, entry.stage); }
	activate(): void { this.disposed = false; }
	dispose(): void { this.disposed = true; this.listeners.clear(); }
	private async catchUp(entry: Entry): Promise<void> {
		let more = true;
		while (more && !this.disposed) {
			const page = await this.read(this.sessionId, entry.runId, entry.stage, entry.cursor);
			if (this.disposed) return;
			this.merge(entry, page.chunks);
			entry.cursor = page.nextSequence;
			more = page.hasMore;
		}
	}
	private merge(entry: Entry, chunks: DeploymentLogChunk[]): void {
		if (this.disposed || chunks.length === 0) return;
		const bySequence = new Map(entry.value.chunks.map((chunk) => [chunk.sequence, chunk]));
		for (const chunk of chunks) if (chunk.deploymentRunId === entry.runId && chunk.stage === entry.stage) bySequence.set(chunk.sequence, chunk);
		entry.value = { ...entry.value, chunks: [...bySequence.values()].sort((a, b) => a.sequence - b.sequence) };
		this.notify();
	}
	private notify(): void { if (!this.disposed) for (const listener of this.listeners) listener(); }
}
