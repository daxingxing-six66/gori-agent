import { type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatComposerNotices } from "../features/chat/components/chat-composer-notices";
import type { ManualChatCompactionResult } from "../features/chat/model/chat";
import { enUSMessages } from "../features/i18n/messages/en-US";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";
import { ApiError } from "../shared/errors/api-error";

const completed: ManualChatCompactionResult = {
	status: "completed", reason: "manual", attempts: 1,
	contextUsage: { contextTokens: 500, contextWindow: 10000, usagePercent: 5, source: "estimated", providerId: "p", modelId: "m" },
	message: { id: "summary", sequence: 1, createdAt: 0, message: { role: "user", content: "summary", timestamp: 0 } },
	tokensBefore: 1000, estimatedTokensAfter: 500, reductionPercent: 50,
	model: { providerId: "p", modelId: "m", fallback: false },
};

function renderNotices(overrides: Partial<ComponentProps<typeof ChatComposerNotices>> = {}, english = false) {
	return renderToStaticMarkup(
		<IntlProvider locale={english ? "en-US" : "zh-CN"} messages={english ? enUSMessages : zhCNMessages}>
			<ChatComposerNotices runtimeError={null} autoAuditError={null} compacting={false} manualCompactionResult={null}
				onClearRuntimeError={() => {}} onClearAutoAuditError={() => {}} onClearManualCompactionResult={() => {}} {...overrides} />
		</IntlProvider>,
	);
}

describe("composer notice projection", () => {
	it("does not reserve space when there are no notices", () => {
		expect(renderNotices()).toBe("");
	});
	it("shows progress instead of an earlier result while retaining independent errors", () => {
		const html = renderNotices({ compacting: true, manualCompactionResult: completed, runtimeError: "server error" });
		expect(html).toContain("正在压缩上下文");
		expect(html).not.toContain("上下文已压缩");
		expect(html).toContain("motion-safe:animate-spin");
		expect(html).toContain("server error");
		expect(html.match(/<button /g)).toHaveLength(1);
	});
	it("renders skipped and completed outcomes with optional fallback details", () => {
		expect(renderNotices({ manualCompactionResult: { status: "skipped", reason: "nothing_to_compact", attempts: 0, contextUsage: null } })).toContain("当前没有可压缩的上下文");
		const html = renderNotices({ manualCompactionResult: completed });
		expect(html).toContain("1,000 → 500 Token");
		expect(html).not.toContain("本次使用了会话模型");
		expect(renderNotices({ manualCompactionResult: { ...completed, model: { ...completed.model, fallback: true } } })).toContain("\n本次使用了会话模型。");
	});
	it("preserves raw errors in English while localizing surrounding UI", () => {
		const html = renderNotices({ runtimeError: "后端原文 <error>", autoAuditError: new ApiError(500, "internal_error", "audit failed") }, true);
		expect(html).toContain("后端原文 &lt;error&gt;");
		expect(html).toContain("audit failed");
		expect(html.match(/role="alert"/g)).toHaveLength(2);
		expect(html.match(/aria-label="Close"/g)).toHaveLength(2);
	});
});
