"use client";

import { FolderOpen, Info } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { useSessionWorkDir } from "../runtime/use-session-work-dir";
import "./session-info-popover.css";

interface SessionInfoProps {
	sessionId: string; workDir: string | null; sandboxEnabled: boolean; sandboxReadOnly: boolean;
	writableRoots: readonly string[]; metrics: ReactNode;
}

/** A read-only context card. Monitoring stays mounted; opening does not change Session settings. */
export function SessionInfoPopover(props: SessionInfoProps) {
	const intl = useIntl();
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pinned = useRef(false);
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
	const directory = useSessionWorkDir(props.sessionId, props.workDir, open);
	const cancelClose = () => { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = null; };
	const close = () => { cancelClose(); pinned.current = false; setOpen(false); };
	const enter = () => { cancelClose(); setOpen(true); };
	const leave = () => {
		cancelClose();
		closeTimer.current = setTimeout(() => {
			if (!pinned.current && !trigger.current?.contains(document.activeElement) && !panel.current?.contains(document.activeElement)) setOpen(false);
		}, 140);
	};
	useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
	useEffect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => {
			if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) close();
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [open]);
	useLayoutEffect(() => {
		if (!open) return;
		const place = () => {
			const bounds = trigger.current?.getBoundingClientRect();
			if (!bounds) return;
			const width = Math.min(380, window.innerWidth - 24);
			const top = bounds.bottom + 8;
			setPosition({ left: Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)), top, width,
				maxHeight: Math.max(80, window.innerHeight - top - 12) });
		};
		place(); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
		return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
	}, [open]);
	const label = intl.formatMessage({ id: "session.info.label" });
	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === "ArrowDown") {
			event.preventDefault(); pinned.current = true; enter();
			requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
		}
		if (event.key === "Escape" && open) {
			event.preventDefault(); event.stopPropagation(); trigger.current?.focus({ preventScroll: true }); close();
		}
	};
	return <>
		<button ref={trigger} type="button" className="session-info-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
			onMouseEnter={enter} onMouseLeave={leave} onFocus={enter} onBlur={(event) => {
				if (!panel.current?.contains(event.relatedTarget)) close();
			}} onClick={() => { cancelClose(); pinned.current = !pinned.current; setOpen(pinned.current); }} onKeyDown={handleKeyDown}>
			<Info size={16} aria-hidden="true" />
		</button>
		{typeof document !== "undefined" ? createPortal(<div ref={panel} id={id} role="dialog" aria-modal={false} aria-label={label} hidden={!open}
			className="session-info-popover app-scrollbar" style={position} tabIndex={-1} onMouseEnter={enter} onMouseLeave={leave}
			onKeyDown={handleKeyDown} onBlur={(event) => {
				if (!panel.current?.contains(event.relatedTarget) && !trigger.current?.contains(event.relatedTarget)) close();
			}}>
			<SessionInfoContent {...props} directory={directory} />
		</div>, document.body) : null}
	</>;
}

export function SessionInfoContent({ sandboxEnabled, sandboxReadOnly, writableRoots, metrics, directory }: Omit<SessionInfoProps, "sessionId" | "workDir"> & {
	directory: { path?: string; failed: boolean };
}) {
	const intl = useIntl();
	const roots = sandboxReadOnly ? ["/tmp"] : writableRoots;
	return <>
		<section className="session-info-section"><h2>{intl.formatMessage({ id: "session.info.resources" })}</h2>{metrics}</section>
		<section className="session-info-section"><h2><FolderOpen size={14} aria-hidden="true" />{intl.formatMessage({ id: "session.field.workDir" })}</h2>
			{directory.path ? <code className="session-info-path">{directory.path}</code> : <p className="session-info-note">{intl.formatMessage({ id: directory.failed ? "session.info.workDirUnavailable" : "session.workDir.resolving" })}</p>}
		</section>
		<section className="session-info-section"><h2>{intl.formatMessage({ id: "session.info.writableRoots" })}</h2>
			{!sandboxEnabled ? <p className="session-info-note">{intl.formatMessage({ id: "session.info.sandboxOff" })}</p> : <>
				{roots.length ? <ul className="session-info-paths app-scrollbar">{roots.map((path) => <li key={path}><code className="session-info-path">{path}</code></li>)}</ul>
					: <p className="session-info-note">{intl.formatMessage({ id: "session.info.noWritableRoots" })}</p>}
				{sandboxReadOnly ? <p className="session-info-note">{intl.formatMessage({ id: "session.info.readOnlyPaths" })}</p> : null}
			</>}
		</section>
	</>;
}
