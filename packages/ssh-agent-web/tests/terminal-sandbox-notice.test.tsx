import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { TerminalSandboxNotice } from "@/features/terminal/components/terminal-sandbox-notice";
import { enUSMessages } from "@/features/i18n/messages/en-US";
import { zhCNMessages } from "@/features/i18n/messages/zh-CN";

describe("Terminal sandbox notice", () => {
	it("shows a non-interactive warning only for automatic unconfined fallback", () => {
		const fallback = { mode: "full_access", backend: "none", enforcement: "none", source: "sandbox_unavailable", detectedAt: 10 } as const;
		const render = (sandbox: Parameters<typeof TerminalSandboxNotice>[0]["sandbox"], english = false) =>
			renderToStaticMarkup(<IntlProvider locale={english ? "en-US" : "zh-CN"} messages={english ? enUSMessages : zhCNMessages}>
				<TerminalSandboxNotice sandbox={sandbox} />
			</IntlProvider>);
		expect(render(fallback)).toContain("文件操作不受沙箱保护");
		expect(render(fallback, true)).toContain("not sandboxed");
		expect(render(fallback)).toContain('role="status"');
		expect(render({ mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 8, launcherVersion: "3", sandboxRoot: "/srv/test" })).toBe("");
	});
});
