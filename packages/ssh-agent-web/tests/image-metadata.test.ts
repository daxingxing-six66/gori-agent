import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";
import { formatImageMetadata } from "../features/chat/components/chat-image-preview-dialog";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";
import { enUSMessages } from "../features/i18n/messages/en-US";

describe("image metadata interpolation", () => {
	it("formats numeric dimensions in both locales without losing file size", () => {
		for (const [locale, messages] of [["zh-CN", zhCNMessages], ["en-US", enUSMessages]] as const) {
			const intl = createIntl({ locale, messages, onError: (error) => { throw error; } });
			const text = formatImageMetadata(intl, { id: "image", name: "screen.png", src: "/image", size: 2048, dimensions: { width: 640, height: 480 } });
			expect(text).toContain("640 × 480");
			expect(text).toContain("2.0 KiB");
		}
	});
	it("retains the loading label until dimensions are known", () => {
		const intl = createIntl({ locale: "zh-CN", messages: zhCNMessages });
		expect(formatImageMetadata(intl, { id: "image", name: "screen.png", src: "/image", size: 10 })).toBe("读取尺寸中 · 10 B");
	});
});
