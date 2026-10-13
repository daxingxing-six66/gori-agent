import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatPageHeader } from "../features/chat/components/chat-page-header";
import { ServerMetricsStrip } from "../features/server-metrics/components/server-metrics-strip";
import type { ServerMetricsState } from "../features/server-metrics/model/server-metrics";
import { messagesByLocale } from "../features/i18n/messages/messages";

const live: ServerMetricsState = { status: "live", snapshot: {
	workspaceId: "ws", sampledAt: 1_792_000_000_000, cpu: { usagePercent: 3.4 },
	memory: { usedBytes: 100, totalBytes: 200, usagePercent: 50 },
	network: { interfaceName: "ens3", transmitBytesPerSecond: 120 * 1024, receiveBytesPerSecond: 1.2 * 1024 ** 2 },
} };

function render(state: ServerMetricsState, locale: "zh-CN" | "en-US" = "zh-CN") {
	return renderToStaticMarkup(<IntlProvider locale={locale} messages={messagesByLocale[locale]}>
		<ChatPageHeader title="Session" sandboxEnabled active={false} connection="closed" queueCount={0}
			serverMetrics={<ServerMetricsStrip state={state} />} />
	</IntlProvider>);
}

describe("session header server metrics", () => {
	it.each(["zh-CN", "en-US"] as const)("renders three compact icon groups before sandbox status in %s", (locale) => {
		const html = render(live, locale);
		for (const value of ["3.4%", "50.0%", "120.0 KiB/s", "1.2 MiB/s", "ens3"]) expect(html).toContain(value);
		expect(html).toContain('role="group"');
		expect(html).toContain(locale === "zh-CN" ? "服务器发送" : "Server sending");
		expect(html.indexOf("server-metrics-strip")).toBeLessThan(html.indexOf(locale === "zh-CN" ? "沙盒已开启" : "Sandbox enabled"));
		expect(html.match(/class="server-metric(?: server-metric-network)?"/g)).toHaveLength(3);
	});

	it("shows placeholders for initial sampling and missing network data instead of fabricated zeros", () => {
		const html = render({ status: "sampling" });
		expect(html).toContain("采样中");
		expect(html).not.toContain("0.0%");
		expect(html).not.toContain("0 B/s");
		const missingNetwork = render({ ...live, snapshot: { ...live.snapshot!, network: undefined } });
		expect(missingNetwork).toContain("3.4%");
		expect(missingNetwork).toContain("未找到可读取的默认路由网卡");
	});

	it("distinguishes a network baseline from an idle interface and preserves failed data with a warning", () => {
		const pending = render({ ...live, snapshot: { ...live.snapshot!, network: {
			interfaceName: "ens3", receiveBytesPerSecond: null, transmitBytesPerSecond: null,
		} } });
		expect(pending).toContain("采样中");
		expect(pending).not.toContain("0 B/s");
		const failed = render({ ...live, status: "unavailable", error: "Permission denied" });
		expect(failed).toContain('data-state="unavailable"');
		expect(failed).toContain("Permission denied");
		expect(failed).toContain("3.4%");
	});
});
