"use client";

import { ChevronDown } from "lucide-react";
import { useIntl } from "react-intl";
import { ChatMessageRow } from "@/features/chat/components/chat-message";
import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import type { ChatToolExecution, ToolApproval } from "@/features/chat/model/chat";

interface Props {
	entries: ChatTimelineEntry[];
	tools: Record<string, ChatToolExecution>;
	approvals: Record<string, ToolApproval>;
	approvalMutationId: string | null;
	targetHost?: string;
	onResolveApproval(approval: ToolApproval, approved: boolean): void;
	expanded: boolean;
	hasOlderMessages: boolean;
}

export function DeploymentModelActivity(props: Props) {
	const intl = useIntl();
	const visible = props.entries.filter((entry) => entry.message.role !== "system" && entry.message.role !== "toolResult");
	const pendingToolIds = new Set(Object.values(props.approvals)
		.filter((approval) => approval.status === "pending")
		.map((approval) => approval.toolCallId));
	const needsAction = visible.filter((entry) => entry.message.role === "assistant" &&
		entry.message.content.some((part) => part.type === "toolCall" && pendingToolIds.has(part.id)));
	const recorded = visible.filter((entry) => !needsAction.includes(entry));
	if (!props.expanded && needsAction.length === 0) return null;
	if (props.expanded && visible.length === 0 && !props.hasOlderMessages) return null;
	const latestText = [...recorded].reverse().flatMap((entry) => entry.message.role === "assistant"
		? entry.message.content.flatMap((part) => part.type === "text" && part.text.trim() ? [part.text.trim()] : [])
		: [])[0];
	return <section aria-label={intl.formatMessage({ id: "deploy.activity.title" })} className={props.expanded ? "mt-5 border-t border-line-soft pt-4" : "border-t border-line-soft px-4 py-3"}>
		{needsAction.length > 0 ? <div className="space-y-3">
			{needsAction.map((entry) => <ChatMessageRow key={entry.key} entry={entry} tools={props.tools} approvals={props.approvals} approvalMutationId={props.approvalMutationId} targetHost={props.targetHost} onResolveApproval={props.onResolveApproval} />)}
		</div> : null}
		{props.expanded && recorded.length > 0 ? <div className={needsAction.length > 0 ? "mt-4" : ""}>
			{latestText ? <p className="line-clamp-2 whitespace-pre-wrap break-words text-xs leading-5 text-secondary">{latestText.slice(0, 240)}</p> : null}
			<details className="group mt-2 text-xs">
				<summary className="chat-disclosure-trigger">{intl.formatMessage({ id: "deploy.activity.title" })}<ChevronDown size={14} className="transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
				<div className="app-scrollbar mt-3 max-h-[34rem] overflow-y-auto border-l border-line-soft pl-3 [&>*+*]:mt-4 [&>.chat-tool-only+.chat-tool-only]:mt-1">
					{recorded.map((entry) => <ChatMessageRow key={entry.key} entry={entry} tools={props.tools} approvals={props.approvals} approvalMutationId={props.approvalMutationId} targetHost={props.targetHost} onResolveApproval={props.onResolveApproval} />)}
				</div>
			</details>
		</div> : null}
		{props.expanded && props.hasOlderMessages ? <p className="mt-2 text-[11px] leading-5 text-muted">{intl.formatMessage({ id: "deploy.activity.partial" })}</p> : null}
	</section>;
}
