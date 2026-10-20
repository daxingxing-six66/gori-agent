import type { Session } from "../domain/session.ts";
import type { DiagnoseNode, DiagnoseTask } from "../domain/diagnose.ts";
import type { FileTransfer } from "../domain/file-transfer.ts";
import type { DeploymentDiscussion, DeploymentExecutableStage, DeploymentRun, DeploymentStageView } from "../domain/deployment.ts";
import type { DeploymentModeView } from "../domain/deployment-session.ts";
import type { DeploymentLogChunk } from "../domain/deployment-execution.ts";
import type { ChatMessageProjection } from "../domain/chat.ts";
import type { BackendLocale, BackendMessageKey } from "../i18n/message.ts";
import { localizePublicValue } from "../i18n/projection.ts";
import type { ConnectionPoolSnapshot } from "./ssh-channel-broker.ts";
import type { RemoteNetworkMetrics } from "../domain/remote-network-metrics.ts";

export interface RemoteMetricsSnapshot {
	workspaceId: string;
	sampledAt: number;
	cpu: { usagePercent: number; cores: number; loadAverage: [number, number, number] };
	memory: { usedBytes: number; totalBytes: number; usagePercent: number };
	network?: RemoteNetworkMetrics;
	filesystems: Array<{
		device: string;
		mountPoint: string;
		usedBytes: number;
		totalBytes: number;
		usagePercent: number;
	}>;
	uptimeSeconds: number;
	processes: Array<{
		pid: number;
		parentPid: number;
		user: string;
		state: string;
		cpuPercent: number;
		memoryPercent: number;
		residentBytes: number;
		elapsedSeconds: number;
		command: string;
	}>;
}

export type WorkspaceEvent =
	| { type: "stream.ready"; data: { workspaceId: string; connectedAt: number } }
	| { type: "monitor.snapshot"; data: RemoteMetricsSnapshot }
	| {
			type: "monitor.error";
			data: { sampledAt: number; code: string; message: string; messageKey?: BackendMessageKey };
	  }
	| { type: "connection.snapshot"; data: ConnectionPoolSnapshot }
	| { type: "session.updated"; data: Pick<Session, "id" | "workspaceId" | "displayName" | "revision" | "updatedAt"> }
	| { type: "transfer.updated"; data: FileTransfer }
	| { type: "diagnose.task.updated"; data: DiagnoseTask }
	| { type: "diagnose.node.updated"; data: { sessionId: string; workspaceId: string; node: DiagnoseNode } }
	| { type: "diagnose.message.created" | "diagnose.message.updated"; data: { sessionId: string; message: ChatMessageProjection } }
	| { type: "deployment.updated"; data: DeploymentRun }
	| { type: "deployment.started" | "deployment.finished"; data: DeploymentModeView }
	| { type: "deployment.message.created" | "deployment.message.updated"; data: { sessionId: string; message: ChatMessageProjection } }
	| { type: "deployment.log.appended"; data: DeploymentLogChunk & { sessionId: string } }
	| { type: "deployment.stage.updated"; data: { sessionId: string; deploymentRunId: string; stage: DeploymentExecutableStage;
		revision: number; view: DeploymentStageView } }
	| { type: "deployment.discussion.updated"; data: DeploymentDiscussion };

export type WorkspaceEventTopic = "monitoring" | "connection" | "transfers" | "sessions" | "deployments" | "diagnoses";

interface Subscriber {
	topics: ReadonlySet<WorkspaceEventTopic>;
	controller: ReadableStreamDefaultController<Uint8Array>;
	locale: BackendLocale;
}

export class WorkspaceEventHub {
	private readonly subscribers = new Map<string, Set<Subscriber>>();
	private readonly topicListeners = new Set<
		(workspaceId: string, topic: WorkspaceEventTopic, count: number) => void
	>();
	private sequence = 0;
	private closed = false;
	private readonly snapshotProviders = new Map<WorkspaceEventTopic, (workspaceId: string) => readonly WorkspaceEvent[]>();

	/** Initial snapshots are sent only to the new subscriber, without invoking remote work. */
	registerSnapshotProvider(topic: WorkspaceEventTopic, provider: (workspaceId: string) => readonly WorkspaceEvent[]): () => void {
		this.snapshotProviders.set(topic, provider);
		return () => {
			if (this.snapshotProviders.get(topic) === provider) this.snapshotProviders.delete(topic);
		};
	}

	subscribe(
		workspaceId: string,
		topics: ReadonlySet<WorkspaceEventTopic>,
		locale: BackendLocale = "zh-CN",
	): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		let subscriber: Subscriber | undefined;
		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				if (this.closed) {
					controller.close();
					return;
				}
				subscriber = { topics, controller, locale };
				const workspaceSubscribers = this.subscribers.get(workspaceId) ?? new Set<Subscriber>();
				this.subscribers.set(workspaceId, workspaceSubscribers);
				workspaceSubscribers.add(subscriber);
				controller.enqueue(
					encoder.encode(
						formatEvent(++this.sequence, {
							type: "stream.ready",
							data: { workspaceId, connectedAt: Date.now() },
						}),
					),
				);
				for (const topic of topics) {
					for (const event of this.snapshotProviders.get(topic)?.(workspaceId) ?? []) {
						controller.enqueue(encoder.encode(formatEvent(++this.sequence, {
							...event, data: localizePublicValue(event.data, locale),
						})));
					}
					this.notify(workspaceId, topic);
				}
			},
			cancel: () => {
				if (!subscriber) return;
				const workspaceSubscribers = this.subscribers.get(workspaceId);
				workspaceSubscribers?.delete(subscriber);
				if (workspaceSubscribers?.size === 0) this.subscribers.delete(workspaceId);
				for (const topic of topics) this.notify(workspaceId, topic);
			},
		});
	}

	publish(workspaceId: string, event: WorkspaceEvent): void {
		const topic = topicFor(event.type);
		const sequence = ++this.sequence;
		for (const subscriber of this.subscribers.get(workspaceId) ?? []) {
			if (!subscriber.topics.has(topic)) continue;
			try {
				subscriber.controller.enqueue(
					new TextEncoder().encode(
						formatEvent(sequence, { ...event, data: localizePublicValue(event.data, subscriber.locale) }),
					),
				);
			} catch {
				/* cancelled stream */
			}
		}
	}

	heartbeat(): void {
		const payload = new TextEncoder().encode(": heartbeat\n\n");
		for (const subscribers of this.subscribers.values())
			for (const subscriber of subscribers) {
				try {
					subscriber.controller.enqueue(payload);
				} catch {
					/* cancelled stream */
				}
			}
	}

	onTopicCountChange(listener: (workspaceId: string, topic: WorkspaceEventTopic, count: number) => void): () => void {
		this.topicListeners.add(listener);
		return () => this.topicListeners.delete(listener);
	}

	count(workspaceId: string, topic: WorkspaceEventTopic): number {
		let count = 0;
		for (const subscriber of this.subscribers.get(workspaceId) ?? []) if (subscriber.topics.has(topic)) count += 1;
		return count;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const subscribers of this.subscribers.values())
			for (const subscriber of subscribers) subscriber.controller.close();
		this.subscribers.clear();
		this.snapshotProviders.clear();
	}

	private notify(workspaceId: string, topic: WorkspaceEventTopic): void {
		const count = this.count(workspaceId, topic);
		for (const listener of this.topicListeners) listener(workspaceId, topic, count);
	}
}

function topicFor(type: WorkspaceEvent["type"]): WorkspaceEventTopic {
	if (type === "session.updated") return "sessions";
	if (type.startsWith("deployment.")) return "deployments";
	if (type.startsWith("diagnose.")) return "diagnoses";
	if (type.startsWith("monitor.")) return "monitoring";
	if (type === "connection.snapshot") return "connection";
	return "transfers";
}

function formatEvent(sequence: number, event: { readonly type: string; readonly data: unknown }): string {
	return `id: ${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
