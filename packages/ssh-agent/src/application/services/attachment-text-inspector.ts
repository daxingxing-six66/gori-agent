import type { FileHandle } from "node:fs/promises";
import { basename, extname } from "node:path";

const TEXT_EXTENSIONS = new Set([
	".md", ".mdx", ".markdown", ".mdown", ".txt", ".text", ".json", ".jsonl", ".ndjson", ".csv", ".tsv",
	".yaml", ".yml", ".toml", ".ini", ".conf", ".config", ".log", ".xml", ".html", ".htm", ".css", ".scss",
	".sass", ".less", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".sh", ".bash", ".zsh", ".fish",
	".sql", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".rb", ".php", ".swift",
	".kt", ".kts", ".vue", ".svelte", ".properties", ".env", ".gitignore", ".dockerignore",
]);

export function isTextAttachmentName(name: string): boolean {
	const normalized = basename(name).toLowerCase();
	return TEXT_EXTENSIONS.has(extname(normalized)) ||
		/^(?:dockerfile|makefile|\.env|\.gitignore|\.dockerignore)(?:-\d+)?$/u.test(normalized) ||
		/^\.env(?:-\d+)?(?:\.|$)/u.test(normalized);
}

export class AttachmentTextInspectionError extends Error {
	constructor() { super("Attachment must contain UTF-8 text without binary control characters"); }
}

/** Validate every byte without retaining document content in the model context. */
export async function inspectAttachmentText(handle: FileHandle, size: number, signal?: AbortSignal): Promise<void> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const buffer = Buffer.alloc(64 * 1024);
	let offset = 0;
	while (offset < size) {
		signal?.throwIfAborted();
		const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
		if (bytesRead === 0) throw new AttachmentTextInspectionError();
		assertText(decode(decoder, buffer.subarray(0, bytesRead), true));
		offset += bytesRead;
	}
	assertText(decode(decoder, new Uint8Array(), false));
}

function decode(decoder: TextDecoder, bytes: Uint8Array, stream: boolean): string {
	try { return decoder.decode(bytes, { stream }); }
	catch { throw new AttachmentTextInspectionError(); }
}

function assertText(content: string): void {
	if (/[\x00-\x08\x0e-\x1f]/u.test(content)) throw new AttachmentTextInspectionError();
}
