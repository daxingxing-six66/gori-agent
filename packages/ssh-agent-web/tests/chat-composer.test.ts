import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localFilesApi } from "../features/chat/api/local-files-api.ts";
import { ChatComposerMessage } from "../features/chat/components/chat-reference.tsx";
import {
	hasChatComposerContent,
	parseChatComposerMessage,
	serializeChatComposerReference,
	visibleChatComposerText,
} from "../features/chat/model/chat-composer.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Chat composer references", () => {
	it("round trips file and folder tags while preserving surrounding text", () => {
		const message = "把 <file name=\"app&amp;api.jar\" path=\"uploads/app&amp;api.jar\" type=\"application/java-archive\" /> 上传，并检查 <folder name=\"config\" path=\"config\" />";
		const parts = parseChatComposerMessage(message);
		expect(parts).toEqual([
			{ type: "text", text: "把 " },
			{ type: "reference", reference: { type: "file", name: "app&api.jar", path: "uploads/app&api.jar", mimeType: "application/java-archive" } },
			{ type: "text", text: " 上传，并检查 " },
			{ type: "reference", reference: { type: "folder", name: "config", path: "config" } },
		]);
		expect(parts.filter((part) => part.type === "reference").map((part) => serializeChatComposerReference(part.reference))).toEqual([
			'<file name="app&amp;api.jar" path="uploads/app&amp;api.jar" type="application/java-archive" />',
			'<folder name="config" path="config" />',
		]);
		expect(visibleChatComposerText(message)).toBe("把 app&api.jar 上传，并检查 config");
		expect(hasChatComposerContent('<file name="app.jar" path="uploads/app.jar" type="application/java-archive" />')).toBe(true);
	});

	it("keeps malformed tags as inert text", () => {
		const message = '检查 <file name="missing-path" />';
		expect(parseChatComposerMessage(message)).toEqual([{ type: "text", text: message }]);
		expect(renderToStaticMarkup(createElement(ChatComposerMessage, { message }))).toContain("&lt;file");
	});

	it("renders valid references without rendering their raw markup", () => {
		const html = renderToStaticMarkup(createElement(ChatComposerMessage, {
			message: '上传 <file name="app.jar" path="uploads/app.jar" type="application/java-archive" />',
		}));
		expect(html).toContain("app.jar");
		expect(html).toContain("uploads/app.jar");
		expect(html).not.toContain("&lt;file");
	});
});

describe("Local file API", () => {
	it("uses the system root before Session creation and the Session root afterward", async () => {
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(Response.json({ rootPath: "/tmp", currentPath: "/tmp", relativePath: "", entries: [] }))
			.mockResolvedValueOnce(Response.json({ entries: [] }));
		vi.stubGlobal("fetch", fetchMock);
		await localFilesApi.listSystem("/Users/example/app jars");
		await localFilesApi.listSession("session / 1", "/tmp/session root/uploads");
		expect(fetchMock).toHaveBeenNthCalledWith(1,
			"/api/local-files?path=%2FUsers%2Fexample%2Fapp%20jars",
			expect.objectContaining({ method: "GET", cache: "no-store" }),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(2,
			"/api/sessions/session%20%2F%201/local-files?path=%2Ftmp%2Fsession%20root%2Fuploads",
			expect.objectContaining({ method: "GET", cache: "no-store" }),
		);
	});

	it("searches the complete Session work directory through paged directory listings", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/sessions/session-1/local-files") {
				return Response.json({
					rootPath: "/work",
					currentPath: "/work",
					relativePath: "",
					entries: [
						{ name: "node_modules", path: "/work/node_modules", relativePath: "node_modules", type: "directory", size: 0, modifiedAt: 1 },
						{ name: "src", path: "/work/src", relativePath: "src", type: "directory", size: 0, modifiedAt: 1 },
						{ name: "README.md", path: "/work/README.md", relativePath: "README.md", type: "file", size: 1, modifiedAt: 1 },
					],
				});
			}
			if (url === "/api/sessions/session-1/local-files?path=%2Fwork%2Fsrc") {
				return Response.json({
					rootPath: "/work",
					currentPath: "/work/src",
					relativePath: "src",
					entries: [
						{ name: "nested", path: "/work/src/nested", relativePath: "src/nested", type: "directory", size: 0, modifiedAt: 1 },
					],
				});
			}
			if (url === "/api/sessions/session-1/local-files?path=%2Fwork%2Fsrc%2Fnested") {
				return Response.json({
					rootPath: "/work",
					currentPath: "/work/src/nested",
					relativePath: "src/nested",
					entries: [
						{ name: "user-service.ts", path: "/work/src/nested/user-service.ts", relativePath: "src/nested/user-service.ts", type: "file", size: 1, modifiedAt: 1 },
					],
				});
			}
			return new Response(null, { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await localFilesApi.searchSession("session-1", "USER-service");

		expect(result).toEqual({
			entries: [{ name: "user-service.ts", path: "/work/src/nested/user-service.ts", relativePath: "src/nested/user-service.ts", type: "file", size: 1, modifiedAt: 1 }],
			truncated: false,
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
