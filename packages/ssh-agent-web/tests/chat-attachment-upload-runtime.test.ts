import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookDriver, deferred } from "./helpers/hook-driver";
import type { SessionAttachment } from "../features/session/api/session-attachment-api";
import type { PreparedChatAttachment } from "../features/chat/model/prepare-chat-attachment";

let driver: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof React>(),
	useState: (initial: unknown) => driver.state(initial), useRef: (initial: unknown) => driver.ref(initial),
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => driver.effect(effect, deps),
}));
vi.mock("react-intl", () => ({ useIntl: () => ({ formatMessage: ({ id }: { id: string }) => id }) }));
vi.mock("../features/i18n/components/use-localized-error-message", () => ({ useLocalizedErrorMessage: () => (error: unknown) => String(error) }));
vi.mock("../features/session/api/session-attachment-api", () => ({ sessionAttachmentApi: { upload: vi.fn() } }));
vi.mock("../features/chat/model/prepare-chat-attachment", async (original) => ({
	...await original<typeof import("../features/chat/model/prepare-chat-attachment")>(), prepareChatAttachment: vi.fn(),
}));
import { sessionAttachmentApi } from "../features/session/api/session-attachment-api";
import { prepareChatAttachment } from "../features/chat/model/prepare-chat-attachment";
import { useChatAttachmentUploads } from "../features/chat/runtime/use-chat-attachment-uploads";

let sessionId: string;
let value: ReturnType<typeof useChatAttachmentUploads>;
function render() { value = driver.render(() => useChatAttachmentUploads(sessionId)); return value; }
async function settle() { for (let index = 0; index < 10; index++) await Promise.resolve(); render(); }
function metadata(session = sessionId, name = "notes.md"): SessionAttachment {
	return { id: `${session}:${name}`, sessionId: session, name, mimeType: "text/markdown", size: 4, storagePath: name, contentUrl: "/content", createdAt: 1 };
}
const documentFile = () => new File(["text"], "notes.md", { type: "text/markdown" });

beforeEach(() => {
	vi.resetAllMocks();
	driver = new HookDriver(); sessionId = "first";
	vi.stubGlobal("URL", { createObjectURL: vi.fn().mockReturnValue("blob:preview"), revokeObjectURL: vi.fn() });
	vi.mocked(prepareChatAttachment).mockImplementation(async (file) => ({ file, kind: file.type.startsWith("image/") ? "image" : "document" }));
	vi.mocked(sessionAttachmentApi.upload).mockImplementation(async (session, file) => metadata(session, file.name));
	render(); render();
});
afterEach(() => { driver.unmount(); vi.unstubAllGlobals(); });

describe("chat attachment upload lifecycle", () => {
	it("shares document upload state and submits only attachment metadata", async () => {
		value.addFiles([documentFile()]); render(); expect(value.pending).toBe(true);
		await settle();
		expect(value.attachments).toEqual([metadata()]);
		expect(value.uploads[0]).toMatchObject({ kind: "document", status: "uploaded", previewUrl: null });
		expect(JSON.stringify(value.attachments)).not.toContain('"text"');
	});

	it("enforces four slots across consecutive file additions before a render", async () => {
		value.addFiles([documentFile(), documentFile(), documentFile()]);
		value.addFiles([documentFile(), documentFile()]);
		await settle();
		expect(value.uploads).toHaveLength(4);
		expect(value.limitNotice).toBe(true);
		expect(sessionAttachmentApi.upload).toHaveBeenCalledTimes(4);
	});

	it("aborts previous Session uploads and ignores a late successful response", async () => {
		const pending = deferred<SessionAttachment>();
		vi.mocked(sessionAttachmentApi.upload).mockReturnValueOnce(pending.promise);
		value.addFiles([documentFile()]); await settle();
		const signal = vi.mocked(sessionAttachmentApi.upload).mock.calls[0][2];
		sessionId = "second"; render(); render();
		expect(signal?.aborted).toBe(true);
		pending.resolve(metadata("first")); await settle();
		expect(value.uploads).toEqual([]);
		expect(value.attachments).toEqual([]);
	});

	it("does not recreate a removed pending upload when the request resolves late", async () => {
		const pending = deferred<SessionAttachment>();
		vi.mocked(sessionAttachmentApi.upload).mockReturnValueOnce(pending.promise);
		value.addFiles([documentFile()]); await settle();
		const signal = vi.mocked(sessionAttachmentApi.upload).mock.calls[0][2];
		value.dismiss(value.uploads[0].id); render();
		expect(signal?.aborted).toBe(true);
		pending.resolve(metadata()); await settle();
		expect(value.uploads).toEqual([]);
	});

	it("prevents upload after preparation resolves for a cancelled file", async () => {
		const pending = deferred<PreparedChatAttachment>();
		vi.mocked(prepareChatAttachment).mockReturnValueOnce(pending.promise);
		value.addFiles([documentFile()]); render();
		value.dismiss(value.uploads[0].id);
		pending.resolve({ file: documentFile(), kind: "document" }); await settle();
		expect(sessionAttachmentApi.upload).not.toHaveBeenCalled();
		expect(value.uploads).toEqual([]);
	});

	it("releases local image URLs on removal, Session change, and unmount", async () => {
		const image = () => new File(["png"], "image.png", { type: "image/png" });
		value.addFiles([image()]); await settle(); value.dismiss(value.uploads[0].id); render();
		expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
		value.addFiles([image()]); await settle(); sessionId = "second"; render(); render();
		expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
		value.addFiles([image()]); await settle(); driver.unmount();
		expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
	});

	it("retains a new attachment while clearing only the submitted batch", async () => {
		value.addFiles([documentFile()]); await settle();
		const submittedIds = value.attachments.map((attachment) => attachment.id);
		value.addFiles([new File(["new"], "later.txt")]); await settle();
		value.clearSubmitted(submittedIds); render();
		expect(value.uploads.map((upload) => upload.name)).toEqual(["later.txt"]);
	});
});
