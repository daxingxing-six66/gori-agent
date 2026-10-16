import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";
import { WorkspaceEditDialog } from "../features/workspace/components/workspace-edit-dialog";
import { RemoteSandboxPanel } from "../features/workspace/components/remote-sandbox-panel";
import { configuredSandboxWritableRoots, validSandboxWritableRoots } from "../features/workspace/model/sandbox-writable-roots";
import { parseRemoteSandboxProbe, type Workspace } from "../features/workspace/model/workspace";
import { SessionSandboxBadge } from "../features/session/components/session-sandbox-badge";
import { SessionDialog } from "../features/session/components/session-dialog";
import { requireTerminalSession } from "../features/terminal/model/terminal";
import { terminalSandboxLabel } from "../features/terminal/components/terminal-sandbox-label";
import { messagesByLocale } from "../features/i18n/messages/messages";

const roots = ["/srv/app", "/var/log/app"];
const workspace: Workspace = { id: "workspace", displayName: "test", environment: "development", host: { hostname: "fixture.invalid", port: 22, hostKey: null },
	activeCredentialId: "credential", defaultCwd: "/local", sandboxWritableRoots: roots,
	connection: { connectTimeoutMs: 10000, keepaliveIntervalMs: 15000, keepaliveMaxCount: 3 }, revision: 1, createdAt: 1, updatedAt: 1 };
const facts = { mode: "workspace_write", backend: "bubblewrap", enforcement: "full", sandboxRoot: roots[0], sandboxRoots: roots, bubblewrapVersion: "0.12.0" } as const;

describe("multiple sandbox directory UI", () => {
	it.each(["zh-CN", "en-US"] as const)("shows all Workspace defaults separately from cwd with a compact edit list in %s", (locale) => {
		const messages = messagesByLocale[locale];
		const render = (node: React.ReactNode) => renderToStaticMarkup(<IntlProvider locale={locale} messages={messages}>{node}</IntlProvider>);
		const edit = render(<WorkspaceEditDialog workspace={workspace} onClose={() => {}} onSubmit={async () => {}} />);
		expect(edit).toContain(messages["sandbox.roots.title"]);
		expect(edit).toContain(messages["sandbox.roots.workspaceHint"]);
		for (const path of roots) expect(edit).toContain(`title="${path}"`);
		expect(edit).not.toContain('type="submit" disabled=""');
		expect(edit).not.toContain('class="sandbox-roots-error"');
		const panel = render(<RemoteSandboxPanel workspace={workspace} />);
		expect(panel).toContain(roots[1]); expect(panel).not.toContain('disabled=""');
		const badge = render(<SessionSandboxBadge enabled />);
		expect(badge).toContain('<span role="status"');
		expect(badge).not.toContain('<button');
		expect(badge).toContain(messages["session.sandbox.on"]);
	});
	it("uses only explicit sandbox roots and never derives permissions from a default directory", () => {
		expect(configuredSandboxWritableRoots({})).toEqual([]);
		expect(configuredSandboxWritableRoots({ sandboxWritableRoots: [] })).toEqual([]);
		expect(validSandboxWritableRoots(["/srv/link/../app", "/var/log/app"])).toBe(true);
	});
	it.each(["zh-CN", "en-US"] as const)("edits Session roots alongside its existing fields in %s", (locale) => {
		const messages = messagesByLocale[locale];
		const session = { id: "session", workspaceId: workspace.id, displayName: "maintenance", workDir: "/local/project", autoAudit: false,
			sandboxEnabled: true, sandboxWritableRoots: ["/srv/session"], terminalContextCursor: 0, revision: 4, createdAt: 1, updatedAt: 1 };
		const edit = renderToStaticMarkup(<IntlProvider locale={locale} messages={messages}><SessionDialog session={session} workspace={workspace} onClose={() => {}} onSubmit={async () => {}} /></IntlProvider>);
		expect(edit).toContain(messages["session.edit"]);
		expect(edit).toContain('value="maintenance"');
		expect(edit).toContain('value="/local/project"');
		expect(edit).toContain('title="/srv/session"');
		expect(edit).not.toContain('title="/var/log/app"');
		expect(edit).toContain(messages["sandbox.roots.useWorkspace"]);
		const heading = edit.match(/<div class="sandbox-roots-heading">([\s\S]*?)<\/div><div class="sandbox-roots-selection"/)?.[1];
		expect(heading).toContain(`aria-label="${messages["sandbox.roots.useWorkspace"]}"`);
		expect(heading).not.toContain(`>${messages["sandbox.roots.useWorkspace"]}<`);
		expect(heading).toContain(messages["session.sandbox.readOnlyOption"]);
		expect(edit).toContain(messages["sandbox.roots.sessionHint"]);
		expect(edit.indexOf(messages["sandbox.roots.title"])).toBeLessThan(edit.indexOf(messages["session.sandbox.readOnlyOption"]));
		expect(edit).toContain('role="tooltip"');
		expect(edit).toContain("group-hover:visible group-focus-within:visible");
		expect(edit).not.toContain('class="sandbox-roots-overlay"');
	});
	it.each(["zh-CN", "en-US"] as const)("masks the directory selection while keeping the read-only selector available in %s", (locale) => {
		const session = { id: "session", workspaceId: workspace.id, displayName: "maintenance", workDir: null, autoAudit: false,
			sandboxEnabled: true, sandboxReadOnly: true, sandboxWritableRoots: ["/srv/session"], terminalContextCursor: 0, revision: 4, createdAt: 1, updatedAt: 1 };
		const edit = renderToStaticMarkup(<IntlProvider locale={locale} messages={messagesByLocale[locale]}><SessionDialog session={session} workspace={workspace} onClose={() => {}} onSubmit={async () => {}} /></IntlProvider>);
		expect(edit).toContain('class="sandbox-roots-selection" aria-disabled="true"');
		expect(edit).toContain('class="sandbox-roots-overlay" aria-hidden="true"');
		expect(edit).toContain('title="/srv/session"');
		expect(edit).not.toContain(messagesByLocale[locale]["sandbox.roots.sessionHint"]);
		const heading = edit.match(/<div class="sandbox-roots-heading">([\s\S]*?)<\/div><div class="sandbox-roots-selection"/)?.[1];
		expect(heading).toContain('disabled=""');
		const selector = edit.match(/<input[^>]*aria-describedby="session-read-only-hint"[^>]*>/)?.[0];
		expect(selector).toContain('checked=""'); expect(selector).not.toContain('disabled=""');
		const selection = edit.slice(edit.indexOf('class="sandbox-roots-selection"')).split('class="sandbox-roots-overlay"')[0] ?? "";
		const buttons = selection.match(/<button[^>]*>/g);
		expect(buttons).toHaveLength(2);
		for (const button of buttons ?? []) expect(button).toContain('disabled=""');
	});
	it("reads both new scope arrays and old one-root capability responses", () => {
		expect(parseRemoteSandboxProbe(facts)).toEqual(facts);
		const { sandboxRoots: _roots, ...legacy } = facts;
		expect(parseRemoteSandboxProbe(legacy)).toEqual(legacy);
		for (const sandboxRoots of [[], ["/srv/app", "/"], ["/var/log/app", "/srv/app"], ["/srv/app", "/srv/app"]]) {
			expect(() => parseRemoteSandboxProbe({ ...facts, sandboxRoots })).toThrow();
		}
	});
	it("projects all Terminal roots and rejects a damaged scope instead of claiming confinement", () => {
		const terminal = { id: "terminal", sessionId: "session", workspaceId: "workspace", status: "active", requestedSandboxMode: "workspace_write", sandbox: facts,
			geometry: { rows: 24, cols: 80 }, eventSequence: 1, ownershipEpoch: 1, closeReason: null, failureCode: null, failureMessage: null, createdAt: 1, updatedAt: 1 };
		const value = requireTerminalSession(terminal);
		expect(value.sandbox).toEqual(facts);
		const intl = createIntl({ locale: "en-US", messages: messagesByLocale["en-US"] });
		expect(terminalSandboxLabel(intl, value.sandbox)).toContain("/srv/app, /var/log/app");
		expect(() => requireTerminalSession({ ...terminal, sandbox: { ...facts, sandboxRoots: ["/srv/app", "/"] } })).toThrow();
	});
});
