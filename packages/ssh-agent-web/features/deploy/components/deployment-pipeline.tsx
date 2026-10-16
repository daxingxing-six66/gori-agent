"use client";

import { Check, Circle, CircleX, LoaderCircle, Minus } from "lucide-react";
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { DEPLOY_STAGES, type DeploymentExecutableStage, type DeploymentRun, type DeployStage } from "../model/deployment";
import type { DeploymentTask } from "../model/deployment-task";
import type { DeploymentLogStore } from "../runtime/deployment-log-store";
import { DeploymentLogs } from "./deployment-logs";
import { DeploymentStageIcon } from "./deployment-stage-icon";
import { DeploymentBuildSteps } from "./deployment-build-steps";
import { DeploymentPlanOverview } from "./deployment-plan-overview";
import "./deployment-plan.css";

const EXECUTION_STAGES = DEPLOY_STAGES.filter((stage): stage is DeploymentExecutableStage => stage !== "prepare");

/** Preparation exposes the reviewed plan; executable stages expose their facts and logs. */
export function DeploymentPipeline({ run, task, logs }: { run: DeploymentRun; task: DeploymentTask | null; logs: DeploymentLogStore }) {
	const intl = useIntl();
	const [selected, setSelected] = useState<{ runId: string; stage: DeployStage } | null>(null);
	const [now, setNow] = useState(Date.now);
	useEffect(() => { if (run.status !== "running") return; const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, [run.id, run.status]);
	const current = DEPLOY_STAGES.find((stage) => run.stages[stage].status === "running")
		?? DEPLOY_STAGES.find((stage) => run.stages[stage].status === "failed")
		?? task?.stage
		?? DEPLOY_STAGES.filter((stage) => run.stages[stage].status === "success" || run.stages[stage].status === "skipped").at(-1) ?? "prepare";
	const stage = selected?.runId === run.id ? selected.stage : current;
	return <>
		<ol className="deploy-stage-overview" aria-label={intl.formatMessage({ id: "deploy.pipeline" })}>
			{DEPLOY_STAGES.map((name) => <li key={name} data-status={run.stages[name].status} data-current={name === current} data-selected={name === stage}>
				<button type="button" aria-pressed={name === stage} aria-current={name === current ? "step" : undefined}
					aria-label={`${intl.formatMessage({ id: `deploy.stage.${name}` })} · ${intl.formatMessage({ id: `deploy.status.${run.stages[name].status}` })}`}
					onClick={() => setSelected({ runId: run.id, stage: name })}>
					<span className="deploy-stage-node"><DeploymentStageIcon stage={name} size={18} />
						{run.stages[name].status !== "pending" ? <span className="deploy-stage-node-status"><DeploymentStatusIcon status={run.stages[name].status} size={9} /></span> : null}</span>
					<span>{intl.formatMessage({ id: `deploy.stage.${name}` })}</span>
				</button></li>)}
		</ol>
		{stage ? <div className="deploy-stage-facts"><div className="deploy-stage-title"><h3>{intl.formatMessage({ id: `deploy.stage.${stage}` })}</h3>
			<span>{intl.formatMessage({ id: `deploy.status.${run.stages[stage].status}` })}{run.stages[stage].startedAt ? ` · ${intl.formatMessage({ id: "deploy.task.elapsed" }, { seconds: Math.max(0, Math.floor(((run.stages[stage].finishedAt ?? now) - run.stages[stage].startedAt!) / 1000)) })}` : ""}</span></div>
			{stage === "prepare" ? <section className="deploy-stage-plan" aria-label={intl.formatMessage({ id: "deploy.plan.title" })}><DeploymentPlanOverview plan={run.plan} /></section> : null}
			{stage === "build" ? <DeploymentBuildSteps run={run} /> : null}
			{stage === "upload" && run.stages.upload.artifact ? <ArtifactProgress artifact={run.stages.upload.artifact} /> : null}
			{run.stages[stage].error ? <p role="alert" className="deploy-task-error">{run.stages[stage].error}</p> : null}
		</div> : null}
		<div className="deploy-stage-logs" hidden={stage === "prepare"}>{EXECUTION_STAGES.map((name) => <div key={`${run.id}:${name}`} hidden={name !== stage} className="deploy-stage-log-page"><DeploymentLogs run={run} stage={name} store={logs} /></div>)}</div>
	</>;
}

export function DeploymentStatusIcon({ status, size = 15 }: { status: DeploymentRun["stages"][DeployStage]["status"]; size?: number }) {
	const Icon = status === "success" ? Check : status === "running" ? LoaderCircle : status === "failed" ? CircleX : status === "skipped" ? Minus : Circle;
	return <Icon size={size} aria-hidden="true" className={status === "running" ? "motion-safe:animate-spin" : undefined} />;
}

function ArtifactProgress({ artifact }: { artifact: NonNullable<DeploymentRun["stages"]["upload"]["artifact"]> }) {
	const percent = artifact.totalBytes > 0 ? Math.round(artifact.bytesTransferred / artifact.totalBytes * 100) : null;
	const bytes = (value: number) => {
		if (value < 1024) return `${value} B`;
		const unit = value < 1024 ** 2 ? 1 : value < 1024 ** 3 ? 2 : 3;
		return `${(value / 1024 ** unit).toFixed(1)} ${["B", "KiB", "MiB", "GiB"][unit]}`;
	};
	return <div className="deploy-artifact"><div><strong>{artifact.source.split(/[\\/]/u).at(-1)}</strong><span>{percent === null ? "—" : `${percent}%`}</span></div>
		<p>{artifact.remotePath}</p><progress aria-label={artifact.source} value={artifact.bytesTransferred} max={artifact.totalBytes || 1} />
		<div><span>{bytes(artifact.bytesTransferred)} / {bytes(artifact.totalBytes)}</span><span>{artifact.index} / {artifact.count}</span></div></div>;
}
