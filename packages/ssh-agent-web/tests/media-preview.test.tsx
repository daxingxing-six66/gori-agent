import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaPreviewPage } from "../features/media-preview/components/media-preview-page";
import { mediaDocument, mediaKind, type MediaFile } from "../features/media-preview/model/media-file";
import { mediaPreviewApi } from "../features/media-preview/api/media-preview-api";
import { toolPreviewFile } from "../features/chat/model/tool-preview-file";
import type { ChatToolExecution, ToolCallContent } from "../features/chat/model/chat";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";

const data = vi.hoisted(() => ({ file: null as MediaFile | null, error: null as unknown }));
vi.mock("../features/media-preview/runtime/use-media-file", () => ({ useMediaFile: () => data }));
beforeEach(() => { data.file = null; data.error = null; });

describe("media preview routing and display", () => {
	it.each([["photo.JPG", "image"], ["/tmp/图像.webp", "image"], ["clip.MP4", "video"], ["C:\\work\\demo.webm", "video"], ["voice.m4a", "audio"], ["song.opus", "audio"], ["report.md", null], ["image.jpg.txt", null], ["/photo.png/no-extension", null]])("routes %s to %s", (path, kind) => expect(mediaKind(path)).toBe(kind));
	it("gives the same local file one stable identity without using a text reader source", () => {
		expect(mediaDocument("./outputs/../video.mp4", "/work")).toEqual(mediaDocument("/work/video.mp4", "/work"));
		expect(mediaDocument("a/video.mp4", "/work").id).not.toBe(mediaDocument("b/video.mp4", "/work").id);
		expect(mediaDocument("video.mp4", "/work").id).toMatch(/^media:/u);
	});
	it("builds controlled streaming URLs instead of blob downloads or filesystem URLs", () => {
		const url = mediaPreviewApi.contentUrl("session /?", "/tmp/video #1.mp4", 2);
		expect(url).toContain("/api/sessions/session%20%2F%3F/media-preview/content?path=%2Ftmp%2Fvideo%20%231.mp4&revision=2");
		expect(url).not.toContain("file://");
	});
	it.each(["image", "audio", "video"] as const)("renders the native %s viewer independently", (kind) => {
		data.file = { path: "/tmp/demo", name: "demo", kind, mimeType: `${kind}/test`, size: 12, modifiedAt: 1 };
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}><MediaPreviewPage sessionId="s" document={mediaDocument("/tmp/demo")} active /></IntlProvider>);
		expect(html).toContain(kind === "image" ? "<img" : `<${kind}`);
		expect(html).toContain("/media-preview/content?path=");
		expect(html).not.toContain("file-reader");
		if (kind !== "image") { expect(html).toContain('controls=""'); expect(html).toContain('preload="metadata"'); expect(html).not.toContain("autoPlay"); }
	});
});

describe("confirmed tool preview paths", () => {
	const result = (name: string, details: unknown, status: ChatToolExecution["status"] = "completed"): ChatToolExecution => ({ toolCallId: "call", toolName: name, status, details });
	const call = (name: string): ToolCallContent => ({ type: "toolCall", id: "call", name, arguments: { path: "a.txt", sourceFilePath: "relative.mp4", targetPath: "/tmp/downloads", remoteFilePath: "/server/video.mp4" } });
	it("uses confirmed upload source and actual download destination, including text files", () => {
		expect(toolPreviewFile(call("sftp_upload"), result("sftp_upload", { status: "completed", sourceFilePath: "/work/video.mp4", remotePath: "/server/video.mp4" }))).toBe("/work/video.mp4");
		expect(toolPreviewFile(call("sftp_download"), result("sftp_download", { status: "completed", localPath: "/tmp/downloads/report.md" }))).toBe("/tmp/downloads/report.md");
	});
	it.each(["waiting", "running", "failed"] as const)("does not offer %s transfers or invent a file from the target directory", (status) => {
		expect(toolPreviewFile(call("sftp_download"), result("sftp_download", { status: "completed", localPath: "/tmp/demo.mp4" }, status))).toBeUndefined();
	});
	it.each([undefined, {}, { status: "uncertain", localPath: "/tmp/demo.mp4" }, { status: "completed" }])("rejects unconfirmed or incomplete transfer details: %j", (details) => {
		expect(toolPreviewFile(call("sftp_download"), result("sftp_download", details))).toBeUndefined();
	});
	it("retains read/write legacy parameters and suppresses tool errors", () => {
		expect(toolPreviewFile({ ...call("read"), arguments: { file_path: "photo.jpg" } }, result("read", {}))).toBe("photo.jpg");
		expect(toolPreviewFile(call("write"), { ...result("write", {}), isError: true })).toBeUndefined();
	});
});
