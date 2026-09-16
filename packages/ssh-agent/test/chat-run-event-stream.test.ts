import { describe, expect, it, vi } from "vitest";
import { ChatRunEventHub } from "../src/application/chat-run-event-hub.ts";
import { ChatRunEventStream } from "../src/application/chat-run-event-stream.ts";

const decode = (value: Uint8Array | undefined): string => new TextDecoder().decode(value);

describe("ChatRunEventStream", () => {
	it("reports unencodable events and tells clients to resync without failing the publisher", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const events = new ChatRunEventStream("run-1");
		const reader = events.subscribe().getReader();
		try {
			await reader.read();
			expect(() => events.publish("run.updated", { invalid: 1n })).not.toThrow();
			expect(decode((await reader.read()).value)).toContain("event: stream.resync");
			expect(log).toHaveBeenCalledWith(
				"SSH Agent failure",
				expect.objectContaining({ stage: "delivery", runId: "run-1" }),
			);
			events.publish("run.updated", { status: "completed" });
			expect(decode((await reader.read()).value)).toContain('"status":"completed"');
		} finally {
			events.close();
			log.mockRestore();
		}
	});
	it("replays only events newer than Last-Event-ID and continues with live events", async () => {
		const events = new ChatRunEventStream("run-1");
		events.publish("message_update", { delta: "old" });
		events.publish("message_update", { delta: "replayed" });

		const reader = events.subscribe(1).getReader();
		const ready = await reader.read();
		expect(decode(ready.value)).toContain("event: stream.ready");
		expect(decode(ready.value)).toContain('"runId":"run-1"');

		const replayed = await reader.read();
		expect(decode(replayed.value)).toBe('id: 2\nevent: message_update\ndata: {"delta":"replayed"}\n\n');

		events.publish("run.updated", { status: "completed" });
		const live = await reader.read();
		expect(decode(live.value)).toBe('id: 3\nevent: run.updated\ndata: {"status":"completed"}\n\n');

		events.close();
		expect((await reader.read()).done).toBe(true);
	});

	it("snapshots structured event data before later domain mutations", async () => {
		const events = new ChatRunEventStream("run-1");
		const run = { status: "running" };
		events.publish("run.updated", run);
		run.status = "completed";

		const reader = events.subscribe().getReader();
		await reader.read();
		expect(decode((await reader.read()).value)).toContain('"status":"running"');
		events.close();
	});
});

describe("ChatRunEventHub", () => {
	it("reuses a Run stream and evicts the oldest stream at the configured limit", async () => {
		const events = new ChatRunEventHub({ maxCachedRunStreams: 2 });
		const oldestReader = events.subscribe("run-1").getReader();
		expect(decode((await oldestReader.read()).value)).toContain('"runId":"run-1"');

		events.publish("run-1", "run.updated", { status: "running" });
		expect(decode((await oldestReader.read()).value)).toContain('"status":"running"');
		events.publish("run-2", "run.updated", { status: "running" });
		events.publish("run-3", "run.updated", { status: "running" });

		expect((await oldestReader.read()).done).toBe(true);
		events.close();
	});

	it("closes every cached Run stream", async () => {
		const events = new ChatRunEventHub();
		const first = events.subscribe("run-1").getReader();
		const second = events.subscribe("run-2").getReader();
		await first.read();
		await second.read();

		events.close();

		expect((await first.read()).done).toBe(true);
		expect((await second.read()).done).toBe(true);
	});
});
