"use client";

import { ChevronDown, ShieldAlert } from "lucide-react";
import { useIntl } from "react-intl";
import type { DeploymentRemoteStage, DeploymentRun, DeployStage } from "../model/deployment";
import { deploymentRemoteStageAccess } from "../model/deployment";

export function FullAccessNotice({ run, stages }: { run: DeploymentRun; stages: readonly DeploymentRemoteStage[] }) {
	const intl = useIntl();
	const identity = [run.plan.targetBinding.remoteUser, "@", run.plan.target.host, ":", run.plan.targetBinding.port].join("");
	return <details className="group mt-4 rounded-lg border border-[var(--warning-line)] bg-[var(--warning-soft)] px-3 py-2.5 text-xs text-warning" role="group" aria-label={intl.formatMessage({ id: "deploy.fullAccess.title" })}>
		<summary className="chat-disclosure-trigger flex w-full gap-2 !text-warning"><ShieldAlert size={14} aria-hidden="true" /><span className="flex-1">{intl.formatMessage({ id: "deploy.fullAccess.compact" })}</span><ChevronDown size={14} className="transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
		<div className="mt-3 border-t border-[var(--warning-line)] pt-3 leading-5 text-secondary">
			<p>{intl.formatMessage({ id: "deploy.fullAccess.notice" }, { host: identity })}</p>
			<ul className="mt-2 space-y-1">{stages.map((stage) => {
				const access = deploymentRemoteStageAccess(run.plan, stage);
				return access.mode === "full_access" && access.reason !== "session_sandbox_disabled" ? <li key={stage}>
					<span className="font-semibold">{intl.formatMessage({ id: `deploy.stage.${stage}` })}：</span>
					{intl.formatMessage({ id: `deploy.fullAccess.reason.${access.reason}` })}
				</li> : null;
			})}</ul>
			<p className="mt-1 break-all">{intl.formatMessage({ id: "deploy.fullAccess.fingerprint" }, { fingerprint: run.plan.targetBinding.hostKeyFingerprint })}</p>
		</div>
	</details>;
}

export function RecoveryReview({ run, busy, readOnly, onDecide }: {
	run: DeploymentRun;
	busy: boolean;
	readOnly: boolean;
	onDecide(proposalId: string, approved: boolean): void;
}) {
	const intl = useIntl();
	const proposal = run.recoveries?.at(-1);
	if (!proposal || proposal.status === "rejected") return null;
	if (proposal.status === "approved") return <p className="mt-3 rounded-lg bg-[var(--success-soft)] px-3 py-2 text-xs text-accent">{intl.formatMessage({ id: "deploy.recovery.approved" })}</p>;
	return <section className="mt-4 rounded-xl border border-[var(--warning-line)] bg-[var(--warning-soft)] px-4 py-3" aria-label={intl.formatMessage({ id: "deploy.recovery.title" })}>
		<p className="text-sm font-medium text-ink">{intl.formatMessage({ id: "deploy.recovery.title" })} · {intl.formatMessage({ id: `deploy.stage.${proposal.stage}` })}</p>
		<p className="mt-1 text-xs leading-5 text-secondary">{proposal.reason}</p>
		<details className="group mt-3 text-xs">
			<summary className="chat-disclosure-trigger !text-warning">{intl.formatMessage({ id: "deploy.recovery.review" })}<ChevronDown size={14} className="transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
			<div className="mt-3 grid gap-2 sm:grid-cols-2">
				<div className="min-w-0 rounded-lg border border-line bg-surface-raised p-3"><p className="font-medium text-muted">{intl.formatMessage({ id: "deploy.recovery.before" })}</p><StepSummary run={run} stage={proposal.stage} /></div>
				<div className="min-w-0 rounded-lg border border-line bg-surface-raised p-3"><p className="font-medium text-accent">{intl.formatMessage({ id: "deploy.recovery.after" })}</p><StepSummary run={{ ...run, plan: proposal.plan }} stage={proposal.stage} /></div>
			</div>
			{proposal.stage === "build" && run.plan.version === 2 && JSON.stringify(run.plan.artifacts) !== JSON.stringify(proposal.plan.artifacts)
				? <div className="mt-3"><p className="font-medium text-ink">{intl.formatMessage({ id: "deploy.stage.upload" })}</p><div className="mt-2 grid gap-2 sm:grid-cols-2">
					<div className="min-w-0 rounded-lg border border-line bg-surface-raised p-3"><p className="font-medium text-muted">{intl.formatMessage({ id: "deploy.recovery.before" })}</p><StepSummary run={run} stage="upload" /></div>
					<div className="min-w-0 rounded-lg border border-line bg-surface-raised p-3"><p className="font-medium text-accent">{intl.formatMessage({ id: "deploy.recovery.after" })}</p><StepSummary run={{ ...run, plan: proposal.plan }} stage="upload" /></div>
				</div></div> : null}
			{proposal.stage !== "build" ? <p className="mt-3 text-xs leading-5 text-warning">{intl.formatMessage({ id: "deploy.recovery.effects" })}</p> : null}
			{!readOnly ? <div className="mt-3 flex flex-wrap gap-2">
				<button type="button" disabled={busy} onClick={() => onDecide(proposal.id, true)} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-[var(--text-inverse)] disabled:opacity-50">{intl.formatMessage({ id: "deploy.recovery.approve" })}</button>
				<button type="button" disabled={busy} onClick={() => onDecide(proposal.id, false)} className="rounded-lg border border-line px-3 py-1.5 text-xs text-secondary disabled:opacity-50">{intl.formatMessage({ id: "deploy.recovery.reject" })}</button>
			</div> : null}
		</details>
	</section>;
}

export function StepSummary({ run, stage }: { run: DeploymentRun; stage: DeployStage }) {
	const intl = useIntl();
	if (stage === "prepare") return <p className="mt-1 break-all text-xs text-muted">{run.plan.profilePath.split(/[\\/]/u).at(-1)} · {run.plan.target.host}</p>;
	if (stage === "build") {
		const steps = run.plan.version === 2 ? run.plan.buildSteps : [run.plan.build];
		return <ol className="mt-1 space-y-2">
			{steps.map((step, index) => <li key={`${index}:${step.cwd}:${step.command}`} className="min-w-0">
				<p className="break-all text-xs text-muted">{steps.length > 1 ? `${index + 1}. ` : ""}{step.cwd}</p>
				<CommandText command={step.command} />
			</li>)}
		</ol>;
	}
	if (stage === "upload") {
		const artifacts = run.plan.version === 2 ? run.plan.artifacts
			: [{ source: run.plan.build.artifact, remotePath: run.plan.upload.remotePath }];
		return <div className="mt-1.5">
			<ol className="space-y-1.5 font-mono text-[11px] leading-5 text-secondary">
				{artifacts.map((artifact, index) => <li key={`${artifact.source}:${artifact.remotePath}`} className="min-w-0 break-all">
					{artifacts.length > 1 ? `${index + 1}. ` : ""}<span className="sr-only">{intl.formatMessage({ id: "deploy.upload.source" })}: </span><span>{artifact.source}</span><span aria-hidden="true" className="px-1 text-muted">→</span><span className="sr-only">{intl.formatMessage({ id: "deploy.upload.target" })}: </span><span className="font-medium text-ink">{artifact.remotePath}</span>
				</li>)}
			</ol>
			<p className="mt-1 text-[11px] text-muted">{intl.formatMessage({ id: "deploy.overwrite" })}</p>
		</div>;
	}
	if (stage === "restart") return <CommandText command={run.plan.restart.command} />;
	return run.plan.verify ? <CommandText command={run.plan.verify.command} />
		: <p className="mt-1 text-xs text-muted">{intl.formatMessage({ id: "deploy.skip" })}</p>;
}

function CommandText({ command }: { command: string }) {
	return <code className="mt-2 block max-h-24 overflow-auto whitespace-pre-wrap break-all border-l-2 border-line-strong pl-2.5 font-mono text-[11px] leading-5 text-secondary">{command}</code>;
}
