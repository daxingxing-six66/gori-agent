import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it } from "vitest";
import { ChatAttachmentUploads } from "../features/chat/components/chat-attachment-uploads";
import type { ChatAttachmentUpload } from "../features/chat/runtime/use-chat-attachment-uploads";
import { enUSMessages } from "../features/i18n/messages/en-US";

const document: ChatAttachmentUpload = {
	id: "document", kind: "document", name: "notes.md", size: 100, previewUrl: null, status: "uploaded", error: null,
	attachment: { id: "document", sessionId: "session", name: "notes.md", mimeType: "text/markdown", size: 100, storagePath: "notes.md", contentUrl: "/unsafe-html-content", createdAt: 1 },
};

function render(uploads: ChatAttachmentUpload[], limitNotice = false) {
	return renderToStaticMarkup(<IntlProvider locale="en-US" messages={enUSMessages}>
		<ChatAttachmentUploads uploads={uploads} limitNotice={limitNotice} onDismiss={() => {}} onOpenAttachment={() => {}} />
	</IntlProvider>);
}

describe("composer attachment cards", () => {
	it("renders documents as text cards without loading the content URL as image or iframe", () => {
		const html = render([document]);
		expect(html).toContain("View document notes.md");
		expect(html).toContain("read tool");
		expect(html).not.toContain("/unsafe-html-content");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<iframe");
	});

	it("retains image preview controls beside document cards", () => {
		const html = render([document, { ...document, id: "image", kind: "image", name: "image.png", previewUrl: "blob:image" }]);
		expect(html).toContain('src="blob:image"');
		expect(html).toContain("Preview image image.png");
		expect(html).toContain("Remove attachment notes.md");
		expect(html).toContain("Images over 2048px");
	});

	it("displays upload failures and explicit per-message file limits", () => {
		const html = render([{ ...document, status: "error", attachment: null, error: "Invalid UTF-8" }], true);
		expect(html).toContain("notes.md: Invalid UTF-8");
		expect(html).toContain("up to 4 attachments");
		expect(html).toContain('disabled=""');
	});
});
