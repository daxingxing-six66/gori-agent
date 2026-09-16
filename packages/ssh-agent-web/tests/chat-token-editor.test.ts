import { describe, expect, it } from "vitest";
import { clipboardFiles } from "../features/chat/components/chat-token-editor.tsx";

describe("Chat token editor clipboard files", () => {
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
