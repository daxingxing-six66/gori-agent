import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareChatAttachment } from "../features/chat/model/prepare-chat-attachment";
import { attachmentFileKind, maximumAttachmentUploadBytes } from "../features/session/model/attachment-file";

afterEach(() => vi.unstubAllGlobals());

describe("chat attachment preparation", () => {
	it("accepts common text documents and extensionless project files regardless of browser MIME", async () => {
		for (const name of ["notes.md", "notes.mdown", "config.JSON", "code.tsx", "server.log", "Dockerfile", "Makefile", ".env", ".env.local", "Dockerfile-1", "Makefile-2", ".env-1", ".gitignore-1", ".dockerignore-1"]) {
			const file = new File(["你好\n\tread me"], name, { type: "application/octet-stream" });
			expect(attachmentFileKind(name, file.type)).toBe("document");
			expect(await prepareChatAttachment(file)).toEqual({ kind: "document", file });
		}
	});

	it("rejects unsupported binary document extensions even when labeled text/plain", async () => {
		for (const name of ["document.pdf", "report.docx", "sheet.xlsx", "video.mp4", "txt"]) {
			expect(attachmentFileKind(name, "text/plain")).toBeNull();
			await expect(prepareChatAttachment(new File(["text"], name, { type: "text/plain" }))).rejects.toMatchObject({ reason: "unsupported" });
		}
	});

	it("keeps automatically renamed environment documents visible without matching unrelated names", async () => {
		for (const name of [".env-1.local", ".env-2.production", ".env-10.local-1"]) {
			const file = new File(["KEY=value"], name, { type: "application/octet-stream" });
			expect(attachmentFileKind(name, file.type)).toBe("document");
			expect(await prepareChatAttachment(file)).toEqual({ kind: "document", file });
		}
		for (const name of [".environment", ".env-other.local", "env-1.local"]) {
			expect(attachmentFileKind(name, "application/octet-stream")).toBeNull();
		}
	});

	it("rejects invalid UTF-8 and binary controls instead of silently replacing them", async () => {
		for (const bytes of [new Uint8Array([0xc3, 0x28]), new Uint8Array([65, 0, 66]), new Uint8Array([65, 0x1b, 66])]) {
			await expect(prepareChatAttachment(new File([bytes], "notes.txt"))).rejects.toMatchObject({ reason: "invalidText" });
		}
	});

	it("checks document size before reading the file", async () => {
		const file = new File(["text"], "large.txt");
		Object.defineProperty(file, "size", { value: maximumAttachmentUploadBytes + 1 });
		const read = vi.spyOn(file, "arrayBuffer");
		await expect(prepareChatAttachment(file)).rejects.toMatchObject({ reason: "tooLarge" });
		expect(read).not.toHaveBeenCalled();
	});

	it("normalizes a small GIF to PNG even without resizing", async () => {
		const close = vi.fn();
		vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 32, height: 24, close }));
		const drawImage = vi.fn();
		const canvas = {
			width: 0, height: 0, getContext: () => ({ drawImage }),
			toBlob: (callback: BlobCallback, type: string) => callback(new Blob(["png"], { type })),
		};
		vi.stubGlobal("document", { createElement: () => canvas });
		const result = await prepareChatAttachment(new File(["gif"], "sample.gif", { type: "image/gif" }));
		expect(result.file.name).toBe("sample.png");
		expect(result.file.type).toBe("image/png");
		expect(result.dimensions).toEqual({ width: 32, height: 24 });
		expect(drawImage).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it("preserves small JPEG bytes and resizes large images within 2048px", async () => {
		const close = vi.fn();
		const decode = vi.fn().mockResolvedValueOnce({ width: 32, height: 24, close }).mockResolvedValueOnce({ width: 4096, height: 2048, close });
		vi.stubGlobal("createImageBitmap", decode);
		const drawImage = vi.fn();
		vi.stubGlobal("document", { createElement: () => ({
			width: 0, height: 0, getContext: () => ({ drawImage }),
			toBlob: (callback: BlobCallback, type: string) => callback(new Blob(["jpg"], { type })),
		}) });
		const file = new File(["jpg"], "sample.jpg", { type: "image/jpeg" });
		expect((await prepareChatAttachment(file)).file).toBe(file);
		const result = await prepareChatAttachment(file);
		expect(result.dimensions).toEqual({ width: 2048, height: 1024 });
		expect(result.file.name).toBe("sample.jpg");
		expect(drawImage).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledTimes(2);
	});

	it("reports browser decoder failures and honors cancellation before upload", async () => {
		vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("Unsupported codec")));
		await expect(prepareChatAttachment(new File(["heic"], "sample.heic", { type: "image/heic" }))).rejects.toMatchObject({ reason: "imageProcessing" });
		const controller = new AbortController();
		controller.abort();
		await expect(prepareChatAttachment(new File(["hi"], "notes.md"), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
	});
});
