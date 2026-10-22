import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatPageHeader } from "../features/chat/components/chat-page-header";
import { ServerMetricsStrip } from "../features/server-metrics/components/server-metrics-strip";
import { SessionInfoPopover, SessionInfoContent } from "../features/session/components/session-info-popover";
import type { ServerMetricsState } from "../features/server-metrics/model/server-metrics";
import { messagesByLocale } from "../features/i18n/messages/messages";

const live: ServerMetricsState = { status: "live", snapshot: {
	workspaceId: "ws", sampledAt: 1_792_000_000_000, cpu: { usagePercent: 3.4 },
	memory: { usedBytes: 100, totalBytes: 200, usagePercent: 50 },
	network: { interfaceName: "ens3", transmitBytesPerSecond: 120 * 1024, receiveBytesPerSecond: 1.2 * 1024 ** 2 },
} };

function render(state: ServerMetricsState, locale: "zh-CN" | "en-US" = "zh-CN") {
	return renderToStaticMarkup(<IntlProvider locale={locale} messages={messagesByLocale[locale]}>
		<SessionInfoContent sandboxEnabled sandboxReadOnly={false} writableRoots={["/srv/app", "/var/log/app"]}
			directory={{ path: "/Users/me/project", failed: false }} metrics={<ServerMetricsStrip state={state} />} />
	</IntlProvider>);
}

describe("session header server metrics", () => {
	it.each(["zh-CN", "en-US"] as const)("renders resources and Session paths in the detail card in %s", (locale) => {
		const html = render(live, locale);
		for (const value of ["3.4%", "50.0%", "120.0 KiB/s", "1.2 MiB/s"]) expect(html).toContain(value);
		expect(html).not.toContain("ens3"); expect(html).not.toContain("server-metrics-detail-note");
		expect(html).toContain(locale === "zh-CN" ? "服务器发送" : "Server sending");
		expect(html).toContain("100 B / 200 B");
		for (const path of ["/Users/me/project", "/srv/app", "/var/log/app"]) expect(html).toContain(path);
		expect(html).not.toContain(locale === "zh-CN" ? "沙盒已开启" : "Sandbox enabled");
	});

	it.each([
		{ enabled: true, readOnly: false, label: "沙盒已开启" },
		{ enabled: true, readOnly: true, label: "只读沙盒" },
		{ enabled: false, readOnly: false, label: "沙盒已关闭" },
	])("keeps $label before the Run status on the right and the information icon after the title", ({ enabled, readOnly, label }) => {
		const html = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={messagesByLocale["zh-CN"]}>
			<ChatPageHeader title="Session" sandboxEnabled={enabled} sandboxReadOnly={readOnly} active connection="connected" queueCount={0} sessionInfo={<SessionInfoPopover
				sessionId="s" workDir="/project" sandboxEnabled={enabled} sandboxReadOnly={readOnly} writableRoots={["/srv/app"]} metrics={<ServerMetricsStrip state={live} />} />} />
		</IntlProvider>);
		expect(html).toContain('aria-expanded="false"'); expect(html).toContain("服务器与会话信息");
		expect(html.indexOf("</h1>")).toBeLessThan(html.indexOf("session-info-trigger"));
		expect(html.indexOf("session-info-trigger")).toBeLessThan(html.indexOf("page-header-actions"));
		expect(html.indexOf("page-header-actions")).toBeLessThan(html.indexOf(label));
		expect(html.indexOf(label)).toBeLessThan(html.indexOf("正在运行"));
		expect(html).toContain("正在运行"); expect(html).not.toContain("3.4%"); expect(html).not.toContain("/srv/app");
	});

	it("shows the effective read-only scope and avoids presenting configured roots as active when disabled", () => {
		const renderScope = (enabled: boolean, readOnly: boolean) => renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={messagesByLocale["zh-CN"]}>
			<SessionInfoContent sandboxEnabled={enabled} sandboxReadOnly={readOnly} writableRoots={["/srv/app"]} directory={{ failed: true }} metrics={null} />
		</IntlProvider>);
		const readOnly = renderScope(true, true);
		expect(readOnly).toContain("/tmp"); expect(readOnly).toContain("/dev/null"); expect(readOnly).not.toContain("/srv/app");
		const disabled = renderScope(false, false);
		expect(disabled).toContain("当前不限制可写目录"); expect(disabled).not.toContain("/srv/app");
		expect(disabled).toContain("无法读取本地工作目录");
	});

	it("shows placeholders for initial sampling and missing network data instead of fabricated zeros", () => {
		const html = render({ status: "sampling" });
		expect(html).toContain("采样中");
		expect(html).not.toContain("0.0%");
		expect(html).not.toContain("0 B/s");
		const missingNetwork = render({ ...live, snapshot: { ...live.snapshot!, network: undefined } });
		expect(missingNetwork).toContain("3.4%");
		expect(missingNetwork).toContain("—"); expect(missingNetwork).not.toContain("0 B/s");
	});

	it("distinguishes a network baseline from an idle interface and preserves failed data with a warning", () => {
		const pending = render({ ...live, snapshot: { ...live.snapshot!, network: {
			interfaceName: "ens3", receiveBytesPerSecond: null, transmitBytesPerSecond: null,
		} } });
		expect(pending).toContain("—");
		expect(pending).not.toContain("0 B/s");
		const failed = render({ ...live, status: "unavailable", error: "Permission denied" });
		expect(failed).toContain('data-state="unavailable"');
		expect(failed).toContain("Permission denied");
		expect(failed).toContain("3.4%");
	});
});
