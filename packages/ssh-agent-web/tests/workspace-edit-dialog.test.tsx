import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { expect, it } from "vitest";
import { WorkspaceEditDialog } from "../features/workspace/components/workspace-edit-dialog";
import type { Workspace } from "../features/workspace/model/workspace";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";
import { enUSMessages } from "../features/i18n/messages/en-US";

it.each([["zh-CN", zhCNMessages, "选择本地工作目录"], ["en-US", enUSMessages, "Choose local working directory"]] as const)("shows editable name and directory picker in %s", (locale, messages, label) => {
	const workspace = { displayName: "example", defaultCwd: "/projects/example", remoteDefaultCwd: "/srv/app" } as Workspace;
	const html = renderToStaticMarkup(<IntlProvider locale={locale} messages={messages}><WorkspaceEditDialog workspace={workspace} onClose={() => {}} onSubmit={async () => {}} /></IntlProvider>);
	expect(html).toContain('value="example"');
	expect(html).toContain('title="/projects/example"');
	expect(html).toContain(`aria-label="${label}"`);
	expect(html).toContain('type="button"');
	expect(html).toContain('value="/srv/app"');
	expect(html).toContain(messages["workspace.field.remoteDefaultCwd"]);
});
