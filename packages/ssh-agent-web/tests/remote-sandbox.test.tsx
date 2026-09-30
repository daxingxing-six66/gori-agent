import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { messagesByLocale } from "../features/i18n/messages/messages";
import { workspaceApi } from "../features/workspace/api/workspace-api";
import { RemoteSandboxPanel } from "../features/workspace/components/remote-sandbox-panel";
import { WorkspaceEditDialog } from "../features/workspace/components/workspace-edit-dialog";
import { isRemoteSandboxRoot, type Workspace } from "../features/workspace/model/workspace";

const workspace = { id: "remote /host", displayName: "test", defaultCwd: "/local", remoteDefaultCwd: "/etc", remoteSandboxRoot: "/opt/app" } as Workspace;
describe("remote sandbox configuration", () => {
	it.each(["/", "/opt/..", "/./", "", "relative", "~", "/app\0x", "/app\nx"])("rejects %s as a writable root", (root) => {
		expect(isRemoteSandboxRoot(root)).toBe(false);
	});
	it("accepts a dedicated remote root independently of either cwd", () => {
		expect(isRemoteSandboxRoot("/opt/app")).toBe(true);
		expect(isRemoteSandboxRoot("/opt/../srv/app")).toBe(true);
	});
	it.each(["en-US", "zh-CN"] as const)("shows unverified status before a probe in %s", (locale) => {
		const messages = messagesByLocale[locale];
		const html = renderToStaticMarkup(<IntlProvider locale={locale} messages={messages}><RemoteSandboxPanel workspace={workspace} /></IntlProvider>);
		expect(html).toContain(messages["workspace.sandbox.notProbed"]);
		expect(html).not.toContain(messages["workspace.sandbox.full"]);
		expect(html).toContain("/opt/app");
		expect(html).toContain(messages["workspace.sandbox.scope"]);
	});
	it("requires explicit configuration for legacy workspaces without inferring their cwd", () => {
		const legacy = { ...workspace, remoteSandboxRoot: undefined };
		const messages = messagesByLocale["en-US"];
		const panel = renderToStaticMarkup(<IntlProvider locale="en-US" messages={messages}><RemoteSandboxPanel workspace={legacy} /></IntlProvider>);
		expect(panel).toMatch(/<button[^>]*disabled=""/);
		const edit = renderToStaticMarkup(<IntlProvider locale="en-US" messages={messages}><WorkspaceEditDialog workspace={legacy} onClose={() => {}} onSubmit={async () => {}} /></IntlProvider>);
		expect(edit).toContain(messages["workspace.sandbox.rootInvalid"]);
		expect(edit).toMatch(/<button type="submit"[^>]*disabled=""/);
	});
	it("sends an abortable explicit probe without a command body", async () => {
		const facts = { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 8, sandboxRoot: "/opt/app" };
		const fetch = vi.fn().mockResolvedValue(Response.json(facts));
		vi.stubGlobal("fetch", fetch);
		try {
			const controller = new AbortController();
			expect(await workspaceApi.probeSandbox(workspace.id, controller.signal)).toEqual(facts);
			expect(fetch.mock.calls[0]?.[0]).toContain("/api/workspaces/remote%20%2Fhost/sandbox");
			expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", signal: controller.signal });
			expect(fetch.mock.calls[0]?.[1].body).toBeUndefined();
		} finally { vi.unstubAllGlobals(); }
	});
	it.each([
		null,
		{ mode: "workspace_write", backend: "none", enforcement: "full", abi: 8, sandboxRoot: "/opt/app" },
		{ mode: "workspace_write", backend: "landlock", enforcement: "full", abi: "8", sandboxRoot: "/opt/app" },
		{ mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 4, sandboxRoot: "/opt/app" },
		{ mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 8, sandboxRoot: "/" },
	])("rejects malformed capability responses instead of displaying full enforcement", async (facts) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(facts)));
		try {
			await expect(workspaceApi.probeSandbox(workspace.id)).rejects.toThrow("Invalid remote sandbox probe response");
		} finally { vi.unstubAllGlobals(); }
	});
});
