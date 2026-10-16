import type { ComponentProps, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetails } from "../features/session/model/session";
import type { Workspace } from "../features/workspace/model/workspace";

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
let hooks: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useState: (initial: unknown) => hooks.state(initial),
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => hooks.effect(effect, deps),
}));
vi.mock("react-intl", () => ({ useIntl: () => ({ formatMessage: ({ id }: { id: string }) => id }) }));
vi.mock("../features/i18n/components/use-localized-error-message", () => ({ useLocalizedErrorMessage: () => (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock("../features/session/api/session-api", () => ({ sessionApi: api }));
import { SessionEditDialog } from "../features/session/components/session-edit-dialog";
import { SessionDialog } from "../features/session/components/session-dialog";

/** Controls snapshot and response ordering without a server or browser. */
class HookDriver {
	private states: unknown[] = [];
	private effects: { deps: readonly unknown[]; cleanup?: () => void }[] = [];
	private queued: (() => void)[] = [];
	private stateIndex = 0;
	private effectIndex = 0;
	state<T>(initial: T): [T, (next: T | ((current: T) => T)) => void] {
		const index = this.stateIndex++;
		if (!(index in this.states)) this.states[index] = initial;
		return [this.states[index] as T, (next) => {
			this.states[index] = typeof next === "function" ? (next as (current: T) => T)(this.states[index] as T) : next;
		}];
	}
	effect(effect: () => void | (() => void), deps: readonly unknown[]) {
		const index = this.effectIndex++;
		const previous = this.effects[index];
		if (previous && deps.every((value, offset) => Object.is(value, previous.deps[offset]))) return;
		this.queued.push(() => {
			previous?.cleanup?.();
			const cleanup = effect();
			this.effects[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
		});
	}
	render() {
		this.stateIndex = this.effectIndex = 0;
		const result = SessionEditDialog(props);
		const effects = this.queued; this.queued = [];
		for (const effect of effects) effect();
		return result;
	}
	unmount() { for (const effect of this.effects) effect.cleanup?.(); }
}

const session: SessionDetails = { id: "session", workspaceId: "workspace", displayName: "test", workDir: "/local", autoAudit: false,
	sandboxEnabled: true, sandboxWritableRoots: ["/srv/app"], terminalContextCursor: 0, revision: 5, createdAt: 1, updatedAt: 1, chatModelSelection: null };
const workspace: Workspace = { id: "workspace", displayName: "test", environment: "development", host: { hostname: "fixture.invalid", port: 22, hostKey: null },
	activeCredentialId: "credential", defaultCwd: "/local", sandboxWritableRoots: ["/srv/app", "/var/log/app"],
	connection: { connectTimeoutMs: 10000, keepaliveIntervalMs: 15000, keepaliveMaxCount: 3 }, revision: 1, createdAt: 1, updatedAt: 1 };
const props = { sessionId: session.id, workspace, onClose: vi.fn(), onUpdated: vi.fn(async () => undefined) };
const input = { displayName: "edited", workDir: "/local", autoAudit: false, sandboxWritableRoots: ["/srv/app", "/etc/app"] };
async function loadedEditor() {
	hooks.render(); await Promise.resolve();
	const editor = hooks.render(); expect(editor.type).toBe(SessionDialog);
	return editor as ReactElement<ComponentProps<typeof SessionDialog>>;
}
beforeEach(() => { vi.clearAllMocks(); hooks = new HookDriver(); api.get.mockResolvedValue(session); api.update.mockResolvedValue({ ...session, revision: 6 }); });

describe("Session edit entry", () => {
	it("submits name and directory edits together against the editing revision without toggling mode", async () => {
		const editor = await loadedEditor();
		api.get.mockResolvedValue({ ...session, revision: 9 });
		await editor.props.onSubmit(input);
		expect(api.get).toHaveBeenCalledOnce();
		expect(api.update).toHaveBeenCalledExactlyOnceWith("session", { ...input, expectedRevision: 5 });
		expect(props.onUpdated).toHaveBeenCalledExactlyOnceWith("session"); expect(props.onClose).toHaveBeenCalledOnce();
	});
	it("refreshes projections after a committed setting / PTY reopen failure and keeps editing open", async () => {
		const editor = await loadedEditor();
		const failure = new Error("PTY replacement failed"); api.update.mockRejectedValueOnce(failure);
		await expect(editor.props.onSubmit(input)).rejects.toBe(failure);
		expect(props.onUpdated).toHaveBeenCalledExactlyOnceWith("session"); expect(props.onClose).not.toHaveBeenCalled();
		expect(editor.props.session?.revision).toBe(5);
	});
	it("reloads explicitly after a conflict rather than overwriting concurrent changes", async () => {
		const editor = await loadedEditor(); api.update.mockRejectedValueOnce(new Error("revision_conflict"));
		await expect(editor.props.onSubmit(input)).rejects.toThrow("revision_conflict");
		api.get.mockResolvedValue({ ...session, revision: 9, sandboxWritableRoots: ["/srv/new"] });
		editor.props.onReload?.();
		const reloaded = await loadedEditor(); expect(reloaded.props.session).toMatchObject({ revision: 9, sandboxWritableRoots: ["/srv/new"] });
	});
	it("aborts a loading snapshot when its editor is unmounted", () => {
		api.get.mockReturnValueOnce(new Promise(() => {})); hooks.render();
		const signal = api.get.mock.calls[0][1] as AbortSignal;
		hooks.unmount(); expect(signal.aborted).toBe(true); expect(api.update).not.toHaveBeenCalled();
	});
});
