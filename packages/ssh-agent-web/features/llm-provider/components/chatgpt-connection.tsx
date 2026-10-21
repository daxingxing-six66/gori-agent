"use client";

import { ExternalLink, LoaderCircle, LogIn, MoreHorizontal, RefreshCw, Sparkles, Unplug, Users } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { chatGptApi, type ChatGptConnection as Connection, type ChatGptSignIn } from "@/features/llm-provider/api/chatgpt-api";
import { useLlmProviders } from "@/features/llm-provider/components/llm-provider-context";
import { ApiError } from "@/shared/errors/api-error";

export function ChatGptConnection({ onBusyChange, disabled = false }: { onBusyChange(busy: boolean): void; disabled?: boolean }) {
	const intl = useIntl();
	const localizeError = useLocalizedErrorMessage();
	const { refreshProviders } = useLlmProviders();
	const [connection, setConnection] = useState<Connection | null>(null);
	const [attempt, setAttempt] = useState<(ChatGptSignIn & { authorizationUrl: string }) | null>(null);
	const [working, setWorking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmDisconnect, setConfirmDisconnect] = useState(false);
	const [actionsOpen, setActionsOpen] = useState(false);
	const mounted = useRef(false);
	const pendingId = useRef<string | null>(null);
	const actionsId = useId();
	const actionsRef = useRef<HTMLDivElement>(null);
	const actionsButtonRef = useRef<HTMLButtonElement>(null);
	const firstActionRef = useRef<HTMLButtonElement>(null);
	const cancelDisconnectRef = useRef<HTMLButtonElement>(null);
	const busy = working || attempt !== null;
	const unavailable = busy || disabled;
	const message = (id: Parameters<typeof intl.formatMessage>[0]["id"]) => intl.formatMessage({ id });

	const reload = useCallback(async () => {
		const result = await chatGptApi.connection();
		if (mounted.current) setConnection(result);
		await refreshProviders();
	}, [refreshProviders]);

	useEffect(() => {
		mounted.current = true;
		void reload().catch((error: unknown) => { if (mounted.current) setError(localizeError(error)); });
		return () => {
			mounted.current = false;
			if (pendingId.current) void chatGptApi.cancel(pendingId.current).catch(() => undefined);
		};
	}, [localizeError, reload]);
	useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
	useEffect(() => () => onBusyChange(false), [onBusyChange]);
	useEffect(() => { if (disabled) setActionsOpen(false); }, [disabled]);
	useEffect(() => { if (confirmDisconnect) cancelDisconnectRef.current?.focus(); }, [confirmDisconnect]);
	useEffect(() => {
		if (!actionsOpen) return;
		firstActionRef.current?.focus();
		const closeOnOutsidePointer = (event: PointerEvent) => {
			if (event.target instanceof Node && !actionsRef.current?.contains(event.target)) setActionsOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setActionsOpen(false);
			actionsButtonRef.current?.focus();
		};
		// Capture Escape before the settings dialog's document listener handles it.
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		document.addEventListener("keydown", closeOnEscape, true);
		return () => {
			document.removeEventListener("pointerdown", closeOnOutsidePointer);
			document.removeEventListener("keydown", closeOnEscape, true);
		};
	}, [actionsOpen]);

	useEffect(() => {
		if (!attempt) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			try {
				const result = await chatGptApi.status(attempt.id, controller.signal);
				if (controller.signal.aborted) return;
				if (result.status === "pending") { timer = setTimeout(() => void poll(), 1000); return; }
				pendingId.current = null;
				setAttempt(null);
				if (result.errorCode) setError(intl.formatMessage({ id: result.errorCode === "chatgpt_permission_required"
					? "provider.chatgpt.permissionRequired" : result.errorCode === "chatgpt_region_unsupported"
						? "provider.chatgpt.regionUnsupported" : result.errorCode === "chatgpt_model_discovery_failed"
						? "provider.chatgpt.modelsFailed" : "provider.chatgpt.signInFailed" }) + (result.failure ?
					` (${result.failure.stage}: ${result.failure.reason}${result.failure.httpStatus ? `, HTTP ${result.failure.httpStatus}` : ""}${result.failure.transportCode ? `, ${result.failure.transportCode}` : ""}${result.failure.upstreamCode ? `, ${result.failure.upstreamCode}` : ""})` : ""));
				await reload();
			} catch (error) {
				if (!controller.signal.aborted) {
					setError(localizeError(error));
					if (error instanceof ApiError && error.status === 404) { pendingId.current = null; setAttempt(null); return; }
					// Keep the cancel action available during a transient polling failure.
					timer = setTimeout(() => void poll(), 3000);
				}
			}
		};
		void poll();
		return () => { controller.abort(); clearTimeout(timer); };
	}, [attempt, intl, localizeError, reload]);

	const begin = async (newAccount: boolean) => {
		if (unavailable) return;
		setActionsOpen(false);
		setConfirmDisconnect(false);
		setWorking(true);
		setError(null);
		// Open synchronously so normal popup policies do not block the authorization tab.
		const popup = window.open("about:blank", "_blank");
		if (popup) popup.opener = null;
		try {
			const result = await chatGptApi.begin(newAccount);
			if (!mounted.current) { popup?.close(); await chatGptApi.cancel(result.id); return; }
			pendingId.current = result.id;
			setAttempt(result);
			popup?.location.replace(result.authorizationUrl);
		} catch (error) { popup?.close(); if (mounted.current) setError(localizeError(error)); }
		finally { if (mounted.current) setWorking(false); }
	};

	const cancel = async () => {
		if (!attempt) return;
		try { await chatGptApi.cancel(attempt.id); pendingId.current = null; setAttempt(null); await reload(); }
		catch (error) { setError(localizeError(error)); }
	};

	const perform = async (operation: () => Promise<void>) => {
		if (unavailable) return;
		setActionsOpen(false);
		setWorking(true);
		setError(null);
		try { await operation(); await reload(); setConfirmDisconnect(false); }
		catch (error) { if (mounted.current) setError(localizeError(error)); }
		finally { if (mounted.current) setWorking(false); }
	};

	return <section className="rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] p-4" aria-label={message("provider.chatgpt.title")}>
		<div className="flex flex-wrap items-center justify-between gap-3">
			<div className="flex min-w-0 flex-1 items-center gap-3">
				<span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-ink)]" aria-hidden="true">
					{busy || !connection && !error ? <LoaderCircle size={18} className="animate-spin" /> : <Sparkles size={18} />}
				</span>
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="text-[12px] font-semibold text-[var(--ink)]">{message("provider.chatgpt.title")}</h3>
						{connection ? <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${connection.connected && connection.sharing ? "bg-[var(--success-soft)] text-[var(--success)]" : "bg-[var(--surface-muted)] text-[var(--text-muted)]"}`} role="status">
							{message(attempt ? "provider.chatgpt.authorizing" : working ? "common.loading" : connection.connected ? connection.sharing ? "provider.chatgpt.connected" : "provider.chatgpt.permissionPending" : "provider.chatgpt.notConnected")}
						</span> : <span className="text-[10px] text-[var(--text-muted)]" role="status">{message(error ? "provider.chatgpt.notConnected" : "common.loading")}</span>}
					</div>
					{connection?.connected && connection.email ? <p className="mt-1 truncate text-[11px] text-[var(--text-muted)]" title={connection.email}>{connection.email}</p> : null}
				</div>
			</div>
			{connection?.connected && !attempt ? <div className="flex shrink-0 items-center gap-2">
				<a href={connection.manageUsageUrl} target="_blank" rel="noreferrer noopener" className="provider-action">
					{message("provider.chatgpt.manageUsage")} <ExternalLink size={12} aria-hidden="true" />
				</a>
				<div ref={actionsRef} className="relative" onBlur={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget)) setActionsOpen(false);
				}}>
					<button ref={actionsButtonRef} type="button" className="provider-action !w-8 !px-0" disabled={unavailable} aria-label={message("provider.chatgpt.moreActions")} aria-expanded={actionsOpen} aria-controls={actionsId} onClick={() => setActionsOpen((open) => !open)}>
						<MoreHorizontal size={17} aria-hidden="true" />
					</button>
					{actionsOpen ? <div id={actionsId} className="provider-connection-actions absolute right-0 top-full z-20 mt-1.5 w-44 rounded-lg border border-[var(--line)] bg-[var(--surface-raised)] p-1 shadow-lg" role="group" aria-label={message("provider.chatgpt.moreActions")}>
						<button ref={firstActionRef} type="button" disabled={unavailable} className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)]" onClick={() => void begin(false)}><LogIn size={13} aria-hidden="true" />{message("provider.chatgpt.reconnect")}</button>
						<button type="button" disabled={unavailable} className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)]" onClick={() => void perform(chatGptApi.refreshModels)}><RefreshCw size={13} aria-hidden="true" />{message("provider.chatgpt.refreshModels")}</button>
						<button type="button" disabled={unavailable} className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)]" onClick={() => void begin(true)}><Users size={13} aria-hidden="true" />{message("provider.chatgpt.changeAccount")}</button>
						<div className="my-1 border-t border-[var(--line-soft)]" />
						<button type="button" disabled={unavailable} className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-[11px] text-[var(--danger)] hover:bg-[var(--danger-soft)] focus-visible:bg-[var(--danger-soft)]" onClick={() => { setActionsOpen(false); setConfirmDisconnect(true); }}><Unplug size={13} aria-hidden="true" />{message("provider.chatgpt.disconnect")}</button>
					</div> : null}
				</div>
			</div> : null}
		</div>
		{!connection?.connected && connection ? <div className="mt-3">
			<p className="max-w-[520px] text-[11px] leading-5 text-[var(--text-muted)]">{message("provider.chatgpt.description")}</p>
			{!attempt ? <div className="mt-3 flex flex-wrap items-center gap-3">
				<button type="button" className="provider-action provider-action-primary" disabled={unavailable} onClick={() => void begin(false)}><LogIn size={13} aria-hidden="true" />{message("provider.chatgpt.signIn")}</button>
				<button type="button" className="text-[11px] text-[var(--text-muted)] hover:text-[var(--ink)] disabled:opacity-45" disabled={unavailable} onClick={() => void begin(true)}>{message("provider.chatgpt.changeAccount")}</button>
			</div> : null}
		</div> : null}
		{connection?.connected && !connection.sharing ? <p className="mt-3 text-[11px] leading-5 text-[var(--text-muted)]">{message("provider.chatgpt.permissionRequired")}</p> : null}
		{error ? <p className="mt-3 rounded-md bg-[var(--danger-soft)] px-3 py-2 text-[11px] leading-5 text-[var(--danger)]" role="alert">{error}</p> : null}
		{attempt ? <div className="mt-3 border-t border-[var(--line-soft)] pt-3 text-[11px]">
			<p className="leading-5 text-[var(--text-secondary)]" role="status">{message("provider.chatgpt.waiting")}</p>
			<div className="mt-2 flex flex-wrap items-center gap-3">
				<a href={attempt.authorizationUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 text-[var(--accent-ink)] underline underline-offset-2">{message("provider.chatgpt.openBrowser")}<ExternalLink size={11} aria-hidden="true" /></a>
				<button type="button" className="provider-action" disabled={disabled || working} onClick={() => void cancel()}>{message("common.cancel")}</button>
			</div>
		</div> : null}
		{confirmDisconnect && connection?.connected && !attempt ? <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line-soft)] pt-3" role="group" aria-label={message("provider.chatgpt.confirmDisconnect")}>
			<p className="text-[11px] text-[var(--danger)]">{message("provider.chatgpt.disconnectPrompt")}</p>
			<div className="flex items-center gap-2">
				<button ref={cancelDisconnectRef} type="button" className="provider-action" disabled={unavailable} onClick={() => { setConfirmDisconnect(false); actionsButtonRef.current?.focus(); }}>{message("common.cancel")}</button>
				<button type="button" className="provider-action !border-[var(--danger-line)] !text-[var(--danger)] hover:!bg-[var(--danger-soft)]" disabled={unavailable} onClick={() => void perform(chatGptApi.disconnect)}>{message("provider.chatgpt.confirmDisconnect")}</button>
			</div>
		</div> : null}
		{!connection && error ? <button type="button" className="provider-action mt-3" disabled={unavailable} onClick={() => void reload().catch((error: unknown) => setError(localizeError(error)))}><RefreshCw size={12} aria-hidden="true" />{message("common.reload")}</button> : null}
	</section>;
}
