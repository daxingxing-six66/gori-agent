import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { expect, it } from "vitest";
import { WorkspaceEditDialog } from "../features/workspace/components/workspace-edit-dialog";
import type { Workspace } from "../features/workspace/model/workspace";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";
import { enUSMessages } from "../features/i18n/messages/en-US";

it.each([["zh-CN", zhCNMessages, "选择本地工作目录"], ["en-US", enUSMessages, "Choose local working directory"]] as const)("shows editable name and directory picker in %s", (locale, messages, label) => {
	const workspace: Workspace = {
		id: "workspace-1", displayName: "example", environment: "development",
		host: { hostname: "server.example", port: 22, hostKey: null }, activeCredentialId: "credential-1",
		defaultCwd: "/projects/example", sandboxWritableRoots: ["/srv/app"],
		connection: { connectTimeoutMs: 10000, keepaliveIntervalMs: 15000, keepaliveMaxCount: 3 },
		revision: 1, createdAt: 1, updatedAt: 1,
	};
	const html = renderToStaticMarkup(<IntlProvider locale={locale} messages={messages}><WorkspaceEditDialog workspace={workspace} onClose={() => {}} onSubmit={async () => {}} /></IntlProvider>);
	expect(html).toContain('value="example"');
	expect(html).toContain("server.example:22");
	expect(html).toContain('title="/projects/example"');
	expect(html).toContain(`aria-label="${label}"`);
	expect(html).toContain('type="button"');
	expect(html).toContain('title="/srv/app"');
	expect(html).not.toContain("默认远端工作目录");
	expect(html).not.toContain("Default remote working directory");
	expect(html).not.toContain("Remote sandbox writable root");
});
