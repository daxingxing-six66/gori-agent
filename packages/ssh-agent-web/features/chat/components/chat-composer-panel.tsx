"use client";

import { CornerDownLeft, LoaderCircle, Paperclip, Send, ShieldCheck, Square, X } from "lucide-react";
import { Fragment, forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef } from "react";
import { useIntl } from "react-intl";
import { ToggleSwitch } from "@/components/toggle-switch";
import { ChatComposerNotices } from "@/features/chat/components/chat-composer-notices";
import { ChatContextUsageIndicator } from "@/features/chat/components/chat-context-usage-indicator";
import type { ChatContextUsage } from "@/features/chat/model/chat-context-usage";
import { ChatAttachmentUploads } from "@/features/chat/components/chat-attachment-uploads";
import { useChatAttachmentUploads } from "@/features/chat/runtime/use-chat-attachment-uploads";
import { useChatComposerDraft } from "@/features/chat/runtime/use-chat-composer-draft";
import { ChatTokenEditor, type ChatComposerTool, type ChatTokenEditorHandle } from "@/features/chat/components/chat-token-editor";
import { hasChatComposerContent, visibleChatComposerText } from "@/features/chat/model/chat-composer";
import type { AgentMessage, ChatQueueEntry, ManualChatCompactionResult } from "@/features/chat/model/chat";
import { ModelThinkingSelector } from "@/features/llm-provider/components/model-thinking-selector";
import type { LlmModel, ThinkingLevel } from "@/features/llm-provider/model/llm-provider";
import { type SessionAttachment } from "@/features/session/api/session-attachment-api";

export interface ChatComposerPanelHandle {
	focus(): void;
	restoreDraft(message: string): void;
}

export const ChatComposerPanel = forwardRef<ChatComposerPanelHandle, {
	sessionId: string;
	recentUserTexts: readonly string[];
	contextUsage: ChatContextUsage | null;
	active: boolean;
	model: LlmModel | null;
	thinkingLevel: ThinkingLevel;
	modelSelectionLoading: boolean;
	modelSelectionError: string | null;
	modelSelectionRetryable: boolean;
	modelLabel?: string;
	onRetryModelSelection(): void;
	onSelectModel(model: LlmModel | null): void;
	onSelectThinkingLevel(level: ThinkingLevel): void;
	composerTools: readonly ChatComposerTool[];
	onToolSelect(toolId: string): void;
	submitting: boolean;
	cancelling: boolean;
	terminalBusy: boolean;
	onSubmit(message: string, attachments: SessionAttachment[]): Promise<boolean>;
	onOpenAttachment?(attachment: SessionAttachment): void;
	isLocalCommand?(message: string): boolean;
	onCancel(): void;
	autoAuditChecked: boolean;
	autoAuditPending: boolean;
	autoAuditError: unknown;
	onClearAutoAuditError(): void;
	onUpdateAutoAudit(checked: boolean): void;
	runtimeError: string | null;
	onClearRuntimeError(): void;
	manualCompactionResult: ManualChatCompactionResult | null;
	compacting: boolean;
	onClearManualCompactionResult(): void;
	queue: ChatQueueEntry[];
	queueMutationId: string | null;
	onCancelQueued(id: string): void;
	onPromoteQueued(id: string): void;
	decisionPanel?: ReactNode;
	aboveInputPanel?: ReactNode;
}>(function ChatComposerPanel({
	sessionId,
	recentUserTexts,
	contextUsage,
	active,
	model,
	thinkingLevel,
	modelSelectionLoading,
	modelSelectionError,
	modelSelectionRetryable,
	modelLabel,
	onRetryModelSelection,
	onSelectModel,
	onSelectThinkingLevel,
	composerTools,
	onToolSelect,
	submitting,
	cancelling,
	terminalBusy,
	onSubmit,
	onOpenAttachment,
	isLocalCommand,
	onCancel,
	autoAuditChecked,
	autoAuditPending,
	autoAuditError,
	onClearAutoAuditError,
	onUpdateAutoAudit,
	runtimeError,
	onClearRuntimeError,
	manualCompactionResult,
	compacting,
	onClearManualCompactionResult,
	queue,
	queueMutationId,
	onCancelQueued,
	onPromoteQueued,
	decisionPanel,
	aboveInputPanel,
}, forwardedRef) {
	const intl = useIntl();
	const editorRef = useRef<ChatTokenEditorHandle>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const latestSessionIdRef = useRef(sessionId);
	latestSessionIdRef.current = sessionId;
	const { draft, navigatingHistory, setDraft, clearForSubmission, navigateHistory } = useChatComposerDraft(sessionId);
	const attachmentUploads = useChatAttachmentUploads(sessionId);
	const { attachments, pending: hasPendingUploads } = attachmentUploads;
	const hasContent = hasChatComposerContent(draft);
	const hasSubmittableContent = hasContent || attachments.length > 0;
	const localCommand = isLocalCommand?.(draft) === true;
	const modelRequired = hasSubmittableContent && !localCommand && !active && model === null && !modelSelectionLoading;
	const canSubmit = !submitting && !terminalBusy && !hasPendingUploads && (localCommand || active || model !== null);

	useEffect(() => {
		if (fileInputRef.current) fileInputRef.current.value = "";
	}, [sessionId]);

	useImperativeHandle(forwardedRef, () => ({
		focus: () => editorRef.current?.focus(),
		restoreDraft: (message) => {
			setDraft(message);
			requestAnimationFrame(() => editorRef.current?.focus());
		},
	}), [setDraft]);

	const submit = async () => {
		const message = draft.trim();
		if ((!hasChatComposerContent(message) && attachments.length === 0) || !canSubmit) return;
		const submittedSessionId = sessionId;
		const restore = clearForSubmission();
		let accepted = false;
		try {
			accepted = await onSubmit(message, attachments);
		} finally {
			if (!accepted) restore();
		}
		if (latestSessionIdRef.current !== submittedSessionId) return;
		if (!accepted) return;
		attachmentUploads.clearSubmitted(attachments.map((attachment) => attachment.id));
	};

	return (
		<div className="session-console-composer chat-composer-dock z-20 shrink-0">
			<div className="chat-composer-content">
				<ChatComposerNotices
					runtimeError={runtimeError}
					autoAuditError={autoAuditError}
					compacting={compacting}
					manualCompactionResult={manualCompactionResult}
					onClearRuntimeError={onClearRuntimeError}
					onClearAutoAuditError={onClearAutoAuditError}
					onClearManualCompactionResult={onClearManualCompactionResult}
				/>
				<div className="chat-composer-shell border border-[var(--line)] bg-[var(--surface-strong)] px-3 pb-3 pt-2.5 transition">
					{/* Keep caller-provided keys separate from the Session-keyed editor. */}
					<Fragment key="above-input-panel">{aboveInputPanel}</Fragment>
					{decisionPanel}
					{modelSelectionError ? <div className="mb-1 flex w-full items-center justify-between gap-3 rounded-lg bg-[var(--warning-soft)] px-3 py-2 text-[11px] leading-5 text-[var(--warning)]"><span>{modelSelectionError}</span>{modelSelectionRetryable ? <button type="button" className="shrink-0 font-semibold underline underline-offset-2" onClick={onRetryModelSelection}>{intl.formatMessage({ id: "chat.model.reload" })}</button> : null}</div> : null}
					{queue.length > 0 ? <QueuePreview items={queue} active={active} mutationId={queueMutationId} onCancel={onCancelQueued} onPromote={onPromoteQueued} /> : null}
					<ChatAttachmentUploads uploads={attachmentUploads.uploads} limitNotice={attachmentUploads.limitNotice} onDismiss={attachmentUploads.dismiss} onOpenAttachment={onOpenAttachment} />
					<ChatTokenEditor key={sessionId} ref={editorRef} sessionId={sessionId} value={draft} navigatingHistory={navigatingHistory} placeholder={intl.formatMessage({ id: "session.new.composer.placeholder" })} tools={composerTools} onChange={setDraft} onSubmit={() => void submit()} onNavigateHistory={(direction) => navigateHistory(direction, recentUserTexts)} onToolSelect={onToolSelect} onFiles={attachmentUploads.addFiles} />
					<div className="chat-composer-controls">
						<div className="flex min-w-0 items-center">
							<input ref={fileInputRef} type="file" className="hidden" multiple aria-label={intl.formatMessage({ id: "chat.attachment.add" })} onChange={(event) => {
								attachmentUploads.addFiles(Array.from(event.currentTarget.files ?? []));
								event.currentTarget.value = "";
							}} />
							<button type="button" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => fileInputRef.current?.click()} aria-label={intl.formatMessage({ id: "chat.attachment.add" })} title={intl.formatMessage({ id: "chat.attachment.add.hint" })}><Paperclip size={15} /></button>
							<div className="flex items-center gap-2 px-2 text-[11px] font-medium text-[var(--text-muted)]" title={intl.formatMessage({ id: active ? "chat.autoApproval.locked" : "chat.autoApproval.hint" })}>
								<ShieldCheck size={14} className={autoAuditChecked ? "text-[var(--accent)]" : "text-[var(--text-muted)]"} />
								<span>{intl.formatMessage({ id: "session.new.autoApproval" })}</span>
								<ToggleSwitch checked={autoAuditChecked} disabled={active} label={intl.formatMessage({ id: "session.new.autoApproval.label" })} pending={autoAuditPending} onChange={onUpdateAutoAudit} />
							</div>
						</div>
						<div className="chat-composer-actions">
							{active && hasSubmittableContent ? <button type="button" disabled={!canSubmit} className="grid h-8 w-8 place-items-center rounded-full text-[var(--accent)] transition hover:bg-[var(--accent-soft)] disabled:opacity-40" onClick={() => void submit()} aria-label={intl.formatMessage({ id: "chat.send" })} title={intl.formatMessage({ id: "chat.send" })}>{submitting ? <LoaderCircle size={13} className="animate-spin" /> : <Send size={13} />}</button> : null}
							{modelRequired ? <span className="pr-0.5 text-[11px] font-medium text-[var(--warning)]">{intl.formatMessage({ id: "chat.model.selectBeforeSend" })}</span> : null}
							<ChatContextUsageIndicator usage={contextUsage} />
							<ModelThinkingSelector selectedModel={model} thinkingLevel={thinkingLevel} disabled={active || modelSelectionLoading} attention={modelRequired} modelLabel={modelSelectionLoading ? intl.formatMessage({ id: "chat.model.restoring" }) : modelLabel} appearance="composer" onSelectModel={onSelectModel} onSelectThinkingLevel={onSelectThinkingLevel} />
							{active ? <button type="button" className="chat-composer-action transition" disabled={cancelling} onClick={onCancel} aria-label={intl.formatMessage({ id: "chat.stop" })} title={intl.formatMessage({ id: "chat.stop" })}>{cancelling ? <LoaderCircle size={13} className="animate-spin" /> : <Square size={11} fill="currentColor" />}</button> : <button type="button" className="chat-composer-action transition" aria-label={intl.formatMessage({ id: "chat.send" })} disabled={!hasSubmittableContent || !canSubmit} onClick={() => void submit()}>{submitting ? <LoaderCircle size={13} className="animate-spin" /> : <Send size={13} />}</button>}
						</div>
					</div>
				</div>
				<p className="mt-2 text-center text-[10px] leading-4 text-[var(--text-muted)]">{intl.formatMessage({ id: "session.new.guardNotice" })}</p>
			</div>
		</div>
	);
});

export function QueuePreview({ items, active, mutationId, onCancel, onPromote }: {
	items: ChatQueueEntry[];
	active: boolean;
	mutationId: string | null;
	onCancel(id: string): void;
	onPromote(id: string): void;
}) {
	const intl = useIntl();
	return (
		<div className="mb-1.5 border-b border-[var(--line-soft)] px-1 pb-2">
			<p className="mb-1.5 px-1 text-[8px] font-semibold tracking-[0.06em] text-zinc-400">{intl.formatMessage({ id: "chat.queue.title" }, { count: items.length })}</p>
			<div className="app-scrollbar grid max-h-[156px] auto-rows-[36px] gap-1 overflow-y-auto min-w-0 grid-cols-[minmax(0,1fr)]">
				{items.map((item) => <div key={item.id} className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg bg-[var(--surface-muted)] px-2.5 py-1">
					<span className={`shrink-0 rounded px-1.5 py-0.5 text-[7px] font-semibold ${item.behavior === "steer" ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--secondary)]"}`}>{intl.formatMessage({ id: item.behavior === "steer" ? "chat.queue.steer" : "chat.queue.followUp" })}</span>
					<span className="min-w-0 truncate text-[9px] text-[var(--secondary)]">{queueMessageText(item.message) || intl.formatMessage({ id: "chat.queue.fallback" })}</span>
					<div className="flex w-[52px] items-center justify-end gap-1">
						{item.behavior === "follow_up" && item.status === "pending" ? <button type="button" className="grid h-6 w-6 shrink-0 place-items-center text-[var(--accent)] transition-opacity hover:opacity-75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-40" disabled={!active || mutationId !== null} onClick={() => onPromote(item.id)} aria-label={intl.formatMessage({ id: "chat.steer" })} title={intl.formatMessage({ id: "chat.steer" })}><CornerDownLeft size={14} strokeWidth={2.25} /></button> : null}
						<button type="button" className="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--text-muted)] transition hover:bg-[var(--surface-strong)] hover:text-[var(--danger)] disabled:opacity-40" disabled={!active || mutationId !== null} onClick={() => onCancel(item.id)} aria-label={intl.formatMessage({ id: "chat.queue.cancel" })}>{mutationId === item.id ? <LoaderCircle size={10} className="animate-spin" /> : <X size={10} />}</button>
					</div>
				</div>)}
			</div>
		</div>
	);
}

function queueMessageText(message: AgentMessage | string | undefined): string {
	if (typeof message === "string") return visibleChatComposerText(message);
	if (!message || message.role !== "user") return "";
	if (typeof message.content === "string") return visibleChatComposerText(message.content);
	return visibleChatComposerText(message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""));
}
