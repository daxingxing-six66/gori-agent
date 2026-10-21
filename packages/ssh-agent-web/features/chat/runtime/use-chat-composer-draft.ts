"use client";

import { useMemo, useSyncExternalStore } from "react";
import { getChatComposerDraftStore } from "@/features/chat/runtime/chat-composer-draft-store";

const emptySnapshot = { text: "", navigatingHistory: false };
const emptyDraft = () => emptySnapshot;

export function useChatComposerDraft(sessionId: string) {
	const store = useMemo(() => getChatComposerDraftStore(sessionId), [sessionId]);
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, emptyDraft);
	return { draft: snapshot.text, navigatingHistory: snapshot.navigatingHistory, setDraft: store.set,
		clearForSubmission: store.clearForSubmission, navigateHistory: store.navigateHistory };
}
