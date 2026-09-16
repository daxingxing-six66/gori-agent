"use client";

import { CircleAlert, CornerDownLeft, ImageIcon, LoaderCircle, Send, ShieldCheck, Square, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { ToggleSwitch } from "@/components/toggle-switch";
import { ChatComposerNotices } from "@/features/chat/components/chat-composer-notices";
import { ChatContextUsageIndicator } from "@/features/chat/components/chat-context-usage-indicator";
import type { ChatContextUsage } from "@/features/chat/model/chat-context-usage";
import { ChatImagePreviewDialog, formatImageMetadata, type ImageDimensions } from "@/features/chat/components/chat-image-preview-dialog";
import { ChatTokenEditor, type ChatComposerTool, type ChatTokenEditorHandle } from "@/features/chat/components/chat-token-editor";
import { hasChatComposerContent, visibleChatComposerText } from "@/features/chat/model/chat-composer";
import type { AgentMessage, ChatQueueEntry, ManualChatCompactionResult } from "@/features/chat/model/chat";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { ModelThinkingSelector } from "@/features/llm-provider/components/model-thinking-selector";
import type { LlmModel, ThinkingLevel } from "@/features/llm-provider/model/llm-provider";
import { sessionAttachmentApi, type SessionAttachment } from "@/features/session/api/session-attachment-api";
import { fitImageWithinMaximumDimension, maximumImageUploadBytes } from "@/features/session/model/image-upload";

export interface ChatComposerPanelHandle {
	restoreDraft(message: string): void;
}

type ImageUploadStatus = "preparing" | "uploading" | "uploaded" | "error";

interface ImageUpload {
	id: string;
	name: string;
	size: number;
	previewUrl: string | null;
	dimensions: ImageDimensions | undefined;
	status: ImageUploadStatus;
	attachment: SessionAttachment | null;
	error: string | null;
}

export const ChatComposerPanel = forwardRef<ChatComposerPanelHandle, {
	sessionId: string;
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
}>(function ChatComposerPanel({
	sessionId,
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
}, forwardedRef) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const editorRef = useRef<ChatTokenEditorHandle>(null);
	const activeImageUploadControllersRef = useRef(new Map<string, AbortController>());
	const imagePreviewUrlsRef = useRef(new Map<string, string>());
	const latestSessionIdRef = useRef(sessionId);
	const previousSessionIdRef = useRef(sessionId);
	latestSessionIdRef.current = sessionId;
	const [draft, setDraft] = useState("");
	const [imageUploads, setImageUploads] = useState<ImageUpload[]>([]);
	const hasContent = hasChatComposerContent(draft);
	const attachments = imageUploads.flatMap((upload) => upload.status === "uploaded" && upload.attachment !== null ? [upload.attachment] : []);
	const hasPendingImageUploads = imageUploads.some((upload) => upload.status === "preparing" || upload.status === "uploading");
	const hasSubmittableContent = hasContent || attachments.length > 0;
	const modelRequired = hasSubmittableContent && !active && model === null && !modelSelectionLoading;
	const canSubmit = !submitting && !terminalBusy && !hasPendingImageUploads && (active || model !== null);

	useEffect(() => {
		setDraft("");
		if (previousSessionIdRef.current === sessionId) return;
		previousSessionIdRef.current = sessionId;
		for (const controller of activeImageUploadControllersRef.current.values()) controller.abort();
		activeImageUploadControllersRef.current.clear();
		for (const previewUrl of imagePreviewUrlsRef.current.values()) URL.revokeObjectURL(previewUrl);
		imagePreviewUrlsRef.current.clear();
		setImageUploads([]);
	}, [sessionId]);

	useEffect(() => () => {
		for (const controller of activeImageUploadControllersRef.current.values()) controller.abort();
		for (const previewUrl of imagePreviewUrlsRef.current.values()) URL.revokeObjectURL(previewUrl);
	}, []);

	useImperativeHandle(forwardedRef, () => ({
		restoreDraft: (message) => {
			setDraft(message);
			requestAnimationFrame(() => editorRef.current?.focus());
		},
	}), []);

	const submit = async () => {
		const message = draft.trim();
		if ((!hasChatComposerContent(message) && attachments.length === 0) || !canSubmit) return;
		setDraft("");
		if (!await onSubmit(message, attachments)) {
			setDraft(message);
			return;
		}
		for (const previewUrl of imagePreviewUrlsRef.current.values()) URL.revokeObjectURL(previewUrl);
		imagePreviewUrlsRef.current.clear();
		setImageUploads([]);
	};

	const uploadFiles = (files: File[]) => {
		const uploadSessionId = sessionId;
		const uploadsToStart: Array<{ id: string; file: File; controller: AbortController }> = [];
		const nextUploads = files.map((file): ImageUpload => {
			const id = crypto.randomUUID();
			if (!file.type.toLowerCase().startsWith("image/")) {
				return { id, name: file.name, size: file.size, previewUrl: null, dimensions: undefined, status: "error", attachment: null, error: intl.formatMessage({ id: "chat.attachment.imageOnly" }) };
			}
			const previewUrl = URL.createObjectURL(file);
			const controller = new AbortController();
			imagePreviewUrlsRef.current.set(id, previewUrl);
			activeImageUploadControllersRef.current.set(id, controller);
			uploadsToStart.push({ id, file, controller });
			return { id, name: file.name, size: file.size, previewUrl, dimensions: undefined, status: "preparing", attachment: null, error: null };
		});
		setImageUploads((current) => [...current, ...nextUploads]);

		for (const upload of uploadsToStart) {
			void (async () => {
				try {
					let preparedFile: PreparedImageUpload;
					try {
						preparedFile = await prepareImageForUpload(upload.file);
					} catch {
						if (!upload.controller.signal.aborted && latestSessionIdRef.current === uploadSessionId) {
							setImageUploads((current) => current.map((item) => item.id === upload.id ? {
								...item,
								status: "error",
								attachment: null,
								error: intl.formatMessage({ id: "chat.attachment.processingFailed" }),
							} : item));
						}
						return;
					}
					if (upload.controller.signal.aborted || latestSessionIdRef.current !== uploadSessionId) return;
					const previewUrl = URL.createObjectURL(preparedFile.file);
					const previousPreviewUrl = imagePreviewUrlsRef.current.get(upload.id);
					if (previousPreviewUrl) URL.revokeObjectURL(previousPreviewUrl);
					imagePreviewUrlsRef.current.set(upload.id, previewUrl);
					setImageUploads((current) => current.map((item) => item.id === upload.id ? {
						...item,
						name: preparedFile.file.name,
						size: preparedFile.file.size,
						previewUrl,
						dimensions: preparedFile.dimensions,
					} : item));
					if (preparedFile.file.size > maximumImageUploadBytes) {
						setImageUploads((current) => current.map((item) => item.id === upload.id ? {
							...item,
							status: "error",
							attachment: null,
							error: intl.formatMessage({ id: "chat.attachment.tooLarge" }),
						} : item));
						return;
					}
					setImageUploads((current) => current.map((item) => item.id === upload.id ? { ...item, status: "uploading" } : item));
					try {
						const attachment = await sessionAttachmentApi.upload(uploadSessionId, preparedFile.file, upload.controller.signal);
						if (latestSessionIdRef.current !== uploadSessionId) return;
						setImageUploads((current) => current.map((item) => item.id === upload.id ? { ...item, status: "uploaded", attachment } : item));
					} catch (uploadError) {
						if (upload.controller.signal.aborted || latestSessionIdRef.current !== uploadSessionId) return;
						setImageUploads((current) => current.map((item) => item.id === upload.id ? {
							...item,
							status: "error",
							attachment: null,
							error: localizedErrorMessage(uploadError),
						} : item));
					}
				} finally {
					if (activeImageUploadControllersRef.current.get(upload.id) === upload.controller) {
						activeImageUploadControllersRef.current.delete(upload.id);
					}
				}
			})();
		}
	};

	const dismissImageUpload = (id: string) => {
		activeImageUploadControllersRef.current.get(id)?.abort();
		activeImageUploadControllersRef.current.delete(id);
		const previewUrl = imagePreviewUrlsRef.current.get(id);
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		imagePreviewUrlsRef.current.delete(id);
		setImageUploads((current) => current.filter((item) => item.id !== id));
	};

	return (
		<div className="session-console-composer z-20 shrink-0 bg-[linear-gradient(to_bottom,transparent_0%,var(--panel)_26%)] px-5 pb-5 pt-8 lg:px-8">
			<div className="mx-auto w-full max-w-[756px]">
				<ChatComposerNotices
					runtimeError={runtimeError}
					autoAuditError={autoAuditError}
					compacting={compacting}
					manualCompactionResult={manualCompactionResult}
					onClearRuntimeError={onClearRuntimeError}
					onClearAutoAuditError={onClearAutoAuditError}
					onClearManualCompactionResult={onClearManualCompactionResult}
				/>
				<div className="chat-composer-shell rounded-[18px] border border-[var(--line)] bg-[var(--surface-strong)] px-3 pb-3 pt-2.5 shadow-[0_16px_48px_rgb(24_26_23/7%)] transition focus-within:border-[#b4c0b8] focus-within:shadow-[0_18px_52px_rgb(24_26_23/9%)]">
					{modelSelectionError ? <div className="mb-1 flex w-full items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-[9px] leading-4 text-amber-700"><span>{modelSelectionError}</span>{modelSelectionRetryable ? <button type="button" className="shrink-0 font-semibold underline underline-offset-2" onClick={onRetryModelSelection}>{intl.formatMessage({ id: "chat.model.reload" })}</button> : null}</div> : null}
					{queue.length > 0 ? <QueuePreview items={queue} active={active} mutationId={queueMutationId} onCancel={onCancelQueued} onPromote={onPromoteQueued} /> : null}
					{imageUploads.length > 0 ? <ImageAttachmentUploads uploads={imageUploads} onDismiss={dismissImageUpload} /> : null}
					<ChatTokenEditor ref={editorRef} sessionId={sessionId} value={draft} placeholder={intl.formatMessage({ id: "session.new.composer.placeholder" })} tools={composerTools} onChange={setDraft} onSubmit={() => void submit()} onToolSelect={onToolSelect} onFiles={uploadFiles} />
					<div className="flex items-center justify-between pt-1">
						<div className="flex items-center gap-2 px-2 text-[9px] font-medium text-zinc-500" title={intl.formatMessage({ id: active ? "chat.autoApproval.locked" : "chat.autoApproval.hint" })}>
							<ShieldCheck size={12} className={autoAuditChecked ? "text-[#397b5c]" : "text-zinc-400"} />
							<span>{intl.formatMessage({ id: "session.new.autoApproval" })}</span>
							<ToggleSwitch checked={autoAuditChecked} disabled={active} label={intl.formatMessage({ id: "session.new.autoApproval.label" })} pending={autoAuditPending} onChange={onUpdateAutoAudit} />
						</div>
						<div className="flex items-center gap-1.5">
							{active && hasSubmittableContent ? <button type="button" disabled={!canSubmit} className="grid h-8 w-8 place-items-center rounded-full text-[var(--accent)] transition hover:bg-[var(--accent-soft)] disabled:opacity-40" onClick={() => void submit()} aria-label={intl.formatMessage({ id: "chat.send" })} title={intl.formatMessage({ id: "chat.send" })}>{submitting ? <LoaderCircle size={13} className="animate-spin" /> : <Send size={13} />}</button> : null}
							{modelRequired ? <span className="pr-0.5 text-[8px] font-medium text-amber-700">{intl.formatMessage({ id: "chat.model.selectBeforeSend" })}</span> : null}
							<ChatContextUsageIndicator usage={contextUsage} />
							<ModelThinkingSelector selectedModel={model} thinkingLevel={thinkingLevel} disabled={active || modelSelectionLoading} attention={modelRequired} modelLabel={modelSelectionLoading ? intl.formatMessage({ id: "chat.model.restoring" }) : modelLabel} appearance="composer" onSelectModel={onSelectModel} onSelectThinkingLevel={onSelectThinkingLevel} />
							{active ? <button type="button" className="grid h-8 w-8 place-items-center rounded-full bg-[#282b28] text-white transition hover:bg-[#171a17] disabled:cursor-not-allowed disabled:bg-zinc-300" disabled={cancelling} onClick={onCancel} aria-label={intl.formatMessage({ id: "chat.stop" })} title={intl.formatMessage({ id: "chat.stop" })}>{cancelling ? <LoaderCircle size={13} className="animate-spin" /> : <Square size={11} fill="currentColor" />}</button> : <button type="button" className="grid h-8 w-8 place-items-center rounded-full bg-[#282b28] text-white transition hover:bg-[#171a17] disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400" aria-label={intl.formatMessage({ id: "chat.send" })} disabled={!hasSubmittableContent || !canSubmit} onClick={() => void submit()}>{submitting ? <LoaderCircle size={13} className="animate-spin" /> : <Send size={13} />}</button>}
						</div>
					</div>
				</div>
				<p className="mt-2 text-center text-[8px] tracking-[0.01em] text-zinc-400">{intl.formatMessage({ id: "session.new.guardNotice" })}</p>
			</div>
		</div>
	);
});

function ImageAttachmentUploads({ uploads, onDismiss }: { uploads: ImageUpload[]; onDismiss(id: string): void }) {
	const intl = useIntl();
	const [previewId, setPreviewId] = useState<string | null>(null);
	const previewableUploads = uploads.filter((upload) => upload.previewUrl !== null);
	const previewImages = previewableUploads.flatMap((upload) => upload.previewUrl ? [{
		id: upload.id,
		name: upload.name,
		size: upload.size,
		src: upload.previewUrl,
		dimensions: upload.dimensions,
	}] : []);
	const previewIndex = previewImages.findIndex((image) => image.id === previewId);
	const failedUploads = uploads.filter((upload) => upload.status === "error");
	const hasUploadedImages = uploads.some((upload) => upload.status === "uploaded");

	return (
		<div className="mb-2 border-b border-[var(--line-soft)] px-1 pb-2" aria-live="polite">
			<div className="mb-2 flex items-center gap-1.5 text-[9px] font-semibold text-[var(--secondary)]"><ImageIcon size={11} />{intl.formatMessage({ id: "chat.attachment.title" })}</div>
			{previewableUploads.length > 0 ? <div className="flex flex-wrap gap-2">
				{previewableUploads.map((upload) => {
					const loading = upload.status === "preparing" || upload.status === "uploading";
					const error = upload.status === "error";
					return <div key={upload.id} className={`group relative h-24 w-24 overflow-hidden rounded-xl border bg-[var(--surface-muted)] shadow-[0_1px_2px_rgb(15_23_42/5%)] ${error ? "border-rose-300" : "border-[var(--line-soft)]"}`}>
						<button type="button" className="block h-full w-full overflow-hidden text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" onClick={() => setPreviewId(upload.id)} aria-label={intl.formatMessage({ id: "chat.attachment.preview" }, { name: upload.name })}>
							<img src={upload.previewUrl ?? undefined} alt="" className={`h-full w-full object-cover transition duration-200 group-hover:scale-[1.03] group-focus-within:scale-[1.03] ${loading ? "opacity-55" : ""}`} />
							{loading ? <span className="absolute inset-0 grid place-items-center bg-black/25 text-white" aria-label={intl.formatMessage({ id: upload.status === "preparing" ? "chat.attachment.preparing" : "chat.attachment.uploading" })}><LoaderCircle size={20} className="animate-spin" /></span> : null}
							{error ? <span className="absolute inset-x-0 bottom-0 bg-rose-950/65 px-1.5 py-1 text-center text-[8px] font-medium text-white">{intl.formatMessage({ id: "chat.attachment.failed" })}</span> : null}
						</button>
						<button type="button" className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white opacity-0 shadow-sm transition hover:bg-black/75 focus-visible:opacity-100 group-hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" onClick={() => onDismiss(upload.id)} aria-label={intl.formatMessage({ id: "chat.attachment.remove" }, { name: upload.name })}><X size={13} /></button>
						<div className="pointer-events-none absolute inset-x-0 bottom-0 bg-[linear-gradient(transparent,rgba(0,0,0,0.78))] px-2 pb-1.5 pt-7 text-white opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
							<p className="truncate text-[8px] font-semibold">{upload.name}</p>
							<p className="mt-0.5 truncate text-[7px] text-white/75">{formatImageMetadata(intl, { id: upload.id, name: upload.name, size: upload.size, src: upload.previewUrl ?? "", dimensions: upload.dimensions })}</p>
						</div>
					</div>;
				})}
			</div> : null}
			{failedUploads.length > 0 ? <div className="mt-2 space-y-1" role="alert">{failedUploads.map((upload) => <div key={upload.id} className="flex items-center gap-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-[8px] text-rose-700"><CircleAlert size={10} className="shrink-0" /><span className="min-w-0 flex-1 truncate">{upload.error}</span><button type="button" className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-rose-100" onClick={() => onDismiss(upload.id)} aria-label={intl.formatMessage({ id: "chat.attachment.remove" }, { name: upload.name })}><X size={10} /></button></div>)}</div> : null}
			{hasUploadedImages ? <p className="mt-2 text-[8px] text-[var(--text-faint)]">{intl.formatMessage({ id: "chat.attachment.notice" })}</p> : null}
			{previewIndex >= 0 ? <ChatImagePreviewDialog images={previewImages} initialIndex={previewIndex} onClose={() => setPreviewId(null)} /> : null}
		</div>
	);
}

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
			<div className="app-scrollbar grid max-h-[156px] auto-rows-[36px] gap-1 overflow-y-auto">
				{items.map((item) => <div key={item.id} className="flex items-center gap-2 rounded-lg bg-[var(--surface-muted)] px-2.5 py-1.5">
					<span className={`shrink-0 rounded px-1.5 py-0.5 text-[7px] font-semibold ${item.behavior === "steer" ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--secondary)]"}`}>{intl.formatMessage({ id: item.behavior === "steer" ? "chat.queue.steer" : "chat.queue.followUp" })}</span>
					<span className="min-w-0 flex-1 truncate text-[9px] text-[var(--secondary)]">{queueMessageText(item.message) || intl.formatMessage({ id: "chat.queue.fallback" })}</span>
					{item.behavior === "follow_up" && item.status === "pending" ? <button type="button" className="grid h-6 w-6 shrink-0 place-items-center rounded text-[var(--accent)] transition hover:bg-[var(--accent-soft)] disabled:opacity-40" disabled={!active || mutationId !== null} onClick={() => onPromote(item.id)} aria-label={intl.formatMessage({ id: "chat.steer" })} title={intl.formatMessage({ id: "chat.steer" })}><CornerDownLeft size={12} /></button> : null}
					<button type="button" className="grid h-5 w-5 shrink-0 place-items-center rounded text-zinc-400 transition hover:bg-white hover:text-rose-600 disabled:opacity-40" disabled={!active || mutationId !== null} onClick={() => onCancel(item.id)} aria-label={intl.formatMessage({ id: "chat.queue.cancel" })}>{mutationId === item.id ? <LoaderCircle size={10} className="animate-spin" /> : <X size={10} />}</button>
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

interface PreparedImageUpload {
	file: File;
	dimensions: ImageDimensions;
}

async function prepareImageForUpload(file: File): Promise<PreparedImageUpload> {
	const bitmap = await createImageBitmap(file);
	try {
		const dimensions = fitImageWithinMaximumDimension(bitmap);
		if (dimensions.width === bitmap.width && dimensions.height === bitmap.height) return { file, dimensions };
		const canvas = document.createElement("canvas");
		canvas.width = dimensions.width;
		canvas.height = dimensions.height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Image canvas is unavailable");
		context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
		const outputType = file.type === "image/jpeg" || file.type === "image/png" || file.type === "image/webp"
			? file.type
			: "image/png";
		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((value) => {
				if (value) resolve(value);
				else reject(new Error("Image encoding failed"));
			}, outputType, outputType === "image/png" ? undefined : 0.9);
		});
		const name = outputType === file.type ? file.name : `${file.name.replace(/\.[^.]+$/u, "")}.png`;
		return { file: new File([blob], name, { type: outputType, lastModified: file.lastModified }), dimensions };
	} finally {
		bitmap.close();
	}
}
