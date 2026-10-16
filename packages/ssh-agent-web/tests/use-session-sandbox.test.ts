import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SessionDetails } from "../features/session/model/session";

const api = vi.hoisted(() => ({ get: vi.fn<() => Promise<SessionDetails>>(), update: vi.fn<() => Promise<Session>>() }));
let hooks: HookDriver;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useState: (initial: unknown) => hooks.state(initial), useRef: (initial: unknown) => hooks.ref(initial),
	useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => hooks.effect(effect, deps),
	useCallback: <T,>(callback: T) => callback }));
vi.mock("react-intl", () => ({ useIntl: () => ({ formatMessage: ({ id }: { id: string }) => id }) }));
vi.mock("../features/session/api/session-api", () => ({ sessionApi: api }));
import { useSessionSandbox } from "../features/session/runtime/use-session-sandbox";

/** Minimal hook driver makes competing API responses deterministic without a DOM. */
class HookDriver {
	private states: unknown[] = [];
	private refs: { current: unknown }[] = [];
	private effects: { deps: readonly unknown[]; cleanup?: () => void }[] = [];
	private queued: (() => void)[] = [];
	private stateIndex = 0; private refIndex = 0; private effectIndex = 0;
	value!: ReturnType<typeof useSessionSandbox>;
	options: Parameters<typeof useSessionSandbox>[0] = { sessionId: "session", session, disabled: false,
		refreshSessions: vi.fn(async () => undefined), refreshTerminal: vi.fn(async () => undefined) };
	state<T>(initial: T): [T, (next: T) => void] {
		const index = this.stateIndex++; if (!(index in this.states)) this.states[index] = initial;
		return [this.states[index] as T, (next) => { this.states[index] = next; }];
	}
	ref<T>(initial: T) { const index = this.refIndex++; this.refs[index] ??= { current: initial }; return this.refs[index] as { current: T }; }
	effect(effect: () => void | (() => void), deps: readonly unknown[]) {
		const index = this.effectIndex++; const previous = this.effects[index];
		if (previous && deps.every((value, offset) => Object.is(value, previous.deps[offset]))) return;
		this.queued.push(() => { previous?.cleanup?.(); const cleanup = effect();
			this.effects[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }; });
	}
	render() {
		this.stateIndex = this.refIndex = this.effectIndex = 0; this.value = useSessionSandbox(this.options);
		const queued = this.queued; this.queued = []; for (const effect of queued) effect();
		return this.value;
	}
}

const session: Session = { id: "session", workspaceId: "workspace", displayName: "test", workDir: null,
	autoAudit: false, sandboxEnabled: true, terminalContextCursor: 0, revision: 1, createdAt: 1, updatedAt: 1 };
const details = (value: Session): SessionDetails => ({ ...value, chatModelSelection: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((finish) => { resolve = finish; }); return { promise, resolve }; }
beforeEach(() => { vi.resetAllMocks(); api.get.mockResolvedValue(details(session));
	api.update.mockResolvedValue({ ...session, revision: 2, sandboxEnabled: false }); hooks = new HookDriver(); hooks.render(); hooks.render(); });

describe("Session sandbox commands", () => {
	it("updates only the Session using the latest revision and refreshes the automatically reopened Terminal", async () => {
		api.get.mockResolvedValue(details({ ...session, revision: 5 }));
		expect(await hooks.value.execute("/sandbox off")).toBe(true); hooks.render();
		expect(api.update).toHaveBeenCalledExactlyOnceWith("session", { expectedRevision: 5, sandboxEnabled: false });
		expect(hooks.value.enabled).toBe(false); expect(hooks.options.refreshTerminal).toHaveBeenCalledOnce();
		expect(hooks.value.tools[0]?.status?.tone).toBe("inactive");
		expect(hooks.options.refreshSessions).toHaveBeenCalledOnce();
	});
	it("handles status and malformed slash commands locally without changing configuration", async () => {
		expect(await hooks.value.execute("/sandbox status")).toBe(true); hooks.render(); expect(hooks.value.notice).toBe("session.sandbox.enabledDescription");
		expect(await hooks.value.execute("/sandbox wrong")).toBe(false);
		expect(await hooks.value.execute("/sandbox off", true)).toBe(false); expect(api.update).not.toHaveBeenCalled();
		expect(await hooks.value.execute("Run uname -a")).toBeNull();
	});
	it("offers only the sandbox switch and toggles against the authoritative Session state", async () => {
		expect(hooks.value.tools).toHaveLength(1);
		expect(hooks.value.tools[0]).toMatchObject({ id: "sandbox", name: "session.sandbox.command.name",
			description: "session.sandbox.command.description", status: { tone: "active" } });
		// Another client changed the setting after this UI snapshot.
		api.get.mockResolvedValue(details({ ...session, revision: 5, sandboxEnabled: false }));
		api.update.mockResolvedValue({ ...session, revision: 6, sandboxEnabled: true });
		expect(await hooks.value.execute("/sandbox")).toBe(true);
		expect(api.update).toHaveBeenCalledExactlyOnceWith("session", { expectedRevision: 5, sandboxEnabled: true });
	});
	it("rejects the removed read-only command without changing configuration", async () => {
		expect(await hooks.value.execute("/sandbox read-only")).toBe(false); hooks.render();
		expect(hooks.value.error).toEqual(new Error("session.sandbox.usage"));
		expect(api.get).not.toHaveBeenCalled(); expect(api.update).not.toHaveBeenCalled();
	});
	it("shows read-only status selected in Edit Session and exits explicitly", async () => {
		const readOnly = { ...session, revision: 6, sandboxReadOnly: true, sandboxWritableRoots: ["/srv/app"] };
		hooks.options.session = readOnly; hooks.render(); hooks.render();
		expect(hooks.value.readOnly).toBe(true);
		expect(hooks.value.statusLabel).toBe("session.sandbox.readOnly");
		expect(hooks.value.tools).toHaveLength(1);
		expect(await hooks.value.execute("/sandbox status")).toBe(true); hooks.render();
		expect(hooks.value.notice).toBe("session.sandbox.readOnlyDescription");
		api.get.mockResolvedValue(details(readOnly));
		api.update.mockResolvedValue({ ...readOnly, revision: 7, sandboxReadOnly: false });
		expect(await hooks.value.execute("/sandbox on")).toBe(true); hooks.render();
		expect(api.update).toHaveBeenLastCalledWith("session", { expectedRevision: 6, sandboxEnabled: true, sandboxReadOnly: false });
		expect(hooks.value.readOnly).toBe(false);
	});
	it("prevents duplicate updates and exposes pending state until the request settles", async () => {
		const pending = deferred<Session>(); api.update.mockReturnValueOnce(pending.promise);
		const first = hooks.value.execute("/sandbox off"); await Promise.resolve(); hooks.render();
		expect(hooks.value.pending).toBe(true); expect(hooks.value.tools[0]?.status?.tone).toBe("pending");
		expect(await hooks.value.execute("/sandbox on")).toBe(false);
		pending.resolve({ ...session, revision: 2, sandboxEnabled: false }); await first; hooks.render();
		expect(hooks.value.pending).toBe(false); expect(api.update).toHaveBeenCalledOnce();
	});
	it("reloads actual persisted policy when Terminal reopening fails after the update commits", async () => {
		api.update.mockRejectedValueOnce(new Error("terminal capacity"));
		api.get.mockResolvedValueOnce(details(session)).mockResolvedValueOnce(details({ ...session, revision: 2, sandboxEnabled: false }));
		expect(await hooks.value.execute("/sandbox off")).toBe(false); hooks.render();
		expect(hooks.value.enabled).toBe(false); expect(hooks.value.error).toBeInstanceOf(Error);
		expect(hooks.options.refreshTerminal).toHaveBeenCalledOnce();
	});
	it("ignores late results after navigating to another Session", async () => {
		const pending = deferred<Session>(); api.update.mockReturnValueOnce(pending.promise);
		const first = hooks.value.execute("/sandbox off"); await Promise.resolve();
		hooks.options = { ...hooks.options, sessionId: "other", session: { ...session, id: "other" } }; hooks.render(); hooks.render();
		pending.resolve({ ...session, revision: 2, sandboxEnabled: false }); await first; hooks.render();
		expect(hooks.value.enabled).toBe(true); expect(hooks.value.pending).toBe(false);
		expect(hooks.options.refreshTerminal).not.toHaveBeenCalled();
	});
	it("blocks configuration changes during an active task", async () => {
		hooks.options.disabled = true; hooks.render(); expect(await hooks.value.execute("/sandbox off")).toBe(false);
		expect(api.get).not.toHaveBeenCalled(); expect(hooks.value.tools[0]?.disabled).toBe(true);
	});
	it("cancels Terminal refresh and stops the old flow when navigating after settings commit", async () => {
		const refreshing = deferred<void>();
		let refreshSignal: AbortSignal | undefined;
		hooks.options.refreshTerminal = vi.fn(async (signal?: AbortSignal) => {
			refreshSignal = signal;
			await refreshing.promise;
		});
		hooks.render();
		const switching = hooks.value.execute("/sandbox");
		await vi.waitFor(() => expect(hooks.options.refreshTerminal).toHaveBeenCalledOnce());
		hooks.options = { ...hooks.options, sessionId: "other", session: { ...session, id: "other" } };
		hooks.render(); hooks.render();
		expect(refreshSignal?.aborted).toBe(true);
		refreshing.resolve();
		expect(await switching).toBe(false);
		expect(hooks.options.refreshSessions).not.toHaveBeenCalled();
	});
});
