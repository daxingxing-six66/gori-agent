"use client";

import { CircleAlert, ImageIcon, LoaderCircle, Paperclip, X } from "lucide-react";
import { useState } from "react";
import { useIntl } from "react-intl";
import { ChatDocumentAttachment } from "@/features/chat/components/chat-document-attachment";
import { ChatImagePreviewDialog, formatImageMetadata } from "@/features/chat/components/chat-image-preview-dialog";
import type { ChatAttachmentUpload } from "@/features/chat/runtime/use-chat-attachment-uploads";
import type { SessionAttachment } from "@/features/session/api/session-attachment-api";

export function ChatAttachmentUploads({ uploads, limitNotice, onDismiss, onOpenAttachment }: {
	uploads: ChatAttachmentUpload[];
	limitNotice: boolean;
	onDismiss(id: string): void;
	onOpenAttachment?(attachment: SessionAttachment): void;
}) {
	const intl = useIntl();
	const [previewId, setPreviewId] = useState<string | null>(null);
	const previewImages = uploads.flatMap((upload) => upload.kind === "image" && upload.previewUrl ? [{
		id: upload.id, name: upload.name, size: upload.size, src: upload.previewUrl, dimensions: upload.dimensions,
	}] : []);
	const previewIndex = previewImages.findIndex((image) => image.id === previewId);
	const openDocument = (upload: ChatAttachmentUpload) => {
		if (upload.attachment) onOpenAttachment?.(upload.attachment);
	};
	if (!uploads.length && !limitNotice) return null;

	return <div className="mb-2 border-b border-[var(--line-soft)] px-1 pb-2" aria-live="polite">
		<div className="mb-2 flex items-center gap-1.5 text-[9px] font-semibold text-[var(--secondary)]"><Paperclip size={11} />{intl.formatMessage({ id: "chat.attachment.title" })}</div>
		<div className="flex flex-wrap items-start gap-2">
			{uploads.map((upload) => upload.kind === "image"
				? <ImageUploadCard key={upload.id} upload={upload} onPreview={() => setPreviewId(upload.id)} onDismiss={() => onDismiss(upload.id)} />
				: <ChatDocumentAttachment key={upload.id} name={upload.name} size={upload.size} status={upload.status} error={upload.error}
					onRemove={() => onDismiss(upload.id)} onOpen={upload.attachment && onOpenAttachment ? () => openDocument(upload) : undefined} />)}
		</div>
		{uploads.some((upload) => upload.status === "error") ? <div className="mt-2 space-y-1" role="alert">
			{uploads.filter((upload) => upload.error).map((upload) => <p key={upload.id} className="flex items-start gap-1.5 text-[10px] text-[var(--danger)]"><CircleAlert size={11} className="mt-0.5 shrink-0" /><span>{upload.name}: {upload.error}</span></p>)}
		</div> : null}
		{limitNotice ? <p role="alert" className="mt-2 text-[10px] text-[var(--warning)]">{intl.formatMessage({ id: "chat.attachment.limit" })}</p> : null}
		{uploads.some((upload) => upload.status === "uploaded" && upload.kind === "image") ? <p className="mt-2 text-[9px] text-[var(--text-faint)]">{intl.formatMessage({ id: "chat.attachment.notice" })}</p> : null}
		{uploads.some((upload) => upload.status === "uploaded" && upload.kind === "document") ? <p className="mt-1 text-[9px] text-[var(--text-faint)]">{intl.formatMessage({ id: "chat.attachment.document.notice" })}</p> : null}
		{previewIndex >= 0 ? <ChatImagePreviewDialog images={previewImages} initialIndex={previewIndex} onClose={() => setPreviewId(null)} /> : null}
	</div>;
}

function ImageUploadCard({ upload, onPreview, onDismiss }: { upload: ChatAttachmentUpload; onPreview(): void; onDismiss(): void }) {
	const intl = useIntl();
	const loading = upload.status === "preparing" || upload.status === "uploading";
	const error = upload.status === "error";
	return <div className={`group relative h-24 w-24 overflow-hidden rounded-xl border bg-[var(--surface-muted)] shadow-[0_1px_2px_rgb(15_23_42/5%)] ${error ? "border-[var(--danger)]" : "border-[var(--line-soft)]"}`}>
		<button type="button" disabled={!upload.previewUrl} className="block h-full w-full overflow-hidden text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" onClick={onPreview} aria-label={intl.formatMessage({ id: "chat.attachment.preview" }, { name: upload.name })}>
			{upload.previewUrl ? <img src={upload.previewUrl} alt="" className={`h-full w-full object-cover transition duration-200 group-hover:scale-[1.03] group-focus-within:scale-[1.03] ${loading ? "opacity-55" : ""}`} /> : <span className="grid h-full w-full place-items-center text-[var(--text-muted)]"><ImageIcon size={24} /></span>}
			{loading ? <span className="absolute inset-0 grid place-items-center bg-black/25 text-white" aria-label={intl.formatMessage({ id: upload.status === "preparing" ? "chat.attachment.preparing" : "chat.attachment.uploading" })}><LoaderCircle size={20} className="animate-spin" /></span> : null}
			{error ? <span className="absolute inset-x-0 bottom-0 bg-rose-950/65 px-1.5 py-1 text-center text-[8px] font-medium text-white">{intl.formatMessage({ id: "chat.attachment.failed" })}</span> : null}
		</button>
		<button type="button" className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white opacity-0 shadow-sm transition hover:bg-black/75 focus-visible:opacity-100 group-hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" onClick={onDismiss} aria-label={intl.formatMessage({ id: "chat.attachment.remove" }, { name: upload.name })}><X size={13} /></button>
		<div className="pointer-events-none absolute inset-x-0 bottom-0 bg-[linear-gradient(transparent,rgba(0,0,0,0.78))] px-2 pb-1.5 pt-7 text-white opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
			<p className="truncate text-[8px] font-semibold">{upload.name}</p>
			<p className="mt-0.5 truncate text-[7px] text-white/75">{formatImageMetadata(intl, { id: upload.id, name: upload.name, size: upload.size, src: upload.previewUrl ?? "", dimensions: upload.dimensions })}</p>
		</div>
	</div>;
}
