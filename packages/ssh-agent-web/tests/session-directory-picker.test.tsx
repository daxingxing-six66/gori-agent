import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	directoryBreadcrumbs,
} from "../features/session/components/local-directory-picker.tsx";
import { SessionDialog } from "../features/session/components/session-dialog.tsx";
import type { Session } from "../features/session/model/session.ts";

const session: Session = {
	id: "session-1",
	workspaceId: "workspace-1",
	displayName: "Session",
	workDir: "/Users/example/projects/app",
	autoAudit: false,
	terminalContextCursor: 0,
	revision: 1,
	createdAt: 1,
	updatedAt: 1,
};

describe("Session local directory picker", () => {
	it("renders the work directory as a read-only selected path", () => {
		const markup = renderToStaticMarkup(
			<SessionDialog session={session} onClose={() => {}} onSubmit={() => Promise.resolve()} />,
		);

		expect(markup).toContain("选择目录");
		expect(markup).toContain("使用系统默认目录");
		expect(markup).toContain('aria-label="本地工作目录"');
		expect(markup).toContain("readOnly");
		expect(markup).toContain('value="/Users/example/projects/app"');
	});

	it("builds navigable breadcrumbs from the system root", () => {
		expect(directoryBreadcrumbs("/Users/example/projects", "/")).toEqual([
			{ label: "/", path: "/" },
			{ label: "Users", path: "/Users" },
			{ label: "example", path: "/Users/example" },
			{ label: "projects", path: "/Users/example/projects" },
		]);
	});
});
