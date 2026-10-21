"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { chatApi } from "@/features/chat/api/chat-api";
import { chatComposerHistoryLimit, recentChatComposerMessages } from "@/features/chat/model/chat-composer-history";
import type { ChatTimelineEntry } from "@/features/chat/model/chat-runtime-state";

interface ComposerHistoryPage {
	sessionId: string;
	messages: ChatTimelineEntry[];
}

/** Fill keyboard history without hydrating older tool output into the visible timeline. */
export function useChatComposerHistory(sessionId: string, timeline: readonly ChatTimelineEntry[], loading: boolean): readonly string[] {
	const latest = useRef({ sessionId, timeline });
	latest.current = { sessionId, timeline };
	const [older, setOlder] = useState<ComposerHistoryPage>({ sessionId, messages: [] });

	useEffect(() => {
		let cancelled = false;
		setOlder({ sessionId, messages: [] });
		if (loading) return;
		const sequences = latest.current.timeline.flatMap((entry) =>
			entry.sequence !== undefined && entry.sequence > 0 ? [entry.sequence] : []);
		let cursor = sequences.length > 0 ? Math.min(...sequences) : null;
		const fillHistory = async () => {
			let messages: ChatTimelineEntry[] = [];
			while (!cancelled && latest.current.sessionId === sessionId && cursor !== null
				&& recentChatComposerMessages(mergeHistory(messages, latest.current.timeline)).length < chatComposerHistoryLimit) {
				const page = await chatApi.listMessages(sessionId, { beforeSequence: cursor, limit: 100 });
				if (cancelled || latest.current.sessionId !== sessionId) return;
				const users = page.messages.flatMap((entry): ChatTimelineEntry[] => {
					const text = recentChatComposerMessages([entry])[0];
					return text === undefined ? [] : [{
						key: `persisted:${entry.id}`, sequence: entry.sequence, final: true,
						message: { role: "user", content: text, timestamp: entry.message.timestamp },
					}];
				});
				messages = mergeHistory(messages, users).slice(-chatComposerHistoryLimit);
				setOlder({ sessionId, messages });
				const next = page.nextBeforeSequence;
				if (next === null || !Number.isFinite(next) || next <= 0 || next >= cursor) return;
				cursor = next;
			}
		};
		// Optional recall history must not interrupt sending or replace the main Runtime error.
		void fillHistory().catch(() => {});
		// listMessages has no AbortSignal parameter; invalidation cancels all further work.
		return () => { cancelled = true; };
	}, [sessionId, loading]);

	return useMemo(() => recentChatComposerMessages(mergeHistory(
		older.sessionId === sessionId ? older.messages : [], timeline,
	)), [older, sessionId, timeline]);
}

function mergeHistory(older: readonly ChatTimelineEntry[], current: readonly ChatTimelineEntry[]): ChatTimelineEntry[] {
	const entries = new Map(older.map((entry) => [entry.key, entry]));
	for (const entry of current) entries.set(entry.key, entry);
	return [...entries.values()].filter((entry) => entry.message.role === "user").sort((left, right) => {
		if (left.sequence === undefined) return right.sequence === undefined ? 0 : 1;
		if (right.sequence === undefined) return -1;
		return left.sequence - right.sequence;
	});
}
