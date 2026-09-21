"use client";

import { Check, ChevronDown, ChevronRight, CircleAlert, Clock3, Copy, LoaderCircle, Minimize2, SquareTerminal } from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIntl, type IntlShape } from "react-intl";
import { ChatImagePreviewDialog, formatImageMetadata, type ImageDimensions } from "@/features/chat/components/chat-image-preview-dialog";
import { ChatFailureDetails } from "@/features/chat/components/chat-failure-details";
import { ChatMarkdown } from "@/features/chat/components/chat-markdown";
import { ChatComposerMessage } from "@/features/chat/components/chat-reference";
import { approvalForTool, toolResultText, type ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import type { ChatToolExecution, ThinkingContent, ToolApproval, ToolCallContent, ToolUpdate } from "@/features/chat/model/chat";
import type { SessionAttachment } from "@/features/session/api/session-attachment-api";
import { apiUrl } from "@/shared/api/client";

export const ChatMessageRow = memo(function ChatMessageRow({
	entry,
	hideFailure = false,
	tools,
	approvals,
	approvalMutationId,
	onResolveApproval,
}: {
	entry: ChatTimelineEntry;
	hideFailure?: boolean;
	tools: Record<string, ChatToolExecution>;
	approvals: Record<string, ToolApproval>;
	approvalMutationId: string | null;
	onResolveApproval(approval: ToolApproval, approved: boolean): void;
}) {
	const intl = useIntl();
	const message = entry.message;
	if (message.role === "toolResult" || message.role === "system") return null;
	if (message.role === "compactionSummary") {
		return (
			<details className="group rounded-xl border border-[var(--line-soft)] bg-[var(--surface-muted)] px-3.5 py-3">
				<summary className="flex cursor-pointer list-none items-center gap-2 text-[10px] text-[var(--secondary)]">
					<span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]"><Minimize2 size={12} /></span>
					<span className="font-semibold text-[var(--ink)]">{intl.formatMessage({ id: "chat.compaction.summary.title" })}</span>
					<span className="ml-auto text-[8px] tabular-nums text-[var(--muted)]">{intl.formatMessage({ id: "chat.compaction.summary.tokens" }, { count: message.tokensBefore })}</span>
					<ChevronRight size={11} className="transition-transform group-open:rotate-90" />
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
	return (
		<div className="min-w-0 space-y-3.5">
				{message.content.map((part, index) => {
					if (part.type === "text") return part.text ? <ChatMarkdown key={`text:${index}`}>{part.text}</ChatMarkdown> : null;
					if (part.type === "thinking") return <ThinkingBlock key={`thinking:${index}:${entry.final}:${hasText}`} content={part} streaming={!entry.final} hasText={hasText} />;
					return <ToolCard key={`${part.id}:${tools[part.id]?.status ?? "waiting"}`} call={part} execution={tools[part.id]} approval={approvalForTool(approvals, part.id)} approvalBusy={approvalMutationId === approvalForTool(approvals, part.id)?.id} onResolveApproval={onResolveApproval} />;
				})}
				{!hideFailure && (message.failure || message.errorMessage) ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[10px] leading-5 text-rose-700"><ChatFailureDetails failure={message.failure} fallback={message.errorMessage ?? ""} /></div> : null}
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
				<div className="rounded-[14px] rounded-br-[5px] border border-[#dbe3dd] bg-[#edf2ee] px-3 py-3 text-[12px] leading-6 text-zinc-700">
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
	const [expanded, setExpanded] = useState(streaming && !hasText);
	if (!content.thinking && !content.redacted) return null;
	return (
		<section className="chat-thinking">
			<button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
				{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				<span>{intl.formatMessage({ id: streaming && !hasText ? "chat.thinking.active" : "chat.thinking.process" })}</span>
			</button>
			{expanded ? <div className="chat-thinking-content"><ChatMarkdown subtle>{content.redacted ? intl.formatMessage({ id: "chat.thinking.redacted" }) : content.thinking}</ChatMarkdown></div> : null}
		</section>
	);
}

function ToolCard({ call, execution, approval, approvalBusy, onResolveApproval }: {
	call: ToolCallContent;
	execution?: ChatToolExecution;
	approval?: ToolApproval;
	approvalBusy: boolean;
	onResolveApproval(approval: ToolApproval, approved: boolean): void;
}) {
	const intl = useIntl();
	const failed = execution?.status === "failed";
	const [expanded, setExpanded] = useState(failed);
	const output = toolResultText(execution?.result ?? (execution?.latestUpdate?.type === "text" ? execution.latestUpdate.detail.content : undefined));
	const state = toolState(execution, approval);
	const approvalActions = approvalActionLabels(intl, call.name);
	return (
		<section className={`chat-tool-card ${failed ? "chat-tool-card-error" : ""}`}>
			{state === "approval" ? <div className="px-3.5 pt-3"><div className="flex items-center justify-between gap-3"><p className="flex min-w-0 items-center gap-2 truncate text-[10px] font-semibold tracking-[0.025em] text-zinc-800 before:h-3 before:w-0.5 before:shrink-0 before:rounded-full before:bg-[#78a088]">{toolLabel(intl, call.name)}</p><ToolStatus state={state} /></div><p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-[#f6f6f3] px-3 py-2 font-mono text-[11px] font-semibold leading-5 text-zinc-700">{toolTarget(intl, call)}</p></div> : <div className="flex items-start gap-3 px-3.5 py-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#edf2ee] text-[#397b5c]"><SquareTerminal size={14} /></span><div className="min-w-0 flex-1"><p className="flex items-center gap-2 truncate text-[10px] font-semibold tracking-[0.025em] text-zinc-800 before:h-3 before:w-0.5 before:shrink-0 before:rounded-full before:bg-[#78a088]">{toolLabel(intl, call.name)}</p><ToolRequestArguments call={call} target={toolTarget(intl, call)} /></div><div className="flex shrink-0 items-center gap-1.5"><ToolStatus state={state} />{execution?.startedAt && execution.finishedAt ? <span className="inline-flex items-center gap-1 text-[8px] text-zinc-400"><Clock3 size={10} />{Math.max(0, execution.finishedAt - execution.startedAt)} ms</span> : null}{output ? <button type="button" className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-black/[0.04] hover:text-zinc-700" onClick={() => setExpanded((value) => !value)} aria-label={intl.formatMessage({ id: expanded ? "chat.tool.output.collapse" : "chat.tool.output.expand" })}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : null}</div></div>}
			{approval?.status === "pending" ? <p className="px-3.5 pt-2 text-[10px] font-medium leading-5 text-zinc-600">{approval.description}</p> : null}
			<ToolUpdateView update={execution?.latestUpdate} failed={failed} />
			{approval?.status === "pending" ? <div className="flex min-h-10 items-center justify-end gap-2 px-3.5 pb-3 pt-1">{approvalBusy ? <span className="inline-flex items-center gap-1.5 px-2 text-[9px] font-medium text-[var(--muted)]"><LoaderCircle size={11} className="animate-spin" />{intl.formatMessage({ id: "chat.tool.processing" })}</span> : <><button type="button" className="inline-flex h-8 min-w-16 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-[10px] font-medium text-[var(--secondary)] shadow-[0_1px_1px_rgb(15_23_42/3%)] transition hover:border-[var(--line-strong)] hover:bg-[var(--surface-muted)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" onClick={() => onResolveApproval(approval, false)}>{approvalActions.cancel}</button><button type="button" className="inline-flex h-8 min-w-20 items-center justify-center rounded-lg border border-[var(--accent)] bg-[var(--accent)] px-3.5 text-[10px] font-semibold text-[var(--text-inverse)] shadow-[0_3px_10px_rgb(38_96_68/14%)] transition hover:border-[var(--accent-hover)] hover:bg-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" onClick={() => onResolveApproval(approval, true)}>{approvalActions.approve}</button></>}</div> : null}
			{expanded && output ? <pre className={`app-scrollbar max-h-64 overflow-auto border-t px-3.5 py-3 font-mono text-[9px] leading-5 ${failed ? "border-rose-200 bg-rose-50/60 text-rose-700" : "border-[var(--line-soft)] bg-[#f3f2ee] text-zinc-600"}`}>{output}</pre> : null}
		</section>
	);
}

function ToolRequestArguments({ call, target }: { call: ToolCallContent; target: string }) {
	const intl = useIntl();
	const tooltipId = useId();
	const targetRef = useRef<HTMLParagraphElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
	const closeTimerRef = useRef<number | null>(null);
	const [truncated, setTruncated] = useState(false);
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null);
	const fullArguments = toolRequestArguments(call);
	const copyArguments = async () => {
		try {
			await navigator.clipboard.writeText(fullArguments);
			setCopyStatus("copied");
		} catch {
			setCopyStatus("failed");
		}
	};
	useEffect(() => {
		setCopyStatus("idle");
	}, [open, fullArguments]);
	useEffect(() => {
		if (copyStatus === "idle") return;
		const timer = window.setTimeout(() => setCopyStatus("idle"), 1500);
		return () => window.clearTimeout(timer);
	}, [copyStatus]);

	const updateTruncation = useCallback(() => {
		const targetElement = targetRef.current;
		if (!targetElement) return false;
		const nextTruncated = targetElement.scrollWidth > targetElement.clientWidth;
		setTruncated(nextTruncated);
		if (!nextTruncated) setOpen(false);
		return nextTruncated;
	}, []);

	const updatePosition = useCallback(() => {
		const targetElement = targetRef.current;
		if (!targetElement) return;
		const rect = targetElement.getBoundingClientRect();
		const width = Math.min(560, window.innerWidth - 24);
		const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
		const below = window.innerHeight - rect.bottom;
		const above = below < 176 && rect.top > below;
		setPosition({ left, top: above ? rect.top - 8 : rect.bottom + 8, above });
	}, []);

	const close = () => {
		if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = window.setTimeout(() => {
			if (!popoverRef.current?.contains(document.activeElement) && document.activeElement !== targetRef.current) setOpen(false);
		}, 120);
	};
	const show = () => {
		if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
		if (!updateTruncation()) return;
		updatePosition();
		setOpen(true);
	};

	useEffect(() => {
		const targetElement = targetRef.current;
		if (!targetElement) return;
		updateTruncation();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(updateTruncation);
		observer.observe(targetElement);
		return () => observer.disconnect();
	}, [target, updateTruncation]);

	useEffect(() => {
		if (!open) return;
		window.addEventListener("resize", updatePosition);
		window.addEventListener("scroll", updatePosition, true);
		return () => {
			window.removeEventListener("resize", updatePosition);
			window.removeEventListener("scroll", updatePosition, true);
		};
	}, [open, updatePosition]);

	useEffect(() => () => {
		if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
	}, []);

	return (
		<>
			<p
				ref={targetRef}
				className={`mt-1.5 truncate font-mono text-[10px] font-medium text-zinc-500 ${truncated ? "cursor-help" : ""}`}
				tabIndex={truncated ? 0 : undefined}
				aria-describedby={open ? tooltipId : undefined}
				onPointerEnter={show}
				onPointerLeave={close}
				onFocus={show}
				onBlur={(event) => { if (!popoverRef.current?.contains(event.relatedTarget)) close(); }}
			>
				{target}
			</p>
			{open && position ? createPortal(
				<div
					ref={popoverRef}
					id={tooltipId}
					role="dialog"
					aria-label={intl.formatMessage({ id: "chat.tool.arguments.full" })}
					className="fixed z-[70] w-[min(560px,calc(100vw-24px))]"
					style={{ left: position.left, top: position.top, transform: position.above ? "translateY(-100%)" : undefined }}
					onPointerEnter={show}
					onPointerLeave={close}
					onFocus={show}
					onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							targetRef.current?.focus();
							setOpen(false);
						}
					}}
				>
					<div className="chat-tool-request-popover app-scrollbar" style={{ position: "relative", width: "100%" }}>
						<p>{intl.formatMessage({ id: "chat.tool.arguments.full" })}</p>
						<pre>{fullArguments}</pre>
					</div>
					<div className="flex justify-end pt-1">
						<button type="button" onClick={() => void copyArguments()} className="grid h-6 w-6 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
							{copyStatus === "copied" ? <Check size={12} /> : copyStatus === "failed" ? <CircleAlert size={12} /> : <Copy size={12} />}
							<span className="sr-only" aria-live="polite">{intl.formatMessage({ id: copyStatus === "failed" ? "chat.tool.arguments.copyFailed" : copyStatus === "copied" ? "chat.code.copied" : "chat.code.copy" })}</span>
						</button>
					</div>
				</div>,
				document.body,
			) : null}
		</>
	);
}

function ToolUpdateView({ update, failed }: { update?: ToolUpdate; failed: boolean }) {
	const intl = useIntl();
	if (!update || update.type === "text") return null;
	if (update.type === "status") {
		return <div className="flex items-center gap-2 px-3.5 pb-3 text-[9px] text-zinc-500"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#78a088]" />{update.detail.message}</div>;
	}
	const percent = update.detail.total === 0 ? 100 : Math.min(100, update.detail.current / update.detail.total * 100);
	return (
		<div className="px-3.5 pb-3" role="progressbar" aria-label={update.detail.message ?? intl.formatMessage({ id: "chat.tool.progress" })} aria-valuemin={0} aria-valuemax={update.detail.total} aria-valuenow={update.detail.current}>
			<div className="mb-1.5 flex items-center justify-between gap-3 text-[9px]"><span className="min-w-0 truncate font-medium text-zinc-600">{update.detail.message ?? intl.formatMessage({ id: update.detail.unit === "bytes" ? "chat.tool.progress.transfer" : "chat.tool.progress.processing" })}</span><span className="shrink-0 font-semibold tabular-nums text-zinc-500">{Math.round(percent)}%</span></div>
			<div className="h-1.5 overflow-hidden rounded-full bg-zinc-200/80"><div className={`h-full rounded-full transition-[width] duration-300 ease-out ${failed ? "bg-rose-500" : "bg-[#4b8b6b]"}`} style={{ width: `${percent}%` }} /></div>
			<p className="mt-1.5 text-right text-[8px] tabular-nums text-zinc-400">{formatProgress(intl, update)}</p>
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
		if (state === "completed") return { icon: <Check size={10} />, label: intl.formatMessage({ id: "chat.tool.status.completed" }), className: "text-[#397b5c]" };
		if (state === "failed") return { icon: <CircleAlert size={10} />, label: intl.formatMessage({ id: "chat.tool.status.failed" }), className: "text-rose-600" };
		if (state === "running") return { icon: <LoaderCircle size={10} className="animate-spin" />, label: intl.formatMessage({ id: "chat.tool.status.running" }), className: "text-[#397b5c]" };
		return { icon: <Clock3 size={10} />, label: intl.formatMessage({ id: state === "approval" ? "chat.tool.status.approval" : "chat.tool.status.waiting" }), className: "text-amber-700" };
	}, [intl, state]);
	return <span className={`inline-flex items-center gap-1 text-[8px] font-semibold ${content.className}`}>{content.icon}{content.label}</span>;
}

function toolState(execution?: ChatToolExecution, approval?: ToolApproval): "waiting" | "approval" | "running" | "completed" | "failed" {
	if (approval?.status === "pending") return "approval";
	return execution?.status ?? "waiting";
}

function toolLabel(intl: IntlShape, name: string): string {
	const id = ({ remote_server_call: "chat.tool.remote", bash: "chat.tool.bash", read: "chat.tool.read", write: "chat.tool.write" } as const)[name as "remote_server_call" | "bash" | "read" | "write"];
	return id ? intl.formatMessage({ id }) : name;
}

function approvalActionLabels(intl: IntlShape, toolName: string): { cancel: string; approve: string } {
	return {
		cancel: intl.formatMessage({ id: "chat.approval.cancel" }),
		approve: intl.formatMessage({ id: toolName === "sftp_upload" ? "chat.approval.overwrite" : "chat.approval.confirm" }),
	};
}

function toolTarget(intl: IntlShape, call: ToolCallContent): string {
	const args = call.arguments;
	if (call.name === "terminal_interaction") {
		if (typeof args.input === "string") return args.input;
		if (args.key === "CTRL_C") return "Ctrl+C";
		if (typeof args.action === "string") return args.action;
	}
	for (const field of call.name === "read" || call.name === "write" ? ["path", "file_path"] : ["command", "path"]) {
		if (typeof args[field] === "string") return args[field];
	}
	const entries = Object.entries(args).slice(0, 2).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
	return entries.join(" · ") || intl.formatMessage({ id: "chat.tool.target.waiting" });
}

function toolRequestArguments(call: ToolCallContent): string {
	const args = call.arguments;
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
