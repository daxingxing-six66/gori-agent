import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentRepository } from "../src/application/repositories/attachment-repository.ts";
import type { SessionRepository } from "../src/application/repositories/session-repository.ts";
import { AttachmentService, MAX_ATTACHMENT_BYTES } from "../src/application/services/attachment-service.ts";
import { SessionLifecycleCoordinator } from "../src/application/services/session-lifecycle-coordinator.ts";
import type { Attachment } from "../src/domain/attachment.ts";
import type { IdGenerator, SessionId, WorkspaceId } from "../src/domain/ids.ts";
import type { AdvanceTerminalContextCursorInput, Session } from "../src/domain/session.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AttachmentService", () => {
	it("streams a file into Session storage and lists its metadata", async () => {
		const fixture = await createFixture();
		const attachment = await fixture.service.upload({
			sessionId: "session-1",
			name: "报告.txt",
			mimeType: "Text/Plain; charset=UTF-8",
			expectedSize: 5,
			content: chunks(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])),
		});

		expect(attachment).toEqual({
			id: "attachment-1",
			sessionId: "session-1",
			name: "报告.txt",
			mimeType: "text/plain",
			size: 5,
			storagePath: "attachments/sessions/session-1/报告.txt",
			createdAt: 1_000,
		});
		expect(await readFile(join(fixture.baseDir, attachment.storagePath))).toEqual(Buffer.from([1, 2, 3, 4, 5]));
		expect((await lstat(join(fixture.baseDir, attachment.storagePath))).mode & 0o777).toBe(0o600);
		expect(await fixture.service.list("session-1")).toEqual([attachment]);
	});

	it.each(["", "   ", ".", "..", "../secret", "nested/file", "nested\\file", "bad\u0000name"])(
		"rejects unsafe file name %j",
		async (name) => {
			const fixture = await createFixture();
			await expect(
				fixture.service.upload({ sessionId: "session-1", name, content: chunks(new Uint8Array([1])) }),
			).rejects.toMatchObject({ code: "attachment_name_invalid", status: 400 });
		},
	);

	it("rejects file names longer than 255 UTF-8 bytes", async () => {
		const fixture = await createFixture();
		await expect(
			fixture.service.upload({
				sessionId: "session-1",
				name: "文".repeat(86),
				content: chunks(),
			}),
		).rejects.toMatchObject({ code: "attachment_name_invalid", status: 400 });
	});

	it("rejects invalid MIME types and defaults a missing type", async () => {
		const fixture = await createFixture();
		await expect(
			fixture.service.upload({
				sessionId: "session-1",
				name: "invalid.bin",
				mimeType: "not-a-media-type",
				content: chunks(),
			}),
		).rejects.toMatchObject({ code: "attachment_mime_type_invalid" });
		const attachment = await fixture.service.upload({
			sessionId: "session-1",
			name: "empty.bin",
			content: chunks(),
		});
		expect(attachment).toMatchObject({ mimeType: "application/octet-stream", size: 0 });
	});

	it("stops above 20 MiB and removes partial files", async () => {
		const fixture = await createFixture();
		await expect(
			fixture.service.upload({
				sessionId: "session-1",
				name: "large.bin",
				content: chunks(new Uint8Array(MAX_ATTACHMENT_BYTES), new Uint8Array([1])),
			}),
		).rejects.toMatchObject({ code: "attachment_too_large", status: 413 });
		const sessionDirectory = join(fixture.baseDir, "attachments", "sessions", "session-1");
		expect(await readdir(sessionDirectory)).toEqual([]);
		expect(fixture.attachments.items).toEqual([]);
	});

	it("accepts a file exactly at the 20 MiB boundary", async () => {
		const fixture = await createFixture();
		const attachment = await fixture.service.upload({
			sessionId: "session-1",
			name: "boundary.bin",
			expectedSize: MAX_ATTACHMENT_BYTES,
			content: chunks(new Uint8Array(MAX_ATTACHMENT_BYTES)),
		});
		expect(attachment.size).toBe(MAX_ATTACHMENT_BYTES);
	});

	it("validates Content-Length and removes partial files", async () => {
		const fixture = await createFixture();
		await expect(
			fixture.service.upload({
				sessionId: "session-1",
				name: "short.bin",
				expectedSize: 2,
				content: chunks(new Uint8Array([1])),
			}),
		).rejects.toMatchObject({ code: "attachment_size_mismatch" });
		expect(await fixture.service.list("session-1")).toEqual([]);
	});

	it("adds an incrementing suffix before the extension for duplicate names", async () => {
		const fixture = await createFixture();
		const uploaded = [];
		for (const value of [1, 2, 3]) {
			uploaded.push(
				await fixture.service.upload({
					sessionId: "session-1",
					name: "image.png",
					content: chunks(new Uint8Array([value])),
				}),
			);
		}
		expect(uploaded.map((attachment) => attachment.name)).toEqual(["image.png", "image-1.png", "image-2.png"]);
		expect(uploaded.map((attachment) => attachment.storagePath)).toEqual([
			"attachments/sessions/session-1/image.png",
			"attachments/sessions/session-1/image-1.png",
			"attachments/sessions/session-1/image-2.png",
		]);
	});

	it("reserves UTF-8 file-name space for an automatic suffix", async () => {
		const fixture = await createFixture();
		const name = `${"a".repeat(251)}.png`;
		await fixture.service.upload({ sessionId: "session-1", name, content: chunks() });
		const duplicate = await fixture.service.upload({ sessionId: "session-1", name, content: chunks() });
		expect(duplicate.name).toBe(`${"a".repeat(249)}-1.png`);
		expect(Buffer.byteLength(duplicate.name, "utf8")).toBe(255);
	});

	it("assigns distinct names to concurrent uploads with the same requested name", async () => {
		const fixture = await createFixture();
		const results = await Promise.allSettled([
			fixture.service.upload({
				sessionId: "session-1",
				name: "same.bin",
				content: chunks(new Uint8Array([1])),
			}),
			fixture.service.upload({
				sessionId: "session-1",
				name: "same.bin",
				content: chunks(new Uint8Array([2])),
			}),
		]);
		expect(results.every((result) => result.status === "fulfilled")).toBe(true);
		expect(fixture.attachments.items.map((attachment) => attachment.name).sort()).toEqual(["same-1.bin", "same.bin"]);
	});

	it("removes the published file when persistence fails", async () => {
		const fixture = await createFixture();
		fixture.attachments.failInsert = true;
		await expect(
			fixture.service.upload({
				sessionId: "session-1",
				name: "failed.bin",
				content: chunks(new Uint8Array([1])),
			}),
		).rejects.toMatchObject({ code: "attachment_storage_unavailable" });
		expect(await readdir(join(fixture.baseDir, "attachments", "sessions", "session-1"))).toEqual([]);
	});

	it("rejects a symbolic-link storage directory", async () => {
		const fixture = await createFixture();
		const outside = join(fixture.baseDir, "outside");
		await mkdir(outside);
		await mkdir(join(fixture.baseDir, "attachments"));
		await symlink(outside, join(fixture.baseDir, "attachments", "sessions"));
		await expect(
			fixture.service.upload({ sessionId: "session-1", name: "file.bin", content: chunks() }),
		).rejects.toMatchObject({ code: "attachment_storage_unavailable" });
	});

	it("rejects an upload after cancellation without leaving files", async () => {
		const fixture = await createFixture();
		const abort = new AbortController();
		abort.abort();
		await expect(
			fixture.service.upload({
				sessionId: "session-1",
				name: "cancelled.bin",
				content: chunks(new Uint8Array([1])),
				signal: abort.signal,
			}),
		).rejects.toMatchObject({ code: "attachment_upload_cancelled" });
	});
});

async function createFixture() {
	const baseDir = await mkdtemp(join(tmpdir(), "attachment-service-"));
	directories.push(baseDir);
	const attachments = new MemoryAttachmentRepository();
	const service = new AttachmentService({
		attachments,
		sessions: memorySessions(),
		clock: { now: () => 1_000 },
		ids: new SequentialIds(),
		lifecycle: new SessionLifecycleCoordinator(),
		attachmentBaseDir: baseDir,
	});
	return { baseDir, attachments, service };
}

class MemoryAttachmentRepository implements AttachmentRepository {
	readonly items: Attachment[] = [];
	failInsert = false;

	async insert(attachment: Attachment): Promise<void> {
		if (this.failInsert) throw new Error("insert failed");
		this.items.push(attachment);
	}

	async findBySessionIdAndName(sessionId: SessionId, name: string): Promise<Attachment | undefined> {
		return this.items.find((attachment) => attachment.sessionId === sessionId && attachment.name === name);
	}

	async findBySessionIdAndIds(sessionId: SessionId, ids: readonly string[]): Promise<Attachment[]> {
		return this.items.filter((attachment) => attachment.sessionId === sessionId && ids.includes(attachment.id));
	}

	async listBySessionId(sessionId: SessionId): Promise<Attachment[]> {
		return this.items.filter((attachment) => attachment.sessionId === sessionId).reverse();
	}
}

class SequentialIds implements IdGenerator {
	#next = 1;

	next(): string {
		return `attachment-${this.#next++}`;
	}
}

function memorySessions(): SessionRepository {
	const session: Session = {
		id: "session-1",
		workspaceId: "workspace-1",
		displayName: "Session",
		workDir: null,
		autoAudit: false,
		terminalContextCursor: 0,
		revision: 1,
		createdAt: 1_000,
		updatedAt: 1_000,
	};
	return {
		findById: async (id) => (id === session.id ? session : undefined),
		listByWorkspaceId: async (workspaceId: WorkspaceId) => (workspaceId === session.workspaceId ? [session] : []),
		listAll: async () => [session],
		insert: async () => undefined,
		update: async () => false,
		delete: async () => false,
		countByWorkspaceId: async () => 1,
		advanceTerminalContextCursor: async (_input: AdvanceTerminalContextCursorInput) => false,
	};
}

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
	for (const value of values) yield value;
}
