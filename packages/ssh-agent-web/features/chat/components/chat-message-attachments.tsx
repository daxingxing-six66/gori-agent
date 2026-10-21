"use client";

import { useState } from "react";
import { useIntl } from "react-intl";
import { attachmentFileKind } from "@/features/session/model/attachment-file";
import type { SessionAttachment } from "@/features/session/api/session-attachment-api";
import { apiUrl } from "@/shared/api/client";
import { ChatDocumentAttachment } from "./chat-document-attachment";
import { ChatImagePreviewDialog, formatImageMetadata, type ImageDimensions } from "./chat-image-preview-dialog";

export function ChatMessageAttachments({ attachments, onOpenAttachment }: {
	attachments: SessionAttachment[];
	onOpenAttachment?(attachment: SessionAttachment): void;
}) {
	const images = attachments.filter((attachment) => attachmentFileKind(attachment.name, attachment.mimeType) === "image");
	const documents = attachments.filter((attachment) => attachmentFileKind(attachment.name, attachment.mimeType) === "document");
	if (images.length === 0 && documents.length === 0) return null;
	return <div className="flex w-full min-w-0 flex-col items-end gap-2">
		{images.length > 0 ? <div className="w-1/2 min-w-0"><SentImageAttachments attachments={images} /></div> : null}
		{documents.length > 0 ? <div className="flex w-full max-w-[78%] flex-wrap justify-end gap-2">
			{documents.map((attachment) => <ChatDocumentAttachment key={attachment.id} name={attachment.name} size={attachment.size}
				onOpen={onOpenAttachment ? () => onOpenAttachment(attachment) : undefined} />)}
		</div> : null}
	</div>;
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
