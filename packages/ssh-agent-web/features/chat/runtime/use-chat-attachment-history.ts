"use client";

import { type Dispatch, type RefObject, useCallback, useEffect, useRef } from "react";
import type { AgentMessage, ChatStreamEvent } from "@/features/chat/model/chat";
import type { ChatRuntimeAction, ChatRuntimeState, ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";
import { listMessagePages } from "./chat-message-history";

/** SSE carries attachment IDs; the existing persisted history supplies their display metadata. */
export function useChatAttachmentHistory(sessionId: string, state: RefObject<ChatRuntimeState>, dispatch: Dispatch<ChatRuntimeAction>, onError: (error: unknown) => void) {
	const synchronizer = useRef<AttachmentHistorySynchronizer | null>(null);
	useEffect(() => {
		const current = new AttachmentHistorySynchronizer(async (afterSequence) => {
			const messages = await listMessagePages(sessionId, afterSequence);
			if (!current.closed) dispatch({ type: "mergePersisted", messages });
		}, onError);
		synchronizer.current = current;
		return () => { current.close(); if (synchronizer.current === current) synchronizer.current = null; };
	}, [sessionId, dispatch, onError]);
	return useCallback((event: ChatStreamEvent) => synchronizer.current?.receive(event, state.current), [state]);
}

class AttachmentHistorySynchronizer {
	readonly #synchronize: (afterSequence: number) => Promise<void>;
	readonly #onError: (error: unknown) => void;
	readonly #seen = new Set<string>();
	#pendingCursor: number | null = null;
	#running = false;
	#closed = false;

	constructor(synchronize: (afterSequence: number) => Promise<void>, onError: (error: unknown) => void) {
		this.#synchronize = synchronize;
		this.#onError = onError;
	}

	get closed(): boolean { return this.#closed; }
	close(): void { this.#closed = true; this.#pendingCursor = null; }

	receive(event: ChatStreamEvent, state: ChatRuntimeState): void {
		if (this.#closed || event.type !== "message_end" || event.data.message.role !== "user") return;
		const message = event.data.message;
		if (!("attachmentIds" in message) || !Array.isArray(message.attachmentIds)) return;
		const ids = message.attachmentIds.filter((id): id is string => typeof id === "string");
		if (ids.length === 0) return;
		const entry = state.timeline.find((candidate) => candidate.message.role === "user" && candidate.message.timestamp === message.timestamp)
			?? state.timeline.find((candidate) => matchesOptimisticMessage(candidate, message, state.run?.id));
		if (ids.every((id) => entry?.attachments?.some((attachment) => attachment.id === id))) return;
		const key = JSON.stringify([message.timestamp, ids]);
		if (this.#seen.has(key)) return;
		this.#seen.add(key);
		// Keep the earliest requested cursor while another read is pending; newer pages cannot skip a waiting attachment.
		this.#pendingCursor = Math.min(this.#pendingCursor ?? state.maxSequence, state.maxSequence);
		void this.#drain();
	}

	async #drain(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			while (!this.#closed && this.#pendingCursor !== null) {
				const cursor = this.#pendingCursor;
				this.#pendingCursor = null;
				try { await this.#synchronize(cursor); }
				catch (error) { if (!this.#closed) this.#onError(error); }
			}
		} finally { this.#running = false; }
	}
}

function matchesOptimisticMessage(entry: ChatTimelineEntry, message: AgentMessage, runId?: string): boolean {
	return entry.optimisticRequestId !== undefined && (entry.runId === undefined || entry.runId === runId)
		&& entry.message.role === "user" && message.role === "user" && messageText(entry.message) === messageText(message);
}

function messageText(message: Extract<AgentMessage, { role: "user" }>): string {
	return typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}
