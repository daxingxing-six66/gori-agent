"use client";

import { LoaderCircle } from "lucide-react";
import { memo } from "react";
import { useIntl } from "react-intl";
import { ChatFailureDetails } from "@/features/chat/components/chat-failure-details";
import { ChatMessageRow } from "@/features/chat/components/chat-message";
import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import type { ChatRun, ChatToolExecution, ToolApproval } from "@/features/chat/model/chat";

export const ChatTimeline = memo(function ChatTimeline({
	showActivity,
	loading,
	loadingOlderMessages,
	timeline,
	tools,
	approvals,
	approvalMutationId,
	run,
	latestUserText,
	onResolveApproval,
	onRestoreDraft,
}: {
	showActivity: boolean;
	loading: boolean;
	loadingOlderMessages: boolean;
	timeline: ChatTimelineEntry[];
	tools: Record<string, ChatToolExecution>;
	approvals: Record<string, ToolApproval>;
	approvalMutationId: string | null;
	run: ChatRun | null;
	latestUserText: string;
	onResolveApproval(approval: ToolApproval, approved: boolean): void;
	onRestoreDraft(message: string): void;
}) {
	const intl = useIntl();
	const visibleTimeline = timeline.filter((entry) => entry.message.role !== "system");
	return (
		<div className="mx-auto min-h-full max-w-[820px] space-y-8 px-5 pb-10 pt-10 lg:px-8">
			{loading ? <div className="flex justify-center py-16 text-zinc-400"><LoaderCircle size={18} className="animate-spin" /></div> : null}
			{loadingOlderMessages ? <div className="flex justify-center py-1.5 text-zinc-400" role="status" aria-label={intl.formatMessage({ id: "chat.history.loadingOlder" })}><LoaderCircle size={14} className="animate-spin" /></div> : null}
			{!loading && !showActivity && visibleTimeline.length === 0 ? <div className="grid min-h-[320px] place-items-center text-center"><div><p className="text-[13px] font-semibold text-zinc-700">{intl.formatMessage({ id: "chat.empty.title" })}</p><p className="mt-2 text-[10px] leading-5 text-zinc-400">{intl.formatMessage({ id: "chat.empty.description" })}</p></div></div> : null}
			{visibleTimeline.map((entry) => <ChatMessageRow key={entry.key} entry={entry} tools={tools} approvals={approvals} approvalMutationId={approvalMutationId} hideFailure={Boolean(run?.status === "failed" && run.failure?.errorId && entry.message.role === "assistant" && entry.message.failure?.errorId === run.failure.errorId)} onResolveApproval={onResolveApproval} />)}
			{showActivity ? <div role="status" aria-label={intl.formatMessage({ id: "chat.status.running" })} className="flex h-9 w-full items-center justify-center gap-1 text-[var(--text-secondary)]">
				{[0, 160, 320].map((delay) => <span key={delay} aria-hidden="true" className="h-1 w-1 rounded-full bg-current motion-safe:animate-pulse" style={{ animationDelay: `${delay}ms`, animationDuration: "1.2s" }} />)}
			</div> : null}
			{run?.status === "failed" ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[10px] text-rose-700"><p className="font-semibold">{intl.formatMessage({ id: "chat.run.failed" })}</p><ChatFailureDetails failure={run.failure} fallback={intl.formatMessage({ id: "chat.run.failed.fallback" })} />{run.failure?.retryable && latestUserText ? <button type="button" className="mt-2 font-semibold underline" onClick={() => onRestoreDraft(latestUserText)}>{intl.formatMessage({ id: "chat.run.restoreDraft" })}</button> : null}</div> : null}
		</div>
	);
});
