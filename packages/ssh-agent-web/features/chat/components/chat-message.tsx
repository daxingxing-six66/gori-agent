"use client";

import { BookOpen, Check, ChevronDown, CircleAlert, Clock3, Copy, Download, FilePenLine, LoaderCircle, MessageCircleQuestion, Minimize2, Rocket, SquareTerminal, Upload } from "lucide-react";
import { memo, useId, useMemo, useState } from "react";
import { useIntl, type IntlShape } from "react-intl";
import { ChatImagePreviewDialog, formatImageMetadata, type ImageDimensions } from "@/features/chat/components/chat-image-preview-dialog";
import { ChatFailureDetails } from "@/features/chat/components/chat-failure-details";
import { toolDetailsPresentation } from "@/features/chat/components/chat-tool-details";
import { ChatMarkdown } from "@/features/chat/components/chat-markdown";
import { ChatComposerMessage } from "@/features/chat/components/chat-reference";
import { approvalForTool, type ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import { type ChatToolExecution, type ThinkingContent, type ToolApproval, type ToolCallContent, type ToolUpdate } from "@/features/chat/model/chat";
import type { SessionAttachment } from "@/features/session/api/session-attachment-api";
import { apiUrl } from "@/shared/api/client";

export const ChatMessageRow = memo(function ChatMessageRow({
	entry,
	hideFailure = false,
	tools,
	approvals,
	approvalMutationId,
	targetHost,
	onResolveApproval,
}: {
	entry: ChatTimelineEntry;
	hideFailure?: boolean;
	tools: Record<string, ChatToolExecution>;
	approvals: Record<string, ToolApproval>;
	approvalMutationId: string | null;
	targetHost?: string;
	onResolveApproval(approval: ToolApproval, approved: boolean): void;
}) {
	const intl = useIntl();
	const message = entry.message;
	if (message.role === "toolResult" || message.role === "system") return null;
	if (message.role === "compactionSummary") {
		return (
			<details className="group rounded-xl border border-line-soft bg-surface-muted px-3.5 py-2.5">
				<summary className="chat-disclosure-trigger flex w-full list-none gap-2">
					<Minimize2 size={14} className="shrink-0 text-accent" aria-hidden="true" />
					<span className="font-semibold text-ink">{intl.formatMessage({ id: "chat.compaction.summary.title" })}</span>
					<span className="ml-auto text-[11px] tabular-nums text-muted">{intl.formatMessage({ id: "chat.compaction.summary.tokens" }, { count: message.tokensBefore })}</span>
					<ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
				</summary>
				<div className="mt-3 border-t border-[var(--line-soft)] pt-3"><ChatMarkdown subtle>{message.summary}</ChatMarkdown></div>
			</details>
		);
	}
	if (message.role === "user") {
		const text = typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
		return <UserMessageBubble message={text} attachments={entry.attachments ?? []} final={entry.final} />;
	}
	const hasText = message.content.some((part) => part.type === "text" && part.text.trim().length > 0);
	const toolOnly = message.content.length > 0 && message.content.every((part) => part.type === "toolCall");
	return (
		<div className={`chat-assistant-message min-w-0 [&>*+*]:mt-3.5 [&>.chat-tool-line+.chat-tool-line]:mt-1 ${toolOnly ? "chat-tool-only" : ""}`}>
				{message.content.map((part, index) => {
					if (part.type === "text") return part.text ? <ChatMarkdown key={`text:${index}`}>{part.text}</ChatMarkdown> : null;
					if (part.type === "thinking") return <ThinkingBlock key={`thinking:${index}:${entry.final}:${hasText}`} content={part} streaming={!entry.final} hasText={hasText} />;
					return <ToolCard key={`${part.id}:${tools[part.id]?.status ?? "waiting"}`} call={part} execution={tools[part.id]} approval={approvalForTool(approvals, part.id)} approvalBusy={approvalMutationId === approvalForTool(approvals, part.id)?.id} targetHost={targetHost} onResolveApproval={onResolveApproval} />;
				})}
				{!hideFailure && (message.failure || message.errorMessage) ? <div className="rounded-lg border border-[var(--danger-line)] bg-danger-soft px-3 py-2 text-xs leading-5 text-danger"><ChatFailureDetails failure={message.failure} fallback={message.errorMessage ?? ""} /></div> : null}
				{!entry.final ? <span className="chat-streaming-dots" aria-label={intl.formatMessage({ id: "chat.message.generating" })}><i /><i /><i /></span> : null}
		</div>
	);
});

function UserMessageBubble({ message, attachments, final }: { message: string; attachments: SessionAttachment[]; final: boolean }) {
	const intl = useIntl();
	const [copied, setCopied] = useState(false);
	const imageAttachments = attachments.filter(isDisplayableImageAttachment);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(message);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1_500);
		} catch {
			setCopied(false);
		}
	};
	const label = intl.formatMessage({ id: copied ? "chat.message.copied" : "chat.message.copy" });
	return (
		<div className={`flex min-w-0 flex-col items-end gap-2 ${final ? "" : "opacity-70"}`}>
			{imageAttachments.length > 0 ? <div className="w-1/2 min-w-0"><SentImageAttachments attachments={imageAttachments} /></div> : null}
			{message ? <div className="w-fit min-w-0 max-w-[78%]">
				<div className="chat-user-bubble border border-line-soft bg-surface-muted px-3 py-3 text-[14px] leading-6 text-ink">
					<ChatComposerMessage message={message} />
				</div>
				{message ? <div className="mt-1 flex justify-end">
					<button type="button" className="grid h-6 w-6 place-items-center rounded-md text-[var(--muted)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" onClick={() => void copy()} aria-label={label} title={label}>
						{copied ? <Check size={12} className="text-[var(--accent)]" /> : <Copy size={12} />}
					</button>
				</div> : null}
			</div> : null}
		</div>
	);
}

function SentImageAttachments({ attachments }: { attachments: SessionAttachment[] }) {
	const intl = useIntl();
	const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);
	const [dimensionsById, setDimensionsById] = useState<Record<string, ImageDimensions>>({});
	const images = attachments.map((attachment) => ({
		id: attachment.id,
		name: attachment.name,
		size: attachment.size,
		src: apiUrl(attachment.contentUrl),
		dimensions: dimensionsById[attachment.id],
	}));
	const selectedIndex = images.findIndex((image) => image.id === selectedAttachmentId);
	return (
		<div className="app-scrollbar flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain pb-1">
			{images.map((image) => <button key={image.id} type="button" className="group relative h-24 w-24 shrink-0 snap-start first:ml-auto overflow-hidden rounded-xl border border-black/10 bg-[var(--surface-muted)] text-left shadow-[0_1px_2px_rgb(15_23_42/8%)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" onClick={() => setSelectedAttachmentId(image.id)} aria-label={intl.formatMessage({ id: "chat.attachment.preview" }, { name: image.name })}>
				<img src={image.src} loading="lazy" decoding="async" alt={image.name} className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.03] group-focus-visible:scale-[1.03]" onLoad={(event) => {
					const dimensions = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
					setDimensionsById((current) => current[image.id]?.width === dimensions.width && current[image.id]?.height === dimensions.height ? current : { ...current, [image.id]: dimensions });
				}} />
				<span className="pointer-events-none absolute inset-x-0 bottom-0 bg-[linear-gradient(transparent,rgba(0,0,0,0.78))] px-2 pb-1.5 pt-8 text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100"><span className="block truncate text-[8px] font-semibold">{image.name}</span><span className="mt-0.5 block truncate text-[7px] text-white/75">{formatImageMetadata(intl, image)}</span></span>
			</button>)}
			{selectedIndex >= 0 ? <ChatImagePreviewDialog images={images} initialIndex={selectedIndex} onClose={() => setSelectedAttachmentId(null)} /> : null}
		</div>
	);
}

function isDisplayableImageAttachment(attachment: SessionAttachment): boolean {
	const mimeType = attachment.mimeType.toLowerCase();
	return mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/webp";
}

function ThinkingBlock({ content, streaming, hasText }: { content: ThinkingContent; streaming: boolean; hasText: boolean }) {
	const intl = useIntl();
	const contentId = useId();
	const [expanded, setExpanded] = useState(streaming && !hasText);
	if (!content.thinking && !content.redacted) return null;
	return (
		<section className="chat-thinking">
			<button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={contentId}>
				<span>{intl.formatMessage({ id: streaming && !hasText ? "chat.thinking.active" : "chat.thinking.process" })}</span>
				<ChevronDown size={14} className={`transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
			</button>
			<div id={contentId} hidden={!expanded} className="chat-thinking-content"><ChatMarkdown subtle>{content.redacted ? intl.formatMessage({ id: "chat.thinking.redacted" }) : content.thinking}</ChatMarkdown></div>
		</section>
	);
}

function ToolCard({ call, execution, approval, approvalBusy, targetHost, onResolveApproval }: {
	call: ToolCallContent;
	execution?: ChatToolExecution;
	approval?: ToolApproval;
	approvalBusy: boolean;
	targetHost?: string;
	onResolveApproval(approval: ToolApproval, approved: boolean): void;
}) {
	const intl = useIntl();
	const approvalTitleId = useId();
	const approvalDescriptionId = useId();
	const failed = execution?.status === "failed";
	const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
	const presentation = toolDetailsPresentation(call.name);
	const output = presentation.result(execution);
	const failurePreview = failed ? output.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 180) : null;
	const state = toolState(execution, approval);
	const approvalActions = approvalActionLabels(intl, call.name, approval?.toolName);
	const target = toolTarget(intl, call);
	const compactTarget = call.name === "read" || call.name === "write" ? target.split("/").at(-1) || target : target;
	const argumentsText = toolRequestArguments(call);
	const Details = presentation.Component;
	const update = presentation.update(execution);
	const progressLabel = presentation.progressLabel ? intl.formatMessage({ id: presentation.progressLabel }) : undefined;
	const copyArguments = async () => {
		try {
			await navigator.clipboard.writeText(argumentsText);
			setCopyStatus("copied");
		} catch {
			setCopyStatus("failed");
		}
	};
	if (approval?.status !== "pending") return (
		<details className="chat-tool-line group min-w-0 text-xs">
			<summary className="flex min-h-7 min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-secondary transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
				<span className="shrink-0"><ToolIcon name={call.name} /></span>
				<span className={`shrink-0 font-medium ${failed ? "text-danger" : "text-ink"}`}>{toolActionLabel(intl, call.name, state)}</span>
				<span className={`min-w-0 flex-1 truncate text-secondary ${call.name === "bash" || call.name === "remote_server_call" || call.name === "terminal_interaction" ? "font-mono" : ""}`} title={target}>{compactTarget}</span>
				{state === "running" && toolActionKind(call.name) !== null ? <LoaderCircle size={13} className="shrink-0 animate-spin text-accent" aria-hidden="true" /> : null}
				{toolActionKind(call.name) === null || state === "waiting" ? <ToolStatus state={state} /> : null}
				<ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
			</summary>
			{failurePreview ? <p role="alert" className="ml-7 line-clamp-1 break-words text-[11px] leading-5 text-danger group-open:hidden">{failurePreview}</p> : null}
			{state === "running" ? <ToolUpdateView update={update} failed={failed} progressLabel={progressLabel} /> : null}
			<div className={`chat-tool-details ml-6 mt-2 min-w-0 border border-line-soft bg-surface-muted px-3 py-2.5 ${presentation.className}`}>
				<div className={`flex items-center gap-2 text-xs text-secondary ${presentation.headerClassName}`}>
					<span className="font-medium">{toolDetailLabel(intl, call.name)}</span>
					<span className="ml-auto">{state !== "running" ? <ToolStatus state={state} /> : null}</span>
					{execution?.startedAt && execution.finishedAt ? <span className="shrink-0 tabular-nums text-muted">{Math.max(0, execution.finishedAt - execution.startedAt)} ms</span> : null}
					<button type="button" onClick={() => void copyArguments()} className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent" title={intl.formatMessage({ id: "chat.code.copy" })} aria-label={intl.formatMessage({ id: "chat.code.copy" })}>
						{copyStatus === "copied" ? <Check size={13} /> : copyStatus === "failed" ? <CircleAlert size={13} /> : <Copy size={13} />}
					</button>
				</div>
				<Details call={call} execution={execution} argumentsText={argumentsText} output={output} failed={failed}>
					{state !== "running" ? <ToolUpdateView update={update} failed={failed} progressLabel={progressLabel} /> : null}
				</Details>
				<span className="sr-only" aria-live="polite">{copyStatus === "copied" ? intl.formatMessage({ id: "chat.code.copied" }) : copyStatus === "failed" ? intl.formatMessage({ id: "chat.tool.arguments.copyFailed" }) : ""}</span>
			</div>
		</details>
	);
	const fullAccess = approval.toolName === "remote_sandbox_exception";
	const remoteHost = isRemoteApproval(call.name) ? targetHost : undefined;
	const commandPreview = typeof call.arguments.command === "string" ? call.arguments.command : target;
	return <section className="chat-tool-approval min-w-0 p-3.5" aria-labelledby={approvalTitleId} aria-describedby={approvalDescriptionId} aria-busy={approvalBusy}>
		<div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5">
			<span className="mt-0.5 shrink-0 text-warning"><ToolIcon name={call.name} /></span>
			<div className="min-w-0 flex-1">
				<h3 id={approvalTitleId} className="text-xs font-semibold text-ink">{toolLabel(intl, call.name)}</h3>
				{remoteHost ? <p className="mt-0.5 truncate text-[11px] text-muted" title={remoteHost}>{intl.formatMessage({ id: "chat.approval.target" }, { host: remoteHost })}</p> : null}
			</div>
			<ToolStatus state={state} />
		</div>
		<pre tabIndex={0} aria-label={intl.formatMessage({ id: "chat.approval.commandPreview" })} className="chat-tool-approval-command app-scrollbar mt-3 whitespace-pre-wrap break-words font-mono text-xs text-ink">{commandPreview}</pre>
		<p id={approvalDescriptionId} className="mt-2.5 whitespace-pre-wrap text-xs leading-5 text-secondary">{approval.description}</p>
		{fullAccess ? <p className="chat-tool-approval-scope mt-2 text-[11px] font-semibold">{intl.formatMessage({ id: "chat.approval.fullAccess" })}</p> : null}
		<details className="group mt-2">
			<summary className="chat-disclosure-trigger text-[11px]">{intl.formatMessage({ id: "chat.approval.fullRequest" })}<ChevronDown size={13} className="transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
			<pre className="app-scrollbar mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-muted px-3 py-2 font-mono text-[11px] leading-5 text-secondary">{argumentsText || target}</pre>
		</details>
		<div className="mt-2.5 flex flex-wrap items-center justify-end gap-2 border-t border-line-soft pt-2.5">
			<button type="button" disabled={approvalBusy} className="min-h-8 rounded-md px-2.5 py-1.5 text-xs font-medium text-secondary transition hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-50" onClick={() => onResolveApproval(approval, false)}>{approvalActions.deny}</button>
			<button type="button" disabled={approvalBusy} className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-[var(--text-inverse)] transition hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-70" onClick={() => onResolveApproval(approval, true)}>{approvalBusy ? <LoaderCircle size={12} className="animate-spin" aria-hidden="true" /> : null}{approvalBusy ? intl.formatMessage({ id: "chat.tool.processing" }) : approvalActions.approve}</button>
		</div>
	</section>;
}

function isRemoteApproval(toolName: string): boolean {
	return toolName === "remote_server_call" || toolName === "terminal_interaction" ||
		toolName === "sftp_upload" || toolName === "sftp_download" || toolName === "bubblewrap_install";
}

function ToolIcon({ name }: { name: string }) {
	if (name === "read") return <BookOpen size={14} aria-hidden="true" />;
	if (name === "write") return <FilePenLine size={14} aria-hidden="true" />;
	if (name === "ask_user_decision") return <MessageCircleQuestion size={14} aria-hidden="true" />;
	if (name.startsWith("deployment_")) return <Rocket size={14} aria-hidden="true" />;
	if (name === "sftp_upload") return <Upload size={14} aria-hidden="true" />;
	if (name === "sftp_download") return <Download size={14} aria-hidden="true" />;
	return <SquareTerminal size={14} aria-hidden="true" />;
}

type ToolActionKind = "run" | "read" | "write" | "upload" | "download" | "terminal" | "ask";

function toolActionKind(name: string): ToolActionKind | null {
	return name === "bash" || name === "remote_server_call" ? "run"
		: name === "read" ? "read"
		: name === "write" ? "write"
		: name === "sftp_upload" ? "upload"
		: name === "sftp_download" ? "download"
		: name === "terminal_interaction" ? "terminal"
		: name === "ask_user_decision" ? "ask" : null;
}

function toolActionLabel(intl: IntlShape, name: string, state: ReturnType<typeof toolState>): string {
	const action = toolActionKind(name);
	if (!action || state === "waiting" || state === "approval") return toolLabel(intl, name);
	return intl.formatMessage({ id: `chat.tool.action.${action}.${state}` });
}

function toolDetailLabel(intl: IntlShape, name: string): string {
	if (name === "bash") return intl.formatMessage({ id: "chat.tool.detail.shell" });
	if (name === "remote_server_call") return intl.formatMessage({ id: "chat.tool.detail.ssh" });
	if (name === "terminal_interaction") return intl.formatMessage({ id: "chat.tool.detail.terminal" });
	return toolLabel(intl, name);
}

function ToolUpdateView({ update, failed, progressLabel }: { update?: ToolUpdate; failed: boolean; progressLabel?: string }) {
	const intl = useIntl();
	if (!update || update.type === "text") return null;
	if (update.type === "status") {
		return <div className="flex items-center gap-2 px-3.5 pb-3 text-xs text-secondary"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />{update.detail.message}</div>;
	}
	const percent = update.detail.total === 0 ? 100 : Math.min(100, update.detail.current / update.detail.total * 100);
	const label = progressLabel ?? update.detail.message ?? intl.formatMessage({ id: update.detail.unit === "bytes" ? "chat.tool.progress.transfer" : "chat.tool.progress.processing" });
	return (
		<div className="px-3.5 pb-3" role="progressbar" aria-label={progressLabel ?? update.detail.message ?? intl.formatMessage({ id: "chat.tool.progress" })} aria-valuemin={0} aria-valuemax={update.detail.total} aria-valuenow={update.detail.current}>
			<div className="mb-1.5 flex items-center justify-between gap-3 text-xs"><span className="min-w-0 truncate font-medium text-secondary">{label}</span><span className="shrink-0 font-semibold tabular-nums text-muted">{Math.round(percent)}%</span></div>
			<div className="h-1.5 overflow-hidden rounded-full bg-line"><div className={`h-full rounded-full transition-[width] duration-300 ease-out ${failed ? "bg-danger" : "bg-accent"}`} style={{ width: `${percent}%` }} /></div>
			<p className="mt-1.5 text-right text-[11px] tabular-nums text-muted">{formatProgress(intl, update)}</p>
		</div>
	);
}

function formatProgress(intl: IntlShape, update: Extract<ToolUpdate, { type: "progress" }>): string {
	if (update.detail.unit === "items") return intl.formatMessage({ id: "chat.tool.progress.items" }, { current: update.detail.current, total: update.detail.total });
	return `${formatBytes(update.detail.current)} / ${formatBytes(update.detail.total)}`;
}

function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let amount = value;
	let index = -1;
	do {
		amount /= 1024;
		index += 1;
	} while (amount >= 1024 && index < units.length - 1);
	return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function ToolStatus({ state }: { state: "waiting" | "approval" | "running" | "completed" | "failed" }) {
	const intl = useIntl();
	const content = useMemo(() => {
		if (state === "completed") return { icon: <Check size={12} />, label: intl.formatMessage({ id: "chat.tool.status.completed" }), className: "text-accent" };
		if (state === "failed") return { icon: <CircleAlert size={12} />, label: intl.formatMessage({ id: "chat.tool.status.failed" }), className: "text-danger" };
		if (state === "running") return { icon: <LoaderCircle size={12} className="animate-spin" />, label: intl.formatMessage({ id: "chat.tool.status.running" }), className: "text-accent" };
		return { icon: <Clock3 size={12} />, label: intl.formatMessage({ id: state === "approval" ? "chat.tool.status.approval" : "chat.tool.status.waiting" }), className: state === "approval" ? "text-warning" : "text-muted" };
	}, [intl, state]);
	return <span className={`inline-flex shrink-0 items-center gap-1 text-[11px] font-medium ${content.className}`}>{content.icon}{content.label}</span>;
}

function toolState(execution?: ChatToolExecution, approval?: ToolApproval): "waiting" | "approval" | "running" | "completed" | "failed" {
	if (approval?.status === "pending") return "approval";
	return execution?.status ?? "waiting";
}

function toolLabel(intl: IntlShape, name: string): string {
	const labels = {
		remote_server_call: "chat.tool.remote",
		terminal_interaction: "chat.tool.terminal",
		sftp_upload: "chat.tool.upload",
		sftp_download: "chat.tool.download",
		bash: "chat.tool.bash",
		read: "chat.tool.read",
		write: "chat.tool.write",
		ask_user_decision: "chat.decision.tool",
		deployment_propose_plan: "chat.tool.deployment.propose",
		deployment_inspect: "chat.tool.deployment.inspect",
		deployment_execute_next: "chat.tool.deployment.execute",
		deployment_propose_recovery: "chat.tool.deployment.recovery",
	} as const;
	const id = labels[name as keyof typeof labels];
	return id ? intl.formatMessage({ id }) : name;
}

function approvalActionLabels(intl: IntlShape, toolName: string, approvalToolName?: string): { deny: string; approve: string } {
	const overwrite = toolName === "sftp_upload" || toolName === "sftp_download";
	const approveId = overwrite ? "chat.approval.approveOverwrite"
		: approvalToolName === "remote_sandbox_exception" ? "chat.approval.approveFullAccess"
		: toolName === "remote_server_call" ? "chat.approval.approveRemote"
		: toolName === "bash" ? "chat.approval.approveLocal"
		: toolName === "terminal_interaction" ? "chat.approval.approveTerminal"
		: "chat.approval.approve";
	return {
		deny: intl.formatMessage({ id: overwrite ? "chat.approval.denyOverwrite" : "chat.approval.deny" }),
		approve: intl.formatMessage({ id: approveId }),
	};
}

function toolTarget(intl: IntlShape, call: ToolCallContent): string {
	const args = call.arguments;
	if (call.name === "ask_user_decision" && Array.isArray(args.questions)) {
		const first = args.questions[0];
		return typeof first === "object" && first !== null && "question" in first && typeof first.question === "string"
			? first.question : intl.formatMessage({ id: "chat.decision.tool" });
	}
	if (call.name === "terminal_interaction") {
		if (typeof args.input === "string") return args.input;
		if (args.key === "CTRL_C") return "Ctrl+C";
		if (typeof args.action === "string") return args.action;
	}
	if (call.name === "sftp_upload" && typeof args.sourceFilePath === "string" && typeof args.targetPath === "string")
		return `${args.sourceFilePath} → ${args.targetPath}`;
	if (call.name === "sftp_download" && typeof args.remoteFilePath === "string" && typeof args.targetPath === "string")
		return `${args.remoteFilePath} → ${args.targetPath}`;
	for (const field of call.name === "read" || call.name === "write" ? ["path", "file_path"] : ["command", "path"]) {
		if (typeof args[field] === "string") return args[field];
	}
	const entries = Object.entries(args).slice(0, 2).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
	return entries.join(" · ") || intl.formatMessage({ id: "chat.tool.target.waiting" });
}

function toolRequestArguments(call: ToolCallContent): string {
	const args = call.arguments;
	if ((call.name === "bash" || call.name === "remote_server_call") && typeof args.command === "string" && Object.keys(args).length === 1)
		return `$ ${args.command}`;
	if (call.name === "ask_user_decision" && Array.isArray(args.questions)) {
		return args.questions.map((entry, index) => typeof entry === "object" && entry !== null && "question" in entry && typeof entry.question === "string"
			? `${index + 1}. ${entry.question}` : `${index + 1}. ?`).join("\n");
	}
	if (call.name === "terminal_interaction") {
		if (typeof args.input === "string") return args.input;
		if (args.key === "CTRL_C") return "Ctrl+C";
	}
	return Object.entries(args).map(([key, value]) => `${key}=${formatToolArgument(value)}`).join("\n");
}

function formatToolArgument(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
