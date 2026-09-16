import { afterEach, describe, expect, it, vi } from "vitest";
import { sftpApi } from "../features/sftp/api/sftp-api.ts";
import type { FileTransfer } from "../features/sftp/model/sftp.ts";

afterEach(() => vi.unstubAllGlobals());

const transfer: FileTransfer = {
	id: "transfer / 1",
	workspaceId: "ws / 1",
	direction: "upload",
	remotePath: "/tmp/file.bin",
	fileName: "file.bin",
	totalBytes: 4,
	bytesTransferred: 0,
	overwrite: false,
	status: "pending",
	createdAt: 1,
	updatedAt: 1,
};

describe("SFTP API client", () => {
	it("encodes workspace ids and absolute directory paths", async () => {
		const fetchMock = vi.fn(() => Promise.resolve(Response.json({ workspaceId: "ws / 1", path: "/tmp/a b", entries: [] })));
		vi.stubGlobal("fetch", fetchMock);
		await expect(sftpApi.listDirectory("ws / 1", "/tmp/a b")).resolves.toMatchObject({ path: "/tmp/a b" });
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/workspaces/ws%20%2F%201/sftp/entries?path=%2Ftmp%2Fa%20b",
			expect.objectContaining({ method: "GET", cache: "no-store" }),
		);
	});

	it("aborts the upload XHR when its AbortSignal is cancelled", async () => {
		class FakeXmlHttpRequest {
			static latest: FakeXmlHttpRequest | undefined;
			readonly upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
			status = 0;
			response: unknown = null;
			onerror: (() => void) | null = null;
			onabort: (() => void) | null = null;
			onload: (() => void) | null = null;
			aborted = false;

			constructor() {
				FakeXmlHttpRequest.latest = this;
			}

			open(): void {}
			setRequestHeader(): void {}
			send(): void {}
			abort(): void {
				this.aborted = true;
				this.onabort?.();
			}
		}

		vi.stubGlobal("XMLHttpRequest", FakeXmlHttpRequest as unknown as typeof XMLHttpRequest);
		const controller = new AbortController();
		const request = sftpApi.uploadContent(
			"ws / 1",
			transfer,
			{ size: 4 } as File,
			controller.signal,
			vi.fn(),
		);
		controller.abort();
		await expect(request).rejects.toMatchObject({ code: "transfer_cancelled" });
		expect(FakeXmlHttpRequest.latest?.aborted).toBe(true);
	});
});
