"use client";

import { CircleAlert, CircleCheck, CircleMinus, LoaderCircle, MessageCircle, ShieldAlert, type LucideIcon } from "lucide-react";
import { useIntl } from "react-intl";
import type { SessionActivityDisplayState } from "../model/session-activity";
import { useSessionActivity } from "./session-activity-provider";
import "./session-activity.css";

const ACTIVITY_ICONS: Record<SessionActivityDisplayState, LucideIcon | null> = {
	running: LoaderCircle,
	waiting_approval: ShieldAlert,
	waiting_input: MessageCircle,
	attention: CircleAlert,
	completed: CircleCheck,
	failed: CircleAlert,
	cancelled: CircleMinus,
	idle: null,
	unknown: null,
};

export function SessionActivityIndicator({ sessionId }: { sessionId: string }) {
	const state = useSessionActivity(sessionId);
	return state === "idle" || state === "unknown" ? null : <SessionActivityGlyph state={state} />;
}

export function SessionActivityGlyph({ state, active = false }: { state: SessionActivityDisplayState; active?: boolean }) {
	const intl = useIntl();
	const label = intl.formatMessage({ id: `sessionActivity.${state}` });
	const Icon = ACTIVITY_ICONS[state];
	const attributes = { className: `session-activity-indicator session-activity-${state}`, "data-active": active, role: "img", "aria-label": label } as const;
	return Icon ? <Icon {...attributes} size={14} strokeWidth={2}><title>{label}</title></Icon>
		: <svg {...attributes} width={14} height={14} viewBox="0 0 14 14"><title>{label}</title><circle className="session-activity-dot" cx={7} cy={7} r={3} /></svg>;
}
