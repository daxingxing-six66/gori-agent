import { createElement, type AnchorHTMLAttributes, type MouseEvent as ReactMouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarSessionRow } from "../components/sidebar-session-row";
import type { Session } from "../features/session/model/session";
import type { SessionActivityDisplayState } from "../features/session-activity/model/session-activity";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";

const states = vi.hoisted(() => new Map<string, SessionActivityDisplayState>());
const controls = vi.hoisted(() => ({ acknowledge: vi.fn(), links: new Map<string, AnchorHTMLAttributes<HTMLAnchorElement>>() }));
vi.mock("next/link", () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => {
	controls.links.set(String(props.href), props);
	return createElement("a", props);
} }));
vi.mock("../features/session-activity/components/session-activity-provider", () => ({
	useSessionActivity: (id: string) => states.get(id) ?? "idle",
	useAcknowledgeSessionActivity: (id: string) => () => controls.acknowledge(id),
}));

beforeEach(() => { states.clear(); controls.links.clear(); controls.acknowledge.mockClear(); });

const session: Session = {
	id: "target", workspaceId: "workspace", displayName: "名称很长的会话", workDir: null, autoAudit: false,
	sandboxEnabled: true, terminalContextCursor: 0, revision: 1, createdAt: 1, updatedAt: 1,
};

function row(id: string, state: SessionActivityDisplayState, onNavigate = vi.fn()) {
	states.set(id, state);
	return renderToStaticMarkup(createElement(IntlProvider, { locale: "zh-CN", messages: zhCNMessages },
		createElement(SidebarSessionRow, { session: { ...session, id }, active: true, onNavigate, onEdit: vi.fn(), onDelete: vi.fn() })));
}

function click(overrides: Partial<ReactMouseEvent<HTMLAnchorElement>> = {}): ReactMouseEvent<HTMLAnchorElement> {
	return { button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides } as ReactMouseEvent<HTMLAnchorElement>;
}

describe("sidebar session row", () => {
	it.each(["running", "waiting_approval", "waiting_input", "attention", "completed", "failed", "cancelled"] as const)("places %s in the trailing slot with independent edit/delete actions", (state) => {
		const html = row("target", state);
		expect(html).toContain('aria-current="page"');
		expect(html).toContain('class="sidebar-session-marker" aria-hidden="true"');
		expect(html.indexOf("</a>")).toBeLessThan(html.indexOf('class="sidebar-session-trailing"'));
		expect(html).toContain(`aria-label="${zhCNMessages[`sessionActivity.${state}`]}"`);
		expect(html).toContain(`aria-label="${zhCNMessages["session.edit"]} ${session.displayName}"`);
		expect(html).toContain('class="sidebar-session-actions"');
		expect(html.match(/<button /g)).toHaveLength(2);
	});

	it("does not give idle or unrelated sessions the target's completion marker", () => {
		expect(row("target", "completed")).toContain("session-activity-completed");
		for (const state of ["idle", "unknown"] as const) expect(row("unrelated", state)).not.toContain('role="img"');
	});

	it("acknowledges the clicked session even when it is already selected", () => {
		const navigate = vi.fn();
		row("target", "completed", navigate);
		controls.links.get("/sessions/target")!.onClick!(click());
		expect(controls.acknowledge).toHaveBeenCalledExactlyOnceWith("target");
		expect(navigate).toHaveBeenCalledOnce();
	});

	it("does not acknowledge a prevented click or a link opened in another tab", () => {
		const navigate = vi.fn();
		row("target", "completed", navigate);
		for (const options of [{ defaultPrevented: true }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
			controls.links.get("/sessions/target")!.onClick!(click(options));
		}
		expect(controls.acknowledge).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});
});
