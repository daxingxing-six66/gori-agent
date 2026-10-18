import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import properties from "highlight.js/lib/languages/properties";
import gradle from "highlight.js/lib/languages/gradle";

hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("properties", properties);
hljs.registerLanguage("gradle", gradle);

const extensions: Readonly<Record<string, string>> = {
	sql: "sql", yml: "yaml", yaml: "yaml", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", java: "java", json: "json", jsonc: "json",
	py: "python", rb: "ruby", go: "go", rs: "rust", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
	css: "css", scss: "scss", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", svelte: "xml",
	sh: "bash", bash: "bash", zsh: "bash", php: "php", kt: "kotlin", kts: "kotlin", swift: "swift",
	ini: "ini", toml: "ini", properties: "properties", conf: "ini", gradle: "gradle", diff: "diff", patch: "diff",
	md: "markdown", markdown: "markdown", mdx: "markdown", mdown: "markdown",
};

export function fileLanguage(path: string): string {
	const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
	if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
	if (name === "makefile" || name === "gnumakefile") return "makefile";
	if (name === ".env" || name.startsWith(".env.")) return "ini";
	return extensions[name.split(".").at(-1) ?? ""] ?? "plaintext";
}

export const MAX_HIGHLIGHT_CHARACTERS = 200_000;

/** Only the highlighter's escaped output may be inserted into the code element. */
export function highlightedCode(content: string, language: string): string | null {
	if (content.length > MAX_HIGHLIGHT_CHARACTERS || !hljs.getLanguage(language)) return null;
	try { return hljs.highlight(content, { language, ignoreIllegals: true }).value; }
	catch { return null; }
}
