import { beforeEach, describe, expect, it, vi } from "vitest";
import { diagnoseApi } from "../features/diagnose/api/diagnose-api";
import { readDiagnoseRecordsJson } from "../features/diagnose/api/read-diagnose-records";
import type { DiagnoseNode } from "../features/diagnose/model/diagnose";

vi.mock("../features/diagnose/api/diagnose-api", () => ({ diagnoseApi: { nodes: vi.fn() } }));
const node = (sequence: number): DiagnoseNode => ({ taskId: "task", sequence, direction: `方向 ${sequence}`, status: "unconfirmed",
	explanation: `日志 "原文"\n下一行 ${sequence}`, revision: 2, createdAt: 1, updatedAt: 2 });
beforeEach(() => vi.resetAllMocks());

describe("copy all diagnosis records as JSON", () => {
	it("includes older pages in order and exports only the three business fields with original text", async () => {
		vi.mocked(diagnoseApi.nodes).mockResolvedValueOnce({ nodes: [node(3), node(4)], nextBeforeSequence: 3 })
			.mockResolvedValueOnce({ nodes: [node(1), node(2)], nextBeforeSequence: null });
		const signal = new AbortController().signal;
		const json = await readDiagnoseRecordsJson("session", "task", signal);
		expect(JSON.parse(json)).toEqual([1, 2, 3, 4].map((sequence) => ({ direction: `方向 ${sequence}`, status: "unconfirmed", explanation: `日志 "原文"\n下一行 ${sequence}` })));
		expect(diagnoseApi.nodes).toHaveBeenNthCalledWith(2, "session", "task", 3, signal);
	});
	it("copies an empty diagnosis as an empty JSON array", async () => {
		vi.mocked(diagnoseApi.nodes).mockResolvedValue({ nodes: [], nextBeforeSequence: null });
		expect(await readDiagnoseRecordsJson("session", "task", new AbortController().signal)).toBe("[]");
	});
	it("does not return a partial export when loading an older page fails", async () => {
		vi.mocked(diagnoseApi.nodes).mockResolvedValueOnce({ nodes: [node(3)], nextBeforeSequence: 3 }).mockRejectedValueOnce(new Error("offline"));
		await expect(readDiagnoseRecordsJson("session", "task", new AbortController().signal)).rejects.toThrow("offline");
	});
	it("rejects missing records instead of copying an incomplete array", async () => {
		vi.mocked(diagnoseApi.nodes).mockResolvedValueOnce({ nodes: [node(3)], nextBeforeSequence: 3 })
			.mockResolvedValueOnce({ nodes: [node(1)], nextBeforeSequence: null });
		await expect(readDiagnoseRecordsJson("session", "task", new AbortController().signal)).rejects.toThrow("Incomplete diagnosis records");
	});
	it("stops after a late response when the task page has been left", async () => {
		const controller = new AbortController();
		vi.mocked(diagnoseApi.nodes).mockImplementationOnce(async () => { controller.abort(); return { nodes: [node(3)], nextBeforeSequence: 3 }; });
		await expect(readDiagnoseRecordsJson("session", "task", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(diagnoseApi.nodes).toHaveBeenCalledOnce();
	});
});
