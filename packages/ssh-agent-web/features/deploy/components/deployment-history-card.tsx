"use client";

import { ChevronRight, Rocket } from "lucide-react";
import { useIntl } from "react-intl";
import { DEPLOY_STAGES, type DeploymentRun } from "../model/deployment";
import { deploymentHistoryTime } from "../model/deployment-history";

export function DeploymentHistoryCard({ run, onOpen }: { run: DeploymentRun; onOpen(): void }) {
	const intl = useIntl();
	const completed = DEPLOY_STAGES.filter((stage) => ["success", "skipped"].includes(run.stages[stage].status)).length;
	const timestamp = deploymentHistoryTime(run);
	return <button type="button" onClick={onOpen} data-deployment-id={run.id}
		aria-label={intl.formatMessage({ id: "deploy.history.open" }, { module: run.plan.module.name })}
		className="group flex w-full min-w-0 items-start gap-3 rounded-2xl border border-line bg-surface-raised px-4 py-3 text-left shadow-[var(--shadow-soft)] transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
		<span className={["mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full", iconTone(run.status)].join(" ")}><Rocket size={14} aria-hidden="true" /></span>
		<span className="min-w-0 flex-1">
			<span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium text-ink">
				<span>{intl.formatMessage({ id: "deploy.history.title" })}</span>
				<span className="text-xs font-normal text-secondary">{run.plan.module.name} · {run.plan.target.host}</span>
			</span>
			<span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
				<span className={run.status === "failed" ? "text-danger" : run.status === "success" ? "text-accent" : "text-secondary"}>{intl.formatMessage({ id: `deploy.runStatus.${run.status}` })}</span>
				<span>{intl.formatMessage({ id: "deploy.pipeline.progress" }, { completed, total: DEPLOY_STAGES.length })}</span>
				<time dateTime={new Date(timestamp).toISOString()}>{intl.formatDate(timestamp, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
			</span>
			{run.error ? <span className="mt-1 line-clamp-2 break-words text-[11px] text-danger">{run.error}</span> : null}
		</span>
		<ChevronRight size={16} className="mt-1 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
	</button>;
}

function iconTone(status: DeploymentRun["status"]): string {
	if (status === "success" || status === "running") return "bg-[var(--success-soft)] text-accent";
	if (status === "failed") return "bg-[var(--danger-soft)] text-danger";
	return "bg-surface-muted text-secondary";
}
