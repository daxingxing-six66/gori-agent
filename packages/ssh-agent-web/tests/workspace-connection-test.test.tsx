import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { ManagementDialog } from "../components/management-dialog";
import { WorkspaceDialog } from "../features/workspace/components/workspace-dialog";
import { workspaceApi } from "../features/workspace/api/workspace-api";
import { ConnectionTestController, canTestConnection } from "../features/workspace/runtime/connection-test-controller";
import type { TestWorkspaceConnectionInput, TestWorkspaceConnectionResult } from "../features/workspace/model/workspace";
import { enUSMessages } from "../features/i18n/messages/en-US";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";

const draft: TestWorkspaceConnectionInput = {
	host: { hostname: "localhost", port: 22 },
	credential: { displayName: "SSH", remoteUser: "test", type: "password", password: "secret" },
};
function deferred() {
	let resolve!: (value: TestWorkspaceConnectionResult) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<TestWorkspaceConnectionResult>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

describe("workspace connection test", () => {
	it("requires connection fields only, including valid numbers and a draft secret", () => {
		expect(canTestConnection(draft)).toBe(true);
		expect(canTestConnection({ ...draft, credential: { displayName: "key", remoteUser: "user", type: "private_key", privateKey: "key" } })).toBe(true);
		for (const invalid of [null, { ...draft, host: { hostname: "", port: 22 } }, { ...draft, host: { hostname: "host", port: NaN } }, { ...draft, connection: { connectTimeoutMs: 0 } }, { ...draft, connection: { keepaliveIntervalMs: NaN } }, { ...draft, connection: { keepaliveMaxCount: -1 } }, { ...draft, credential: { ...draft.credential, type: "password" as const, password: "" } }]) expect(canTestConnection(invalid)).toBe(false);
	});
	it("blocks duplicate requests and preserves credentials after success", async () => {
		const pending = deferred();
		const test = vi.fn(() => pending.promise);
		const controller = new ConnectionTestController(test);
		const before = JSON.stringify(draft);
		const run = controller.run(draft);
		expect(controller.getSnapshot().status).toBe("testing");
		await controller.run(draft);
		expect(test).toHaveBeenCalledOnce();
		pending.resolve({ success: true }); await run;
		expect(controller.getSnapshot().status).toBe("success");
		expect(JSON.stringify(draft)).toBe(before);
		controller.reset(); expect(controller.getSnapshot().status).toBe("idle");
	});
	it.each(["resolve", "reject"] as const)("cancels old work and ignores its late %s after a new request", async (action) => {
		const old = deferred(); const next = deferred();
		const test = vi.fn<(input: TestWorkspaceConnectionInput, signal: AbortSignal) => Promise<TestWorkspaceConnectionResult>>()
			.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
		const controller = new ConnectionTestController(test);
		const first = controller.run(draft);
		controller.reset();
		expect(test.mock.calls[0]![1].aborted).toBe(true);
		const second = controller.run({ ...draft, host: { hostname: "other", port: 22 } });
		if (action === "resolve") old.resolve({ success: true }); else old.reject(new Error("old"));
		await first; expect(controller.getSnapshot().status).toBe("testing");
		next.resolve({ success: true }); await second;
		expect(controller.getSnapshot().status).toBe("success");
	});
	it("shows failure, allows retry, and never clears the draft secret", async () => {
		const error = new Error("Authentication failed");
		const test = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ success: true });
		const controller = new ConnectionTestController(test);
		await controller.run(draft); expect(controller.getSnapshot()).toEqual({ status: "error", error });
		await controller.run(draft); expect(controller.getSnapshot().status).toBe("success");
		expect(draft.credential).toHaveProperty("password", "secret");
	});
	it("does not notify unsubscribed components or restore results after close", async () => {
		const pending = deferred();
		const controller = new ConnectionTestController(() => pending.promise);
		const listener = vi.fn(); const unsubscribe = controller.subscribe(listener);
		const run = controller.run(draft); unsubscribe(); controller.reset();
		pending.resolve({ success: true }); await run;
		expect(listener).toHaveBeenCalledOnce(); expect(controller.getSnapshot().status).toBe("idle");
	});
	it.each(["zh-CN", "en-US"] as const)("renders the optional test button before cancel/create in %s", (locale) => {
		const html = renderToStaticMarkup(<IntlProvider locale={locale} messages={locale === "zh-CN" ? zhCNMessages : enUSMessages}><WorkspaceDialog onClose={() => {}} onCreated={() => {}} /></IntlProvider>);
		const footer = html.slice(html.indexOf("<footer"));
		const label = locale === "zh-CN" ? "测试连接" : "Test connection";
		expect(footer).toContain(label);
		expect(footer.indexOf(label)).toBeLessThan(footer.indexOf(locale === "zh-CN" ? "取消" : "Cancel"));
		expect(footer).toMatch(/type="button"[^>]*disabled=""[^>]*aria-describedby="connection-test-requirements"/);
		expect(footer).toContain('class="mr-auto"');
	});
	it("keeps other dialogs unchanged and does not require a connection test for submission", () => {
		const html = renderToStaticMarkup(<IntlProvider locale="en-US" messages={enUSMessages}><ManagementDialog title="Other" onClose={() => {}} onSubmit={() => {}} submitLabel="Save" submitting={false}><p>Fields</p></ManagementDialog></IntlProvider>);
		expect(html).not.toContain("Test connection");
		expect(html).not.toMatch(/<button type="submit"[^>]* disabled=""/);
	});
	it("sends the unsaved connection draft and AbortSignal to the dedicated API", async () => {
		const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true }));
		vi.stubGlobal("fetch", fetchMock);
		const abort = new AbortController();
		try {
			await expect(workspaceApi.testConnection(draft, abort.signal)).resolves.toEqual({ success: true });
			expect(fetchMock.mock.calls[0]![0]).toContain("/api/workspaces/test-connection");
			expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST", signal: abort.signal, body: JSON.stringify(draft), cache: "no-store" });
		} finally { vi.unstubAllGlobals(); }
	});
});
