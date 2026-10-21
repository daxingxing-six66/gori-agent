export type AttachmentFileKind = "image" | "document";

const documentExtensions = [
	"md", "mdx", "markdown", "mdown", "txt", "text", "json", "jsonl", "ndjson", "csv", "tsv", "yaml", "yml",
	"toml", "ini", "conf", "config", "log", "xml", "html", "htm", "css", "scss", "sass", "less",
	"js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "sh", "bash", "zsh", "fish", "sql", "go", "rs",
	"java", "c", "h", "cpp", "hpp", "cc", "cs", "rb", "php", "swift", "kt", "kts", "vue", "svelte",
	"properties", "env", "gitignore", "dockerignore",
] as const;
const documentExtensionSet = new Set<string>(documentExtensions);
const imageExtensions = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg", "avif", "ico", "heic", "heif", "tif", "tiff"]);

export const maximumChatAttachments = 4;
export const maximumAttachmentUploadBytes = 20 * 1024 * 1024;

/** A UI hint only. The server independently validates file signatures and UTF-8 content. */
export function attachmentFileKind(name: string, mimeType: string): AttachmentFileKind | null {
	const normalizedName = name.toLowerCase();
	const lastDot = normalizedName.lastIndexOf(".");
	const extension = lastDot < 0 ? "" : normalizedName.slice(lastDot + 1);
	if (mimeType.toLowerCase().startsWith("image/") || imageExtensions.has(extension)) return "image";
	if (documentExtensionSet.has(extension) ||
		/^(?:dockerfile|makefile|\.env|\.gitignore|\.dockerignore)(?:-\d+)?$/u.test(normalizedName) ||
		/^\.env(?:-\d+)?(?:\.|$)/u.test(normalizedName)) return "document";
	return null;
}

export function formatAttachmentBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
