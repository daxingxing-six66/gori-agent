import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReaderContent } from "../features/file-reader/components/reader-content";
import { fileLanguage, highlightedCode, MAX_HIGHLIGHT_CHARACTERS } from "../features/file-reader/model/file-language";
import { readerDocument, readerPath } from "../features/file-reader/model/reader-file";

describe("file reader content", () => {
	it.each([
		["schema.sql", "sql", "SELECT id FROM users;"], ["application.yml", "yaml", "server:\n  port: 8080"],
		["config.yaml", "yaml", "enabled: true"], ["index.js", "javascript", "const count = 1;"],
		["View.tsx", "typescript", "const count: number = 1;"], ["Main.java", "java", "public class Main {}"],
		["Dockerfile", "dockerfile", "FROM alpine:latest"], ["Makefile", "makefile", "all:\n\techo ok"],
	])("detects and highlights %s", (path, language, content) => {
		expect(fileLanguage(path)).toBe(language);
		const html = renderToStaticMarkup(<ReaderContent path={path} content={content} />);
		expect(html).toContain(`language-${language}`);
		expect(html).toContain('class="hljs-');
	});

	it("renders Markdown as a GFM document with highlighted fenced code and no source view", () => {
		const html = renderToStaticMarkup(<ReaderContent path="docs/README.MD" content={"# 阅读说明\n\n**预览**\n\n| 名称 | 值 |\n|---|---|\n| port | 8080 |\n\n```sql\nSELECT 1;\n```"} />);
		expect(html).toContain("<h1>阅读说明</h1>");
		expect(html).toContain("<strong>预览</strong>");
		expect(html).toContain("<table>");
		expect(html).toContain('class="hljs-keyword"');
		expect(html).not.toContain("# 阅读说明");
		expect(html).not.toContain("```sql");
	});

	it("escapes code and ignores executable HTML and unsafe Markdown links", () => {
		const attack = '<script>alert("xss")</script>';
		const code = renderToStaticMarkup(<ReaderContent path="attack.js" content={attack} />);
		expect(code).not.toContain("<script>");
		expect(code).toContain("&lt;");
		const md = renderToStaticMarkup(<ReaderContent path="attack.md" content={`${attack}\n\n[click](javascript:alert(1))\n\n[docs](https://example.com)\n\n[local](./file.md)`} />);
		expect(md).not.toContain("<script>");
		expect(md).not.toContain("javascript:");
		expect(md).not.toContain('href="./file.md"');
		expect(md).toContain('href="https://example.com" target="_blank" rel="noreferrer noopener"');
	});

	it("uses escaped plain text for unknown languages and bounds highlighting work", () => {
		expect(fileLanguage("notes.unknown")).toBe("plaintext");
		expect(highlightedCode("<raw>", "unknown-language")).toBeNull();
		expect(highlightedCode("a".repeat(MAX_HIGHLIGHT_CHARACTERS + 1), "typescript")).toBeNull();
		expect(renderToStaticMarkup(<ReaderContent path="notes.txt" content="<raw>" />)).toContain("&lt;raw&gt;");
	});

	it("deduplicates equivalent paths and keeps same-named files in different folders distinct", () => {
		expect(readerDocument("./src/../README.md", "/work/project")).toEqual(readerDocument("/work/project/README.md"));
		expect(readerDocument("src/index.ts", "/work").id).not.toBe(readerDocument("test/index.ts", "/work").id);
		expect(readerPath("..\\src\\main.ts", "C:\\work\\project")).toBe("C:/work/src/main.ts");
	});
});
