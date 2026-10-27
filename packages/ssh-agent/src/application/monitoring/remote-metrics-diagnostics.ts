import { randomUUID } from "node:crypto";

type SampleStage = "resolve_target" | "base_probe" | "process_probe" | "parse" | "publish";
type SampleTrigger = "initial" | "base_timer" | "process_timer";
type SampleOutcome = "completed" | "failed" | "inactive_collector";
interface QueueDepth { waiting: number; running: number; }
interface QueuedSample {
	sampleId: string;
	queuedAt: number;
	includeProcesses: boolean;
	trigger: SampleTrigger;
	queueDepthAtEnqueue: QueueDepth;
}

const SLOW_SAMPLE_MS = 1_000;

/** Diagnostics observe the existing Promise queue; they never schedule or suppress a sample. */
export class RemoteMetricsCollectorDiagnostics {
	readonly collectorId = randomUUID();
	private sequence = 0;
	private waiting = 0;
	private running = 0;
	private readonly workspaceId: string;

	constructor(workspaceId: string) {
		this.workspaceId = workspaceId;
	}

	enqueue(includeProcesses: boolean, trigger: SampleTrigger): QueuedSample {
		this.waiting++;
		return {
			sampleId: `${this.collectorId}:${++this.sequence}`,
			queuedAt: Date.now(), includeProcesses, trigger,
			queueDepthAtEnqueue: this.queueDepth(),
		};
	}

	start(sample: QueuedSample): RemoteMetricsSampleDiagnostics {
		this.waiting--;
		this.running++;
		return new RemoteMetricsSampleDiagnostics(this, sample);
	}

	queueDepth(): QueueDepth {
		return { waiting: this.waiting, running: this.running };
	}

	finished(): void { this.running--; }

	fields() {
		return { workspaceId: this.workspaceId, collectorId: this.collectorId, queueDepth: this.queueDepth() };
	}

	lifecycle(event: "collector.started" | "collector.stop_scheduled" | "collector.stop_cancelled" | "collector.stopped",
		reason?: "no_subscribers" | "service_closed"): void {
		logDiagnostic(event, { ...this.fields(), ...(reason ? { reason } : {}) });
	}
}

export class RemoteMetricsSampleDiagnostics {
	outcome: SampleOutcome = "completed";
	private stage: SampleStage = "resolve_target";
	private readonly collector: RemoteMetricsCollectorDiagnostics;
	private readonly sample: QueuedSample;
	private readonly startedAt = Date.now();
	private stageStartedAt = this.startedAt;
	private readonly stageDurationsMs: Partial<Record<SampleStage, number>> = {};
	private readonly queueDepthAtStart: QueueDepth;
	private readonly queueWaitMs: number;

	constructor(collector: RemoteMetricsCollectorDiagnostics, sample: QueuedSample) {
		this.collector = collector;
		this.sample = sample;
		this.queueDepthAtStart = collector.queueDepth();
		this.queueWaitMs = Math.max(0, this.startedAt - sample.queuedAt);
		if (this.queueWaitMs >= SLOW_SAMPLE_MS) logDiagnostic("sample.started", this.fields());
	}

	enter(stage: SampleStage): void {
		const now = Date.now();
		this.stageDurationsMs[this.stage] = Math.max(0, now - this.stageStartedAt);
		this.stage = stage;
		this.stageStartedAt = now;
	}

	fields() {
		const now = Date.now();
		return {
			...this.collector.fields(), ...this.sample,
			startedAt: this.startedAt, queueWaitMs: this.queueWaitMs,
			queueDepthAtStart: { ...this.queueDepthAtStart },
			stage: this.stage, outcome: this.outcome,
			sampleDurationMs: Math.max(0, now - this.startedAt),
			stageDurationsMs: { ...this.stageDurationsMs, [this.stage]: Math.max(0, now - this.stageStartedAt) },
		};
	}

	finish(): void {
		const fields = this.fields();
		this.collector.finished();
		if (this.queueWaitMs >= SLOW_SAMPLE_MS || fields.sampleDurationMs >= SLOW_SAMPLE_MS) {
			logDiagnostic("sample.finished", { ...fields, finishedAt: Date.now(), queueDepth: this.collector.queueDepth() });
		}
	}
}

function logDiagnostic(event: string, fields: object): void {
	try {
		console.info("SSH Agent remote metrics diagnostics", { event, ...fields });
	} catch {
		// Diagnostic output must not change collector lifecycle or queue progress.
	}
}
