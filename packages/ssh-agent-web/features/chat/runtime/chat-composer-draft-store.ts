import { hasChatComposerContent } from "@/features/chat/model/chat-composer";
import { chatComposerHistoryLimit, type ChatComposerHistoryDirection } from "@/features/chat/model/chat-composer-history";

interface ChatComposerDraftSnapshot {
	text: string;
	navigatingHistory: boolean;
}

interface ChatComposerHistoryNavigation {
	messages: readonly string[];
	index: number;
	originalDraft: string;
}

/** Drafts and history navigation live independently of mounted Session views. */
export class ChatComposerDraftStore {
	private snapshot: ChatComposerDraftSnapshot = { text: "", navigatingHistory: false };
	private navigation: ChatComposerHistoryNavigation | null = null;
	private revision = 0;
	private readonly listeners = new Set<() => void>();

	getSnapshot = () => this.snapshot;

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	set = (value: string) => {
		this.navigation = null;
		this.update(value);
	};

	navigateHistory = (direction: ChatComposerHistoryDirection, messages: readonly string[]): boolean => {
		if (!this.navigation) {
			if (direction === "newer" || hasChatComposerContent(this.snapshot.text)) return false;
			const recent = messages.filter(hasChatComposerContent).slice(0, chatComposerHistoryLimit);
			if (recent.length === 0) return false;
			// Freeze this browsing pass so incoming messages cannot move its cursor.
			this.navigation = { messages: recent, index: 0, originalDraft: this.snapshot.text };
		} else if (direction === "older") {
			this.navigation.index = Math.min(this.navigation.index + 1, this.navigation.messages.length - 1);
		} else if (this.navigation.index > 0) {
			this.navigation.index -= 1;
		} else {
			const originalDraft = this.navigation.originalDraft;
			this.navigation = null;
			this.update(originalDraft);
			return true;
		}
		this.update(this.navigation.messages[this.navigation.index]!);
		return true;
	};

	private update(value: string): void {
		const navigatingHistory = this.navigation !== null;
		if (value === this.snapshot.text && navigatingHistory === this.snapshot.navigatingHistory) return;
		this.snapshot = { text: value, navigatingHistory };
		this.revision += 1;
		for (const listener of this.listeners) listener();
	}

	clearForSubmission = () => {
		const submitted = this.snapshot.text;
		this.set("");
		const revision = this.revision;
		return () => {
			// A late failure belongs to its original draft, never to subsequent edits.
			if (revision === this.revision) this.set(submitted);
		};
	};
}

const sessionDrafts = new Map<string, ChatComposerDraftStore>();

export function getChatComposerDraftStore(sessionId: string): ChatComposerDraftStore {
	let store = sessionDrafts.get(sessionId);
	if (!store) {
		store = new ChatComposerDraftStore();
		sessionDrafts.set(sessionId, store);
	}
	return store;
}
