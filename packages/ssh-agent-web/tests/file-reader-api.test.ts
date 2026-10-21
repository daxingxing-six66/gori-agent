import { afterEach, describe, expect, it, vi } from "vitest";
import { fileReaderApi } from "../features/file-reader/api/file-reader-api";

afterEach(() => vi.unstubAllGlobals());

describe("file reader API", () => {
	it("reads attachments only through the scoped ID endpoint and forwards cancellation", async () => {
		const response = { path: "notes.md", name: "notes.md", content: "# Notes", size: 7, modifiedAt: 1 };
		const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		const request = new AbortController();
		expect(await fileReaderApi.readAttachment("session/a", "attachment?b", request.signal)).toEqual(response);
		expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/sessions/session%2Fa/attachments/attachment%3Fb/text", expect.objectContaining({
			method: "GET", signal: request.signal, cache: "no-store",
		}));
	});
});
