"use client";

import { useIntl } from "react-intl";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-layout";
import { SessionSandboxBadge } from "@/features/session/components/session-sandbox-badge";

interface ChatStatusProps {
	active: boolean;
	runStatus?: string;
	connection: string;
	queueCount: number;
}

interface ChatPageHeaderProps extends ChatStatusProps {
	title: string;
	sandboxEnabled: boolean;
	serverMetrics?: ReactNode;
}

export function ChatPageHeader({ title, sandboxEnabled, serverMetrics, active, runStatus, connection, queueCount }: ChatPageHeaderProps) {
	return (
		<PageHeader
			title={title}
			compact
			actions={<>
				{serverMetrics}
				<SessionSandboxBadge enabled={sandboxEnabled} />
				<ChatStatus active={active} runStatus={runStatus} connection={connection} queueCount={queueCount} />
			</>}
		/>
	);
}

function ChatStatus({ active, runStatus, connection, queueCount }: ChatStatusProps) {
	const intl = useIntl();
	if (!active && runStatus !== "failed" && runStatus !== "cancelled") return null;
	const reconnecting = active && connection === "reconnecting";
	const label = intl.formatMessage({ id: reconnecting ? "chat.status.reconnecting" : active ? queueCount > 0 ? "chat.status.runningQueued" : "chat.status.running" : runStatus === "failed" ? "chat.status.failed" : "chat.status.cancelled" }, { count: queueCount });
	return <span role="status" className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium ${reconnecting ? "bg-warning-soft text-warning" : active ? "bg-success-soft text-accent" : runStatus === "failed" ? "bg-danger-soft text-danger" : "bg-surface-muted text-secondary"}`}><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${reconnecting ? "bg-warning" : active ? "bg-accent" : runStatus === "failed" ? "bg-danger" : "bg-faint"}`} />{label}</span>;
}
