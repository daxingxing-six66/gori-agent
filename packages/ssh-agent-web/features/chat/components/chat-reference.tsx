import { Folder } from "lucide-react";
import { fileBadgeForName, parseChatComposerMessage, type ChatComposerReference } from "@/features/chat/model/chat-composer";

export function ChatReference({ reference, compact = false }: { reference: ChatComposerReference; compact?: boolean }) {
	return (
		<span className={`chat-reference ${compact ? "chat-reference-compact" : ""}`} title={reference.path} data-reference-type={reference.type}>
			{reference.type === "folder" ? <Folder size={compact ? 11 : 12} strokeWidth={2} /> : <span className="chat-reference-badge">{fileBadgeForName(reference.name)}</span>}
			<span>{reference.name}</span>
		</span>
	);
}

export function ChatComposerMessage({ message }: { message: string }) {
	return parseChatComposerMessage(message).map((part, index) =>
		part.type === "text"
			? <span key={`text:${index}`} className="whitespace-pre-wrap">{part.text}</span>
			: <ChatReference key={`${part.reference.type}:${part.reference.path}:${index}`} reference={part.reference} compact />,
	);
}
