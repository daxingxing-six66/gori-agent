"use client";

import { ArrowDown, ChevronUp } from "lucide-react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { ChatComposerPanel, type ChatComposerPanelHandle } from "@/features/chat/components/chat-composer-panel";
import type { ChatComposerTool } from "@/features/chat/components/chat-token-editor";
import { ChatTimeline } from "@/features/chat/components/chat-timeline";
import { UserDecisionPanel } from "@/features/chat/components/user-decision-panel";
import { activeChatRun } from "@/features/chat/model/chat-runtime-state";
import { waitingForChatResponse } from "@/features/chat/model/chat-activity";
import { chatScrollBehavior, isNearChatHistoryTop } from "@/features/chat/model/chat-scroll";
import type { ToolApproval } from "@/features/chat/model/chat";
import type { SessionAttachment } from "@/features/session/api/session-attachment-api";
import { useChatModelSelection } from "@/features/chat/runtime/use-chat-model-selection";
import { useChatRuntime } from "@/features/chat/runtime/use-chat-runtime";
import { resolveConfiguredModel } from "@/features/llm-provider/api/llm-provider-api";
import { thinkingLevelForModel } from "@/features/llm-provider/model/llm-provider";
import { sessionApi } from "@/features/session/api/session-api";
import { ChatPageHeader } from "@/features/chat/components/chat-page-header";
import { SessionSandboxStatus } from "@/features/session/components/session-sandbox-status";
import { isSessionSandboxCommand } from "@/features/session/model/session-sandbox-command";
import { useSessionSandbox } from "@/features/session/runtime/use-session-sandbox";
import { TerminalConnectionState } from "@/features/terminal/components/terminal-connection-state";
import { TerminalOpenFailure, terminalOpenFailureFromStatus } from "@/features/terminal/components/terminal-open-failure";
import { TerminalSandboxNotice } from "@/features/terminal/components/terminal-sandbox-notice";
import { TerminalPanel } from "@/features/terminal/components/terminal-panel";
import { TERMINAL_UI_DEFAULTS } from "@/features/terminal/model/terminal-ui-defaults";
import { useTerminalMode } from "@/features/terminal/runtime/use-terminal-mode";
import { useWorkspaceTree } from "@/features/workspace/components/workspace-tree-context";
import { ApiError } from "@/shared/errors/api-error";
import { DeploymentPanel } from "@/features/deploy/components/deployment-panel";
import { useDeployment } from "@/features/deploy/runtime/use-deployment";

export function ChatConsole({ sessionId }: { sessionId: string }) {
	const intl = useIntl();
	const { tree, loading: treeLoading, refresh } = useWorkspaceTree();
	const item = tree?.workspaces.flatMap(({ workspace, sessions }) => sessions.map((session) => ({ session, workspace }))).find(({ session }) => session.id === sessionId);
	const runtime = useChatRuntime(sessionId);
	const terminalMode = useTerminalMode(sessionId);
	const deployment = useDeployment(sessionId, item?.workspace.id);
	const modelSelection = useChatModelSelection(sessionId, runtime.loading, runtime.state.run);
	const { model, thinkingLevel, loading: modelSelectionLoading, error: modelSelectionError } = modelSelection;
	const [autoAuditPending, setAutoAuditPending] = useState(false);
	const [autoAuditOverride, setAutoAuditOverride] = useState<boolean | null>(null);
	const [autoAuditError, setAutoAuditError] = useState<unknown>(null);
	const composerRef = useRef<ChatComposerPanelHandle>(null);
	const decisionReopenRef = useRef<HTMLButtonElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const initialScrollCompleteRef = useRef(false);
	const followNewContentRef = useRef(true);
	const historyScrollRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
	const scrolledDeploymentRef = useRef<string | null>(null);
	const [showReturnToBottom, setShowReturnToBottom] = useState(false);
	const [hiddenDecisionId, setHiddenDecisionId] = useState<string | null>(null);
	const planningRequestRef = useRef<{ sessionId: string } | null>(null);
	const [planningSubmitting, setPlanningSubmitting] = useState(false);
	const [dismissedTerminalFailureKey, setDismissedTerminalFailureKey] = useState<string | null>(null);
	const active = activeChatRun(runtime.state.run);
	const sandbox = useSessionSandbox({ sessionId, session: item?.session, refreshSessions: refresh,
		refreshTerminal: terminalMode.refresh, disabled: active || runtime.submitting || runtime.compacting || autoAuditPending || planningSubmitting || deployment.busy || terminalMode.loading || terminalMode.mutating || terminalMode.status?.transitionInProgress === true });
	const showActivity = waitingForChatResponse(runtime.state, runtime.loading, runtime.submitting);
	const autoAuditChecked = autoAuditOverride ?? item?.session.autoAudit ?? false;
	const terminalActive = terminalMode.status?.terminal?.status === "active";
	const backendTerminalTransition = terminalMode.status?.transitionInProgress
		? terminalMode.status.terminal?.status === "opening" ? "connecting" : "disconnecting"
		: null;
	const terminalTransition = terminalMode.transition ?? backendTerminalTransition;
	const terminalFailure = terminalOpenFailureFromStatus(terminalMode.status, terminalMode.openError);
	const visibleTerminalFailure = terminalTransition === null && terminalFailure &&
		(terminalFailure.key === null || terminalFailure.key !== dismissedTerminalFailureKey) ? terminalFailure : null;
	const terminalPresent = terminalActive || terminalTransition !== null || visibleTerminalFailure !== null;
	const terminalExpanded = terminalActive || (terminalTransition !== null && terminalTransition !== "exiting") || visibleTerminalFailure !== null;
	const terminalDisabledReason = sandbox.pending
		? intl.formatMessage({ id: "session.sandbox.changing" })
		: active
		? intl.formatMessage({ id: "terminal.disabled.runActive" })
		: terminalMode.loading
			? intl.formatMessage({ id: "terminal.disabled.loading" })
			: terminalTransition === "connecting"
				? intl.formatMessage({ id: "terminal.disabled.connecting" })
				: terminalTransition === "disconnecting"
					? intl.formatMessage({ id: "terminal.disabled.disconnecting" })
					: terminalTransition === "disconnected" || terminalTransition === "exiting"
						? intl.formatMessage({ id: "terminal.disabled.exiting" })
						: terminalMode.status === null
							? intl.formatMessage({ id: "terminal.disabled.unavailable" })
							: undefined;
	const terminalStatus = terminalTransition === "connecting"
		? { label: intl.formatMessage({ id: "terminal.status.starting" }), tone: "pending" as const }
		: terminalTransition === "disconnecting" || terminalTransition === "disconnected" || terminalTransition === "exiting"
			? { label: intl.formatMessage({ id: "terminal.status.closing" }), tone: "pending" as const }
			: terminalMode.loading
				? { label: intl.formatMessage({ id: "terminal.status.detecting" }), tone: "pending" as const }
				: terminalMode.status === null
					? { label: intl.formatMessage({ id: "terminal.status.unavailable" }), tone: "inactive" as const }
					: terminalActive
						? { label: intl.formatMessage({ id: "terminal.status.started" }), tone: "active" as const }
						: { label: intl.formatMessage({ id: "terminal.status.stopped" }), tone: "inactive" as const };
	const compactionDisabledReason = sandbox.pending
		? intl.formatMessage({ id: "session.sandbox.changing" })
		: runtime.loading
		? intl.formatMessage({ id: "chat.compaction.disabled.loading" })
		: active
			? intl.formatMessage({ id: "chat.compaction.disabled.activeRun" })
			: runtime.compacting
				? intl.formatMessage({ id: "chat.compaction.inProgress" })
				: undefined;
	const composerTools: readonly ChatComposerTool[] = [
		...sandbox.tools,
		{
			id: "deploy",
			icon: "deploy",
			name: intl.formatMessage({ id: "deploy.tool.name" }),
			description: intl.formatMessage({ id: "deploy.tool.description" }),
			keywords: ["deploy", "部署", "发布", "流水线"],
			...(deployment.activeDiscussion ? { status: { label: intl.formatMessage({ id: "deploy.discussion.status" }), tone: "active" as const } } : {}),
			disabled: active || deployment.busy || sandbox.pending,
		},
		{
			id: "terminal",
			icon: "terminal",
			name: "Terminal Mode",
			description: intl.formatMessage({ id: terminalActive ? "terminal.tool.close.description" : "terminal.tool.open.description" }),
			keywords: ["terminal", "terminal mode", "终端", "pty"],
			status: terminalStatus,
			disabled: terminalDisabledReason !== undefined,
			disabledReason: terminalDisabledReason,
		},
		{
			id: "compact",
			icon: "compact",
			name: intl.formatMessage({ id: "chat.compaction.tool.name" }),
			description: intl.formatMessage({ id: "chat.compaction.tool.description" }),
			keywords: ["compact", "compaction", "context", "压缩", "上下文"],
			...(runtime.compacting ? { status: { label: intl.formatMessage({ id: "chat.compaction.inProgress" }), tone: "pending" as const } } : {}),
			disabled: compactionDisabledReason !== undefined,
			disabledReason: compactionDisabledReason,
		},
	];
	const pendingQueue = useMemo(
		() => Object.values(runtime.state.queue)
			.filter((entry) => entry.status === "pending")
			.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0)),
		[runtime.state.queue],
	);
	const pendingDecision = useMemo(() => Object.values(runtime.state.decisions)
		.filter((decision) => decision.status === "pending" && decision.runId === runtime.state.run?.id)
		.sort((left, right) => left.createdAt - right.createdAt)[0], [runtime.state.decisions, runtime.state.run?.id]);
	const latestUserText = useMemo(() => {
		const message = runtime.state.timeline.findLast((entry) => entry.message.role === "user")?.message;
		if (!message || message.role !== "user") return "";
		return typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
	}, [runtime.state.timeline]);

	useEffect(() => {
		planningRequestRef.current = null;
		setPlanningSubmitting(false);
		initialScrollCompleteRef.current = false;
		followNewContentRef.current = true;
		historyScrollRestoreRef.current = null;
		setShowReturnToBottom(false);
		setHiddenDecisionId(null);
		setDismissedTerminalFailureKey(null);
		scrolledDeploymentRef.current = null;
	}, [sessionId]);

	useLayoutEffect(() => {
		const restore = historyScrollRestoreRef.current;
		const container = scrollRef.current;
		if (!restore || !container) return;
		container.scrollTop = restore.scrollTop + container.scrollHeight - restore.scrollHeight;
	}, [deployment.history.length, runtime.state.timeline]);

	useEffect(() => {
		if (!runtime.loadingOlderMessages && !deployment.loadingOlderHistory) historyScrollRestoreRef.current = null;
	}, [deployment.loadingOlderHistory, runtime.loadingOlderMessages]);

	useEffect(() => {
		const container = scrollRef.current;
		if (!container) return;
		if (!runtime.loading && !initialScrollCompleteRef.current) {
			container.scrollTo({ top: container.scrollHeight });
			initialScrollCompleteRef.current = true;
			followNewContentRef.current = true;
			setShowReturnToBottom(false);
			return;
		}
		if (followNewContentRef.current) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
	}, [runtime.loading, runtime.state.timeline, showActivity]);

	useLayoutEffect(() => {
		if (!deployment.open) { scrolledDeploymentRef.current = null; return; }
		const selectedId = deployment.run?.id;
		const discussionId = selectedId ? null : deployment.selectedDiscussion?.id;
		const selectionKey = selectedId ? `run:${selectedId}` : discussionId ? `discussion:${discussionId}` : `new-plan:${deployment.freshOpenRevision}`;
		if (scrolledDeploymentRef.current === selectionKey) return;
		const frame = requestAnimationFrame(() => {
			const container = scrollRef.current;
			if (!container) return;
			const selected = selectedId
				? [...container.querySelectorAll<HTMLElement>("[data-deployment-id]")].find((node) => node.dataset.deploymentId === selectedId)
				: discussionId ? [...container.querySelectorAll<HTMLElement>("[data-deployment-discussion-id]")].find((node) => node.dataset.deploymentDiscussionId === discussionId) : null;
			if (selected) {
				selected.scrollIntoView({ block: "nearest" });
				scrolledDeploymentRef.current = selectionKey;
			} else {
				container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
				if (!selectedId && !discussionId) scrolledDeploymentRef.current = selectionKey;
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [deployment.freshOpenRevision, deployment.history.length, deployment.open, deployment.run?.id, deployment.selectedDiscussion?.id]);

	const handleChatScroll = useCallback(() => {
		const container = scrollRef.current;
		if (!container) return;
		const behavior = chatScrollBehavior(container);
		followNewContentRef.current = behavior.followNewContent;
		setShowReturnToBottom(behavior.showReturnToBottom);
		if (isNearChatHistoryTop(container.scrollTop) && runtime.hasOlderMessages && !runtime.loadingOlderMessages) {
			historyScrollRestoreRef.current = { scrollHeight: container.scrollHeight, scrollTop: container.scrollTop };
			void runtime.loadOlderMessages().then((loaded) => {
				if (!loaded) historyScrollRestoreRef.current = null;
			});
		}
	}, [runtime.hasOlderMessages, runtime.loadOlderMessages, runtime.loadingOlderMessages]);

	const scrollToBottom = () => {
		const container = scrollRef.current;
		if (!container) return;
		followNewContentRef.current = true;
		setShowReturnToBottom(false);
		container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
	};
	const loadOlderDeployments = () => {
		const container = scrollRef.current;
		if (container) historyScrollRestoreRef.current = { scrollHeight: container.scrollHeight, scrollTop: container.scrollTop };
		void deployment.loadOlderHistory().then((loaded) => {
			if (!loaded) historyScrollRestoreRef.current = null;
		});
	};

	const submit = useCallback(async (message: string, attachments: SessionAttachment[]): Promise<boolean> => {
		const localResult = await sandbox.execute(message, attachments.length > 0);
		if (localResult !== null) return localResult;
		if (sandbox.pending) return false;
		if (terminalMode.loading || terminalMode.status?.transitionInProgress || runtime.submitting) return false;
		if (!active && !model) return false;
		try {
			const run = await runtime.submit({
				message,
				attachments,
				model,
				thinkingLevel,
				behavior: "follow_up",
				serverInteractionMode: terminalMode.status?.effectiveServerInteractionMode ?? "command",
				...(deployment.activeDiscussion ? { workflow: "deployment_planning" as const, deploymentDiscussionId: deployment.activeDiscussion.id } : {}),
				...(!deployment.activeDiscussion && deployment.open && !deployment.readOnly && deployment.run?.status === "recovering" &&
					deployment.run.recoveries?.at(-1)?.status !== "approved" && deployment.run.recoveries?.at(-1)?.status !== "pending"
					? { workflow: "deployment_recovery" as const, deploymentRunId: deployment.run.id } : {}),
			});
			if (run) modelSelection.selectThinkingLevel(run.thinkingLevel);
			return true;
		} catch (requestError) {
			if (requestError instanceof ApiError && requestError.code === "chat_thinking_level_unsupported" && model) {
				try {
					const refreshedModel = await resolveConfiguredModel({ providerId: model.providerId, modelId: model.id });
					if (refreshedModel) {
						modelSelection.selectModel(refreshedModel);
						modelSelection.selectThinkingLevel(thinkingLevelForModel(refreshedModel, thinkingLevel));
					}
				} catch {
					// Keep the original Run error visible when catalog recovery also fails.
				}
			}
			return false;
		}
	}, [active, deployment.activeDiscussion, deployment.open, deployment.readOnly, deployment.run, model, modelSelection.selectModel, modelSelection.selectThinkingLevel, runtime.submit, runtime.submitting, sandbox.execute, sandbox.pending, terminalMode.loading, terminalMode.status?.effectiveServerInteractionMode, terminalMode.status?.transitionInProgress, thinkingLevel]);

	const updateAutoAudit = async (checked: boolean) => {
		if (!item || active || autoAuditPending || sandbox.pending) return;
		setAutoAuditOverride(checked);
		setAutoAuditPending(true);
		setAutoAuditError(null);
		try {
			await sessionApi.update(sessionId, { autoAudit: checked, expectedRevision: item.session.revision });
			await refresh();
		} catch (requestError) {
			setAutoAuditError(requestError);
			await refresh().catch(() => undefined);
		} finally {
			setAutoAuditOverride(null);
			setAutoAuditPending(false);
		}
	};

	const selectComposerTool = useCallback((toolId: string) => {
		if (toolId === "sandbox") { void sandbox.execute("/sandbox"); return; }
		if (sandbox.pending) return;
		if (toolId === "deploy" && !active && !deployment.busy) { void deployment.show(); return; }
		if (toolId === "terminal" && terminalDisabledReason === undefined) {
			void (terminalActive ? terminalMode.close() : terminalMode.open());
			return;
		}
		if (toolId === "compact" && compactionDisabledReason === undefined) void runtime.compact();
	}, [active, compactionDisabledReason, deployment, runtime.compact, sandbox.execute, sandbox.pending, terminalActive, terminalDisabledReason, terminalMode.close, terminalMode.open]);

	const requestBubblewrapInstallation = useCallback(async () => {
		if (!model || active || sandbox.pending || runtime.submitting || terminalMode.status?.effectiveServerInteractionMode !== "command") return;
		try {
			const run = await runtime.submit({ message: intl.formatMessage({ id: "terminal.openFailure.installPrompt" }),
				attachments: [], model, thinkingLevel, behavior: "follow_up", serverInteractionMode: "command" });
			if (run && terminalFailure?.key) setDismissedTerminalFailureKey(terminalFailure.key);
		} catch { /* Chat composer shows the Run creation error. */ }
	}, [active, intl, model, sandbox.pending, runtime.submit, runtime.submitting, terminalFailure?.key,
		terminalMode.status?.effectiveServerInteractionMode, thinkingLevel]);

	const startDeploymentSetup = useCallback(async () => {
		if (!model || active || sandbox.pending) return;
		const run = await runtime.submit({
			message: "请根据当前项目为这个 Workspace 的 SSH 主机创建 Gori deployment profile。使用 ask_user_decision 确认所有无法可靠推断的信息；只保存配置，不执行部署。",
			attachments: [], model, thinkingLevel, behavior: "follow_up",
			serverInteractionMode: terminalMode.status?.effectiveServerInteractionMode ?? "command",
			workflow: "deployment_setup",
		});
		if (run) deployment.hide();
	}, [active, deployment, model, sandbox.pending, runtime.submit, terminalMode.status?.effectiveServerInteractionMode, thinkingLevel]);

	const startDeploymentDiscussion = useCallback(async (profileFile: string, moduleId: string) => {
		if (!model || active || sandbox.pending || runtime.submitting || planningRequestRef.current) return;
		const request = { sessionId };
		planningRequestRef.current = request;
		setPlanningSubmitting(true);
		try {
			const discussion = await deployment.beginDiscussion(profileFile, moduleId);
			if (!discussion || planningRequestRef.current !== request) return;
			const run = await runtime.submit({
				message: intl.formatMessage({ id: "deploy.planning.prompt" }),
				attachments: [], model, thinkingLevel, behavior: "follow_up",
				serverInteractionMode: terminalMode.status?.effectiveServerInteractionMode ?? "command",
				workflow: "deployment_planning", deploymentDiscussionId: discussion.id,
			});
			if (!run) throw new Error(intl.formatMessage({ id: "deploy.planning.notStarted" }));
		} catch (error) {
			if (planningRequestRef.current === request) deployment.setError(error instanceof Error ? error.message : String(error));
		} finally {
			if (planningRequestRef.current === request) {
				planningRequestRef.current = null;
				setPlanningSubmitting(false);
			}
		}
	}, [active, deployment, intl, model, sandbox.pending, runtime.submit, runtime.submitting, sessionId, terminalMode.status?.effectiveServerInteractionMode, thinkingLevel]);

	const startDeploymentExecution = useCallback(async () => {
		const plan = deployment.run;
		if (!plan || (plan.status !== "preparing" && !(plan.status === "recovering" && plan.recoveries?.at(-1)?.status === "approved")) || !model || active || sandbox.pending || runtime.submitting) return;
		deployment.setError(null);
		try {
			const run = await runtime.submit({
				message: plan.status === "recovering" ? "请继续已确认修订的部署，从待执行阶段开始；若再次失败，先分析并提出修复方案。"
					: "请执行我刚确认的部署计划。每一阶段后检查结果并决定下一步；出现异常时先分析并提出修复方案。",
				attachments: [], model, thinkingLevel, behavior: "follow_up",
				serverInteractionMode: terminalMode.status?.effectiveServerInteractionMode ?? "command",
				workflow: "deployment_execution", deploymentRunId: plan.id,
			});
			if (run) await deployment.refresh();
		} catch (error) { deployment.setError(error instanceof Error ? error.message : String(error)); }
	}, [active, deployment, model, sandbox.pending, runtime.submit, runtime.submitting, terminalMode.status?.effectiveServerInteractionMode, thinkingLevel]);

	const startDeploymentRecovery = useCallback(async () => {
		const plan = deployment.run;
		if (!plan || plan.status !== "recovering" || plan.recoveries?.at(-1)?.status === "approved" ||
			plan.recoveries?.at(-1)?.status === "pending" || !model || active || sandbox.pending || runtime.submitting) return;
		deployment.setError(null);
		try {
			await runtime.submit({
				message: intl.formatMessage({ id: "deploy.recovery.prompt" }), attachments: [], model, thinkingLevel,
				behavior: "follow_up", serverInteractionMode: terminalMode.status?.effectiveServerInteractionMode ?? "command",
				workflow: "deployment_recovery", deploymentRunId: plan.id,
			});
		} catch (error) { deployment.setError(error instanceof Error ? error.message : String(error)); }
	}, [active, deployment, intl, model, sandbox.pending, runtime.submit, runtime.submitting, terminalMode.status?.effectiveServerInteractionMode, thinkingLevel]);

	const resolveApproval = useCallback((approval: ToolApproval, approved: boolean) => {
		void runtime.resolveApproval(approval, approved);
	}, [runtime.resolveApproval]);
	const restoreDraft = useCallback((message: string) => composerRef.current?.restoreDraft(message), []);
	const cancelQueued = useCallback((id: string) => { void runtime.cancelQueued(id); }, [runtime.cancelQueued]);
	const promoteQueued = useCallback((id: string) => { void runtime.promoteQueued(id); }, [runtime.promoteQueued]);
	const cancelRun = useCallback(() => { void runtime.cancel(); }, [runtime.cancel]);
	const decisionPanel = pendingDecision ? <>
		{hiddenDecisionId === pendingDecision.id ? <button ref={decisionReopenRef} type="button" onClick={() => setHiddenDecisionId(null)} className="absolute inset-x-0 bottom-[calc(100%+10px)] z-30 flex w-full items-center justify-between rounded-xl border border-[var(--accent-line)] bg-surface-raised px-4 py-2.5 text-left text-xs font-medium text-accent shadow-[var(--shadow-soft)] transition hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"><span>{intl.formatMessage({ id: "chat.decision.reopen" })}</span><ChevronUp size={16} aria-hidden="true" /></button> : null}
		<UserDecisionPanel key={pendingDecision.id} decision={pendingDecision} open={hiddenDecisionId !== pendingDecision.id} busy={runtime.decisionMutationId === pendingDecision.id} error={runtime.error} onClose={() => {
			setHiddenDecisionId(pendingDecision.id);
			requestAnimationFrame(() => decisionReopenRef.current?.focus());
		}} onSubmit={(answers) => runtime.answerDecision(pendingDecision, answers)} />
	</> : null;
	const planning = planningSubmitting || Boolean(deployment.selectedDiscussion?.status === "discussing" && active);
	const deploymentPanel = (activity?: ReactNode) => deployment.open ? <DeploymentPanel
		key={deployment.run ? `run:${deployment.run.id}` : `new-plan:${deployment.freshOpenRevision}`}
		discovery={deployment.discovery} discussion={deployment.selectedDiscussion} run={deployment.run} loading={deployment.loading} busy={deployment.busy} planning={planning}
		activity={activity}
		canSetup={model !== null && !active && !runtime.submitting && !sandbox.pending}
		canPlan={model !== null && !active && !runtime.submitting && !sandbox.pending && !planningSubmitting}
		planHint={model === null ? intl.formatMessage({ id: "deploy.selectModelPlanning" }) : undefined}
		canConfirm={model !== null && !active && !runtime.submitting && !sandbox.pending}
		canRecover={model !== null && !active && !runtime.submitting && !sandbox.pending}
		readOnly={deployment.readOnly}
		error={deployment.error} onClose={deployment.hide} onPlan={(file, moduleId) => { void startDeploymentDiscussion(file, moduleId); }}
		onConfirm={() => { void startDeploymentExecution(); }} onDecideFullAccess={(stage, approvalId, approved) => { void deployment.decideFullAccess(stage, approvalId, approved); }} onCancel={() => { void deployment.cancel(); }}
		onDiscussRecovery={() => { void startDeploymentRecovery(); }} onDecideRecovery={(proposalId, approved) => { void deployment.decideRecovery(proposalId, approved); }}
		onNewPlan={deployment.clearRun} onCancelDiscussion={() => { void deployment.cancelDiscussion(); }} onRefresh={() => { void deployment.refresh(); }} onSetup={() => { void startDeploymentSetup(); }}
	/> : null;
	const expandedDeploymentId = deployment.open && deployment.run && deployment.history.some((run) => run.id === deployment.run?.id)
		? deployment.run.id : null;
	const inlineDiscussion = deployment.open && !deployment.run ? deployment.selectedDiscussion : null;

	if (treeLoading && tree === null) return <div className="grid h-dvh place-items-center text-sm text-zinc-400">{intl.formatMessage({ id: "session.loading" })}</div>;
	if (!item) return <div className="grid h-dvh place-items-center text-sm text-zinc-500">{intl.formatMessage({ id: "session.notFound" })}</div>;
	const sshHostname = item.workspace.host.hostname.includes(":") ? `[${item.workspace.host.hostname}]` : item.workspace.host.hostname;
	const targetHost = `${sshHostname}:${item.workspace.host.port}`;

	return (
		<div className="app-layout">
			<WorkspaceSidebar activeWorkspaceId={item.workspace.id} activeSessionId={item.session.id} />
			<main
				className={`session-console page-main page-main-chat ${terminalPresent ? "session-console-terminal-present" : ""} ${terminalExpanded ? "session-console-terminal-active" : ""}`}
				style={{ "--terminal-panel-width": TERMINAL_UI_DEFAULTS.sidePanelWidth, "--terminal-panel-transition-ms": `${TERMINAL_UI_DEFAULTS.panelTransitionMs}ms` } as CSSProperties}
			>
				<div className="session-console-header min-w-0">
					<ChatPageHeader title={item.session.displayName} sandboxEnabled={sandbox.enabled} active={active} runStatus={runtime.state.run?.status} connection={runtime.state.connection} queueCount={pendingQueue.length} />
					<SessionSandboxStatus pending={sandbox.pending} label={sandbox.statusLabel} error={sandbox.error} notice={sandbox.notice} onDismiss={sandbox.clearNotice} />
					{terminalMode.error && !visibleTerminalFailure ? <button type="button" className="w-full border-b border-rose-200 bg-rose-50 px-4 py-2 text-left text-xs text-rose-700" onClick={() => terminalMode.setError(null)}>{terminalMode.error}</button> : null}
					<TerminalSandboxNotice sandbox={terminalActive ? terminalMode.status?.terminal?.sandbox : null} />
				</div>
				{terminalActive && !sandbox.pending && terminalMode.transition === null && terminalMode.status ? <TerminalPanel sessionId={sessionId} status={terminalMode.status} onTerminalStateChange={terminalMode.refresh} /> : null}
				{terminalPresent && terminalTransition ? <TerminalConnectionState phase={terminalTransition} /> : null}
				{visibleTerminalFailure ? <TerminalOpenFailure failure={visibleTerminalFailure}
					canRetry={terminalDisabledReason === undefined}
					canRequestInstallation={Boolean(model && !active && !runtime.submitting && !sandbox.pending && terminalMode.status?.effectiveServerInteractionMode === "command")}
					onRetry={() => { setDismissedTerminalFailureKey(null); void terminalMode.open(); }}
					onRequestInstallation={() => { void requestBubblewrapInstallation(); }}
					onDismiss={() => { if (visibleTerminalFailure.key) setDismissedTerminalFailureKey(visibleTerminalFailure.key); else terminalMode.setOpenError(null); }}
				/> : null}

				<div className="session-console-chat relative min-h-0">
					<div ref={scrollRef} className="app-scrollbar h-full overflow-y-auto" onScroll={handleChatScroll}>
						<ChatTimeline showActivity={showActivity} loading={runtime.loading} loadingOlderMessages={runtime.loadingOlderMessages} timeline={runtime.state.timeline} tools={runtime.state.tools} approvals={runtime.state.approvals} approvalMutationId={runtime.approvalMutationId} targetHost={targetHost} run={runtime.state.run} latestUserText={latestUserText} onResolveApproval={resolveApproval} onRestoreDraft={restoreDraft}
							deployments={deployment.history} discussion={inlineDiscussion} discussionPanel={inlineDiscussion ? deploymentPanel() : null} expandedDeploymentId={expandedDeploymentId} expandedDeployment={deploymentPanel} onOpenDeployment={(id) => { void deployment.openHistory(id); }}
							hasOlderMessages={runtime.hasOlderMessages}
							hasOlderDeployments={deployment.hasOlderHistory} loadingOlderDeployments={deployment.loadingOlderHistory} onLoadOlderDeployments={loadOlderDeployments} />
						{deployment.open && !expandedDeploymentId && !inlineDiscussion ? <div className="mx-auto max-w-[820px] px-5 pb-10 lg:px-8">{deploymentPanel()}</div> : null}
					</div>
					{showReturnToBottom ? <button type="button" className="absolute bottom-3 left-1/2 z-10 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-zinc-200 bg-white text-zinc-700 shadow-[0_6px_20px_rgb(24_24_27/12%)] transition hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7aa48e]/40" aria-label={intl.formatMessage({ id: "chat.scroll.latest" })} title={intl.formatMessage({ id: "chat.scroll.latest" })} onClick={scrollToBottom}><ArrowDown size={16} /></button> : null}
				</div>

				<ChatComposerPanel
					ref={composerRef}
					contextUsage={runtime.contextUsage}
					sessionId={item.session.id}
					active={active}
					model={model}
					thinkingLevel={thinkingLevel}
					modelSelectionLoading={modelSelectionLoading}
					modelSelectionError={modelSelectionError}
					modelSelectionRetryable={modelSelection.errorRetryable}
					modelLabel={active ? runtime.state.run?.modelId : undefined}
					onRetryModelSelection={modelSelection.retry}
					onSelectModel={modelSelection.selectModel}
					onSelectThinkingLevel={modelSelection.selectThinkingLevel}
					composerTools={composerTools}
					onToolSelect={selectComposerTool}
					submitting={runtime.submitting || sandbox.pending}
					cancelling={runtime.cancelling}
					terminalBusy={terminalMode.loading || terminalMode.status?.transitionInProgress === true}
					onSubmit={submit}
					isLocalCommand={isSessionSandboxCommand}
					onCancel={cancelRun}
					autoAuditChecked={autoAuditChecked}
					autoAuditPending={autoAuditPending || sandbox.pending}
					autoAuditError={autoAuditError}
					onClearAutoAuditError={() => setAutoAuditError(null)}
					onUpdateAutoAudit={(checked) => void updateAutoAudit(checked)}
					runtimeError={runtime.error}
					onClearRuntimeError={() => runtime.setError(null)}
					manualCompactionResult={runtime.manualCompactionResult}
					compacting={runtime.compacting}
					onClearManualCompactionResult={runtime.clearManualCompactionResult}
					queue={pendingQueue}
					queueMutationId={runtime.queueMutationId}
					onCancelQueued={cancelQueued}
					onPromoteQueued={promoteQueued}
					decisionPanel={decisionPanel}
				/>
			</main>
		</div>
	);
}
