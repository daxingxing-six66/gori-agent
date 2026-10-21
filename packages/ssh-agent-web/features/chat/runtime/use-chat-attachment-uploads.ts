"use client";

import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { AttachmentPreparationError, prepareChatAttachment } from "@/features/chat/model/prepare-chat-attachment";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { sessionAttachmentApi, type SessionAttachment } from "@/features/session/api/session-attachment-api";
import { attachmentFileKind, maximumChatAttachments, type AttachmentFileKind } from "@/features/session/model/attachment-file";
import type { ImageDimensions } from "@/features/session/model/image-upload";

const preparationMessageIds = {
	unsupported: "chat.attachment.unsupported",
	tooLarge: "chat.attachment.tooLarge",
	invalidText: "chat.attachment.invalidText",
	imageProcessing: "chat.attachment.processingFailed",
} as const;

export interface ChatAttachmentUpload {
	id: string;
	kind: AttachmentFileKind | null;
	name: string;
	size: number;
	previewUrl: string | null;
	dimensions?: ImageDimensions;
	status: "preparing" | "uploading" | "uploaded" | "error";
	attachment: SessionAttachment | null;
	error: string | null;
}

export function useChatAttachmentUploads(sessionId: string) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const [uploads, setUploads] = useState<ChatAttachmentUpload[]>([]);
	const [limitNotice, setLimitNotice] = useState(false);
	const uploadsRef = useRef(uploads);
	const controllersRef = useRef(new Map<string, AbortController>());
	const previewUrlsRef = useRef(new Map<string, string>());
	const latestSessionIdRef = useRef(sessionId);
	latestSessionIdRef.current = sessionId;

	const update = (transform: (current: ChatAttachmentUpload[]) => ChatAttachmentUpload[]) => {
		uploadsRef.current = transform(uploadsRef.current);
		setUploads(uploadsRef.current);
	};
	const release = (id: string) => {
		controllersRef.current.get(id)?.abort();
		controllersRef.current.delete(id);
		const preview = previewUrlsRef.current.get(id);
		if (preview) URL.revokeObjectURL(preview);
		previewUrlsRef.current.delete(id);
	};
	const dismiss = (id: string) => {
		release(id);
		update((current) => current.filter((upload) => upload.id !== id));
		setLimitNotice(false);
	};

	useEffect(() => {
		for (const controller of controllersRef.current.values()) controller.abort();
		controllersRef.current.clear();
		for (const preview of previewUrlsRef.current.values()) URL.revokeObjectURL(preview);
		previewUrlsRef.current.clear();
		uploadsRef.current = [];
		setUploads([]);
		setLimitNotice(false);
		return () => {
			for (const controller of controllersRef.current.values()) controller.abort();
			controllersRef.current.clear();
			for (const preview of previewUrlsRef.current.values()) URL.revokeObjectURL(preview);
			previewUrlsRef.current.clear();
		};
	}, [sessionId]);

	const addFiles = (files: File[]) => {
		const available = Math.max(0, maximumChatAttachments - uploadsRef.current.length);
		setLimitNotice(files.length > available);
		const newUploads = files.slice(0, available).map((file) => ({
			id: crypto.randomUUID(), file, controller: new AbortController(),
		}));
		for (const { id, controller } of newUploads) controllersRef.current.set(id, controller);
		update((current) => [...current, ...newUploads.map(({ id, file }): ChatAttachmentUpload => ({
			id, kind: attachmentFileKind(file.name, file.type), name: file.name, size: file.size,
			previewUrl: null, status: "preparing", attachment: null, error: null,
		}))]);
		for (const upload of newUploads) void uploadFile(upload.id, upload.file, upload.controller);
	};

	const uploadFile = async (id: string, file: File, controller: AbortController) => {
		const current = () => !controller.signal.aborted && latestSessionIdRef.current === sessionId;
		const patch = (changes: Partial<ChatAttachmentUpload>) => {
			if (current()) update((items) => items.map((upload) => upload.id === id ? { ...upload, ...changes } : upload));
		};
		try {
			const prepared = await prepareChatAttachment(file, controller.signal);
			if (!current()) return;
			const previewUrl = prepared.kind === "image" ? URL.createObjectURL(prepared.file) : null;
			if (previewUrl) previewUrlsRef.current.set(id, previewUrl);
			patch({ name: prepared.file.name, size: prepared.file.size, dimensions: prepared.dimensions, previewUrl, status: "uploading" });
			const attachment = await sessionAttachmentApi.upload(sessionId, prepared.file, controller.signal);
			patch({ name: attachment.name, size: attachment.size, status: "uploaded", attachment });
		} catch (error) {
			const message = error instanceof AttachmentPreparationError
				? intl.formatMessage({ id: preparationMessageIds[error.reason] })
				: localizedErrorMessage(error);
			patch({ status: "error", attachment: null, error: message });
		} finally {
			if (controllersRef.current.get(id) === controller) controllersRef.current.delete(id);
		}
	};

	return {
		uploads,
		limitNotice,
		addFiles,
		dismiss,
		clearSubmitted: (attachmentIds: readonly string[]) => {
			const submitted = new Set(attachmentIds);
			for (const upload of uploadsRef.current) if (upload.attachment && submitted.has(upload.attachment.id)) dismiss(upload.id);
		},
		attachments: uploads.flatMap((upload) => upload.status === "uploaded" && upload.attachment ? [upload.attachment] : []),
		pending: uploads.some((upload) => upload.status === "preparing" || upload.status === "uploading"),
	};
}
