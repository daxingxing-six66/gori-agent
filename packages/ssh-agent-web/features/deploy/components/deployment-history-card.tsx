"use client";

import { Circle, CircleCheck, CircleMinus, CircleX, Clock3, LoaderCircle, Rocket } from "lucide-react";
import { useIntl } from "react-intl";
import { deploymentEntryId, deploymentEntrySummary, type DeploymentConversationEntry, type DeploymentHistoryStatus } from "../model/deployment-history-entry";
import "./deployment-history-card.css";

const statusIcons = {
	preparing: Circle, running: LoaderCircle, recovering: Circle,
	success: CircleCheck, failed: CircleX, cancelled: CircleMinus, discussing: Circle,
} satisfies Record<DeploymentHistoryStatus, typeof Circle>;

/** Deployment-owned history presentation; ordinary tool/transfer cards never render this entry. */
export function DeploymentHistoryCard({ entry, onOpen }: { entry: DeploymentConversationEntry; onOpen(): void }) {
	const intl = useIntl();
	const { title, status, startedAt, finishedAt } = deploymentEntrySummary(entry);
	const StatusIcon = statusIcons[status];
	const statusLabel = intl.formatMessage({ id: status === "discussing" ? "deploy.task.discussion" : `deploy.runStatus.${status}` });
	return <button type="button" className="deployment-history-card" data-status={status} data-deployment-id={deploymentEntryId(entry)}
		data-deployment-discussion-id={entry.kind === "discussion" ? entry.discussion.id : undefined} onClick={onOpen}
		aria-label={`${intl.formatMessage({ id: "deploy.history.open" }, { module: title })}, ${statusLabel}`}>
		<Rocket className="deployment-history-card-icon" size={16} strokeWidth={1.6} aria-hidden="true" />
		<span className="deployment-history-card-title" title={title}>{title}</span>
		{finishedAt !== undefined && startedAt !== undefined ? <span className="deployment-history-card-duration" title={intl.formatMessage({ id: "deploy.history.elapsed" })}>
			<Clock3 size={12} aria-hidden="true" />{duration(Math.max(0, Math.round((finishedAt - startedAt) / 1000)))}
		</span> : null}
		<span className="deployment-history-card-status" title={statusLabel} aria-hidden="true"><StatusIcon size={18} strokeWidth={1.8} /></span>
	</button>;
}

function duration(seconds: number): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return seconds < 3600 ? `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
		: `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}
