export type ChatComposerReferenceType = "file" | "folder";

export interface ChatComposerFileReference {
	type: "file";
	name: string;
	path: string;
	mimeType: string;
}

export interface ChatComposerFolderReference {
	type: "folder";
	name: string;
	path: string;
}

export type ChatComposerReference = ChatComposerFileReference | ChatComposerFolderReference;

export type ChatComposerPart =
	| { type: "text"; text: string }
	| { type: "reference"; reference: ChatComposerReference };

const embeddedReferencePattern = /<(file|folder)\s+([^<>]*?)\s*\/>/gu;
const attributePattern = /([A-Za-z][\w-]*)\s*=\s*"([^"]*)"/gu;

export function parseChatComposerMessage(message: string): ChatComposerPart[] {
	const parts: ChatComposerPart[] = [];
	let offset = 0;
	for (const match of message.matchAll(embeddedReferencePattern)) {
		const index = match.index;
		if (index > offset) appendText(parts, message.slice(offset, index));
		const reference = parseReference(match[1], match[2]);
		if (reference) parts.push({ type: "reference", reference });
		else appendText(parts, match[0]);
		offset = index + match[0].length;
	}
	if (offset < message.length) appendText(parts, message.slice(offset));
	return parts.length > 0 ? parts : [{ type: "text", text: "" }];
}

export function serializeChatComposerReference(reference: ChatComposerReference): string {
	if (reference.type === "folder") {
		return `<folder name="${escapeAttribute(reference.name)}" path="${escapeAttribute(reference.path)}" />`;
	}
	return `<file name="${escapeAttribute(reference.name)}" path="${escapeAttribute(reference.path)}" type="${escapeAttribute(reference.mimeType)}" />`;
}

export function visibleChatComposerText(message: string): string {
	return parseChatComposerMessage(message)
		.map((part) => part.type === "text" ? part.text : part.reference.name)
		.join("");
}

export function hasChatComposerContent(message: string): boolean {
	return parseChatComposerMessage(message).some((part) =>
		part.type === "reference" || part.text.trim().length > 0,
	);
}

export function mimeTypeForLocalFile(name: string, provided?: string): string {
	if (provided) return provided;
	const extension = name.toLowerCase().split(".").pop();
	return ({
		jar: "application/java-archive",
		json: "application/json",
		md: "text/markdown",
		txt: "text/plain",
		yaml: "application/yaml",
		yml: "application/yaml",
		ts: "text/typescript",
		tsx: "text/typescript-jsx",
		js: "text/javascript",
		jsx: "text/javascript-jsx",
		css: "text/css",
		html: "text/html",
		xml: "application/xml",
		sh: "application/x-sh",
		zip: "application/zip",
	} as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

export function fileBadgeForName(name: string): string {
	const extension = name.split(".").pop();
	if (!extension || extension === name) return "FILE";
	return extension.slice(0, 3).toUpperCase();
}

function parseReference(type: string | undefined, source: string | undefined): ChatComposerReference | null {
	if ((type !== "file" && type !== "folder") || source === undefined) return null;
	const attributes = new Map<string, string>();
	for (const match of source.matchAll(attributePattern)) {
		attributes.set(match[1], unescapeAttribute(match[2]));
	}
	const name = attributes.get("name");
	const path = attributes.get("path");
	if (!name || !path) return null;
	if (type === "folder") return { type, name, path };
	return { type, name, path, mimeType: attributes.get("type") ?? "application/octet-stream" };
}

function appendText(parts: ChatComposerPart[], text: string): void {
	const previous = parts.at(-1);
	if (previous?.type === "text") previous.text += text;
	else parts.push({ type: "text", text });
}

function escapeAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function unescapeAttribute(value: string): string {
	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}
