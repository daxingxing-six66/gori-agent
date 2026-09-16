import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentRepository } from "../src/application/repositories/attachment-repository.ts";
import { ChatAttachmentService } from "../src/application/services/chat-attachment-service.ts";
import type { Attachment } from "../src/domain/attachment.ts";
import { createChatUserMessage } from "../src/domain/chat-attachment.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ChatAttachmentService", () => {
	it("hydrates ordered image references without changing the persisted message", async () => {
		const fixture = await createFixture([
			{ id: "png", name: "one.png", bytes: pngBytes(), declaredMimeType: "application/octet-stream" },
			{ id: "jpeg", name: "two.jpg", bytes: jpegBytes(), declaredMimeType: "image/png" },
		]);
		const message = createChatUserMessage("compare", ["jpeg", "png"], 1);

		await expect(
			fixture.service.validateReferences("session-1", ["jpeg", "png"], fixture.imageModel),
		).resolves.toHaveLength(2);
		const hydrated = await fixture.service.hydrateProviderContext(
			"session-1",
			{ systemPrompt: "system", messages: [message], tools: [] },
			fixture.imageModel,
		);

		expect(hydrated.messages[0]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "compare" },
				{ type: "image", data: jpegBytes().toString("base64"), mimeType: "image/jpeg" },
				{ type: "image", data: pngBytes().toString("base64"), mimeType: "image/png" },
			],
			timestamp: 1,
		});
		expect(message).toEqual({ role: "user", content: "compare", attachmentIds: ["jpeg", "png"], timestamp: 1 });
	});

	it("accepts image-only messages and recognizes WebP from file content", async () => {
		const fixture = await createFixture([{ id: "webp", name: "image.webp", bytes: webpBytes() }]);
		const hydrated = await fixture.service.hydrateProviderContext(
			"session-1",
			{ systemPrompt: "", messages: [createChatUserMessage("", ["webp"], 1)], tools: [] },
			fixture.imageModel,
		);
		expect(hydrated.messages[0]?.content).toEqual([
			{ type: "image", data: webpBytes().toString("base64"), mimeType: "image/webp" },
		]);
	});

	it("rejects unsupported models, invalid IDs, wrong Sessions, and excessive images", async () => {
		const fixture = await createFixture([{ id: "png", name: "one.png", bytes: pngBytes() }]);
		await expect(fixture.service.validateReferences("session-1", ["png"], fixture.textModel)).rejects.toMatchObject({
			code: "chat_model_image_input_unsupported",
		});
		await expect(
			fixture.service.validateReferences("session-1", ["png", "png"], fixture.imageModel),
		).rejects.toMatchObject({
			code: "chat_attachment_ids_invalid",
		});
		await expect(fixture.service.validateReferences("session-2", ["png"], fixture.imageModel)).rejects.toMatchObject({
			code: "chat_attachment_not_found",
		});
		await expect(
			fixture.service.validateReferences("session-1", ["1", "2", "3", "4", "5"], fixture.imageModel),
		).rejects.toMatchObject({ code: "chat_attachment_limit_exceeded" });
	});

	it("rejects unsupported content, changed files, and symbolic links", async () => {
		const fixture = await createFixture([
			{ id: "invalid", name: "invalid.gif", bytes: Buffer.from("GIF89a") },
			{ id: "unsupported", name: "unsupported.gif", bytes: Buffer.from("GIF89a123456") },
			{ id: "changed", name: "changed.png", bytes: pngBytes() },
			{ id: "link", name: "link.png", bytes: pngBytes() },
		]);
		await expect(
			fixture.service.validateReferences("session-1", ["invalid"], fixture.imageModel),
		).rejects.toMatchObject({
			code: "chat_attachment_content_invalid",
		});
		await expect(
			fixture.service.validateReferences("session-1", ["unsupported"], fixture.imageModel),
		).rejects.toMatchObject({ code: "chat_attachment_image_format_unsupported" });

		await writeFile(join(fixture.sessionDirectory, "changed.png"), Buffer.concat([pngBytes(), Buffer.from([0])]));
		await expect(
			fixture.service.validateReferences("session-1", ["changed"], fixture.imageModel),
		).rejects.toMatchObject({
			code: "chat_attachment_changed",
		});

		await rm(join(fixture.sessionDirectory, "link.png"));
		await symlink(join(fixture.sessionDirectory, "one-missing.png"), join(fixture.sessionDirectory, "link.png"));
		await expect(fixture.service.validateReferences("session-1", ["link"], fixture.imageModel)).rejects.toMatchObject(
			{
				code: "chat_attachment_storage_unavailable",
			},
		);
	});

	it("projects image cost and file markers for compaction, then restores references", async () => {
		const fixture = await createFixture([{ id: "png", name: "screen.png", bytes: pngBytes() }]);
		const message = createChatUserMessage("inspect", ["png"], 1);
		const projected = fixture.service.compactionProjection(message, fixture.attachments);
		expect(projected).toMatchObject({
			role: "user",
			attachmentIds: ["png"],
			content: [
				{ type: "text", text: "inspect" },
				{ type: "text", text: "[Image attachment: screen.png]" },
				{ type: "image", data: "", mimeType: "image/png" },
			],
		});
		expect(fixture.service.restoreCompactionMessage(projected)).toEqual(message);
	});

	it("stops file preparation when the Agent signal is aborted", async () => {
		const fixture = await createFixture([{ id: "png", name: "one.png", bytes: pngBytes() }]);
		const controller = new AbortController();
		controller.abort();
		await expect(
			fixture.service.validateReferences("session-1", ["png"], fixture.imageModel, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});

async function createFixture(files: Array<{ id: string; name: string; bytes: Buffer; declaredMimeType?: string }>) {
	const directory = await mkdtemp(join(tmpdir(), "ssh-agent-chat-attachment-"));
	directories.push(directory);
	const sessionDirectory = join(directory, "attachments", "sessions", "session-1");
	await mkdir(sessionDirectory, { recursive: true });
	const attachments: Attachment[] = [];
	for (const file of files) {
		await writeFile(join(sessionDirectory, file.name), file.bytes, { mode: 0o600 });
		attachments.push({
			id: file.id,
			sessionId: "session-1",
			name: file.name,
			mimeType: file.declaredMimeType ?? "image/png",
			size: file.bytes.length,
			storagePath: `attachments/sessions/session-1/${file.name}`,
			createdAt: 1,
		});
	}
	const repository = {
		insert: vi.fn(async () => undefined),
		findBySessionIdAndName: vi.fn(async () => undefined),
		findBySessionIdAndIds: vi.fn(async (sessionId: string, ids: readonly string[]) =>
			attachments.filter((attachment) => attachment.sessionId === sessionId && ids.includes(attachment.id)),
		),
		listBySessionId: vi.fn(async () => attachments),
	} satisfies AttachmentRepository;
	const models = fauxProvider({
		provider: "chat-attachment-test",
		models: [
			{ id: "image", input: ["text", "image"] },
			{ id: "text", input: ["text"] },
		],
	});
	const imageModel = models.getModel("image");
	const textModel = models.getModel("text");
	if (!imageModel || !textModel) throw new Error("Faux Chat Attachment models were not created");
	return {
		attachments,
		sessionDirectory,
		service: new ChatAttachmentService({ attachments: repository, attachmentBaseDir: directory }),
		imageModel,
		textModel,
	};
}

function pngBytes(): Buffer {
	return Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		"base64",
	);
}

function jpegBytes(): Buffer {
	return Buffer.from([
		0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
	]);
}

function webpBytes(): Buffer {
	const bytes = Buffer.alloc(30);
	bytes.write("RIFF", 0, "ascii");
	bytes.writeUInt32LE(22, 4);
	bytes.write("WEBP", 8, "ascii");
	bytes.write("VP8X", 12, "ascii");
	bytes.writeUInt32LE(10, 16);
	return bytes;
}
