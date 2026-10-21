import { describe, expect, it } from "vitest";
import { clipboardFiles, clipboardTextToInsert } from "../features/chat/components/chat-token-editor.tsx";

describe("Chat token editor clipboard files", () => {
	it("keeps pasted text documents as files rather than inserting their contents", () => {
		const document = new File(["# Notes"], "notes.md", { type: "text/markdown" });
		expect(clipboardFiles({ files: [document] as unknown as FileList, items: [] as unknown as DataTransferItemList })).toEqual([document]);
		expect(clipboardTextToInsert({ getData: () => "# Notes" }, [document])).toBe("");
	});

	it("omits document contents for mixed file pastes, while retaining plain text and image-associated text", () => {
		const image = new File(["png"], "image.png", { type: "image/png" });
		const document = new File(["private text"], "notes.txt", { type: "text/plain" });
		const clipboard = { getData: () => "pasted text" };
		expect(clipboardTextToInsert(clipboard, [image, document])).toBe("");
		expect(clipboardTextToInsert(clipboard, [image])).toBe("pasted text");
		expect(clipboardTextToInsert(clipboard, [])).toBe("pasted text");
	});

	it("falls back to ClipboardItem files when ClipboardData.files is empty", () => {
		const image = new File(["png"], "pasted-image.png", { type: "image/png" });
		const clipboardData = {
			files: [] as unknown as FileList,
			items: [{ kind: "file", getAsFile: () => image }] as unknown as DataTransferItemList,
		};

		expect(clipboardFiles(clipboardData)).toEqual([image]);
	});

	it("keeps the native file list when the browser exposes it", () => {
		const nativeFile = new File(["png"], "native-file.png", { type: "image/png" });
		const fallbackFile = new File(["png"], "fallback-file.png", { type: "image/png" });
		const clipboardData = {
			files: [nativeFile] as unknown as FileList,
			items: [{ kind: "file", getAsFile: () => fallbackFile }] as unknown as DataTransferItemList,
		};

		expect(clipboardFiles(clipboardData)).toEqual([nativeFile]);
	});
});
