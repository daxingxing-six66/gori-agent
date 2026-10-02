"use client";

import { ArrowDown, ChevronUp } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { TerminalConnectionState } from "@/features/terminal/components/terminal-connection-state";
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
	const active = activeChatRun(runtime.state.run);
	const showActivity = waitingForChatResponse(runtime.state, runtime.loading, runtime.submitting);
	const autoAuditChecked = autoAuditOverride ?? item?.session.autoAudit ?? false;
	const terminalActive = terminalMode.status?.terminal?.status === "active";
	const backendTerminalTransition = terminalMode.status?.transitionInProgress
		? terminalMode.status.terminal?.status === "opening" ? "connecting" : "disconnecting"
		: null;
	const terminalTransition = terminalMode.transition ?? backendTerminalTransition;
	const terminalPresent = terminalActive || terminalTransition !== null;
	const terminalExpanded = terminalActive || (terminalTransition !== null && terminalTransition !== "exiting");
	const terminalDisabledReason = active
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
	const compactionDisabledReason = runtime.loading
		? intl.formatMessage({ id: "chat.compaction.disabled.loading" })
		: active
			? intl.formatMessage({ id: "chat.compaction.disabled.activeRun" })
			: runtime.compacting
				? intl.formatMessage({ id: "chat.compaction.inProgress" })
				: undefined;
	const composerTools: readonly ChatComposerTool[] = [
		{
			id: "deploy",
			icon: "deploy",
			name: "/deploy",
			description: intl.formatMessage({ id: "deploy.tool.description" }),
			keywords: ["deploy", "部署", "发布", "流水线"],
			disabled: active || deployment.busy,
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
		initialScrollCompleteRef.current = false;
		followNewContentRef.current = true;
		historyScrollRestoreRef.current = null;
		setShowReturnToBottom(false);
		setHiddenDecisionId(null);
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
		const selectionKey = selectedId ?? "new-plan";
		if (scrolledDeploymentRef.current === selectionKey) return;
		const frame = requestAnimationFrame(() => {
			const container = scrollRef.current;
			if (!container) return;
			const selected = selectedId
				? [...container.querySelectorAll<HTMLElement>("[data-deployment-id]")].find((node) => node.dataset.deploymentId === selectedId)
				: null;
			if (selected) {
				selected.scrollIntoView({ block: "nearest" });
				scrolledDeploymentRef.current = selectionKey;
			} else {
				container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
				if (!selectedId) scrolledDeploymentRef.current = selectionKey;
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [deployment.history.length, deployment.open, deployment.run?.id]);

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
	}, [active, model, modelSelection.selectModel, modelSelection.selectThinkingLevel, runtime.submit, runtime.submitting, terminalMode.loading, terminalMode.status?.effectiveServerInteractionMode, terminalMode.status?.transitionInProgress, thinkingLevel]);

	const updateAutoAudit = async (checked: boolean) => {
		if (!item || active || autoAuditPending) return;
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
		if (toolId === "deploy" && !active && !deployment.busy) { void deployment.show(); return; }
		if (toolId === "terminal" && terminalDisabledReason === undefined) {
			void (terminalActive ? terminalMode.close() : terminalMode.open());
			return;
		}
		if (toolId === "compact" && compactionDisabledReason === undefined) void runtime.compact();
	}, [active, compactionDisabledReason, deployment, runtime.compact, terminalActive, terminalDisabledReason, terminalMode.close, terminalMode.open]);

	const startDeploymentSetup = useCallback(async () => {
		if (!model || active) return;
		const run = await runtime.submit({
			message: "请根据当前项目为这个 Workspace 的 SSH 主机创建 Gori deployment profile。使用 ask_user_decision 确认所有无法可靠推断的信息；只保存配置，不执行部署。",
			attachments: [], model, thinkingLevel, behavior: "follow_up",
			serverInteractionMode: terminalMode.status?.effectiveServerInteractionMode ?? "command",
			workflow: "deployment_setup",
		});
		if (run) deployment.hide();
	}, [active, deployment, model, runtime.submit, terminalMode.status?.effectiveServerInteractionMode, thinkingLevel]);

	const startDeploymentExecution = useCallback(async () => {
		const plan = deployment.run;
		if (!plan || plan.status !== "preparing" || !model || active || runtime.submitting) return;
		deployment.setError(null);
		try {
			const run = await runtime.submit({
				message: "请执行我刚确认的部署计划。每一阶段后检查结果并决定下一步；出现异常时先分析，不要擅自重试或修改目标。",
				attachments: [], model, thinkingLevel, behavior: "follow_up",
				serverInteractionMode: terminalMode.status?.effectiveServerInteractionMode ?? "command",
				workflow: "deployment_execution", deploymentRunId: plan.id,
			});
			if (run) await deployment.refresh();
		} catch (error) { deployment.setError(error instanceof Error ? error.message : String(error)); }
	}, [active, deployment, model, runtime.submit, runtime.submitting, terminalMode.status?.effectiveServerInteractionMode, thinkingLevel]);

	const resolveApproval = useCallback((approval: ToolApproval, approved: boolean) => {
		void runtime.resolveApproval(approval, approved);
	}, [runtime.resolveApproval]);
	const restoreDraft = useCallback((message: string) => composerRef.current?.restoreDraft(message), []);
	const cancelQueued = useCallback((id: string) => { void runtime.cancelQueued(id); }, [runtime.cancelQueued]);
	const promoteQueued = useCallback((id: string) => { void runtime.promoteQueued(id); }, [runtime.promoteQueued]);
	const cancelRun = useCallback(() => { void runtime.cancel(); }, [runtime.cancel]);
	const decisionPanel = pendingDecision ? <>
		{hiddenDecisionId === pendingDecision.id ? <button ref={decisionReopenRef} type="button" onClick={() => setHiddenDecisionId(null)} className="absolute inset-x-0 bottom-[calc(100%+12px)] z-30 flex w-full items-center justify-between rounded-xl border border-emerald-200 bg-white px-4 py-2.5 text-left text-xs font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"><span>{intl.formatMessage({ id: "chat.decision.reopen" })}</span><ChevronUp size={16} aria-hidden="true" /></button> : null}
		<UserDecisionPanel key={pendingDecision.id} decision={pendingDecision} open={hiddenDecisionId !== pendingDecision.id} busy={runtime.decisionMutationId === pendingDecision.id} error={runtime.error} onClose={() => {
			setHiddenDecisionId(pendingDecision.id);
			requestAnimationFrame(() => decisionReopenRef.current?.focus());
		}} onSubmit={(answers) => runtime.answerDecision(pendingDecision, answers)} />
	</> : null;
	const deploymentPanel = deployment.open ? <DeploymentPanel
		discovery={deployment.discovery} run={deployment.run} loading={deployment.loading} busy={deployment.busy}
		canSetup={model !== null && !active && !runtime.submitting}
		canConfirm={model !== null && !active && !runtime.submitting}
		readOnly={deployment.readOnly}
		error={deployment.error} onClose={deployment.hide} onPrepare={(file, moduleId) => { void deployment.prepare(file, moduleId); }}
		onConfirm={() => { void startDeploymentExecution(); }} onDecideFullAccess={(stage, approvalId, approved) => { void deployment.decideFullAccess(stage, approvalId, approved); }} onCancel={() => { void deployment.cancel(); }}
		onNewPlan={deployment.clearRun} onSetup={() => { void startDeploymentSetup(); }}
	/> : null;
	const expandedDeploymentId = deployment.open && deployment.run && deployment.history.some((run) => run.id === deployment.run?.id)
		? deployment.run.id : null;

	if (treeLoading && tree === null) return <div className="grid h-dvh place-items-center text-sm text-zinc-400">{intl.formatMessage({ id: "session.loading" })}</div>;
	if (!item) return <div className="grid h-dvh place-items-center text-sm text-zinc-500">{intl.formatMessage({ id: "session.notFound" })}</div>;

	return (
		<div className="flex h-dvh min-h-[640px] overflow-hidden bg-[var(--canvas)]">
			<WorkspaceSidebar activeWorkspaceId={item.workspace.id} activeSessionId={item.session.id} />
			<main
				className={`session-console min-w-0 flex-1 bg-[var(--panel)] ${terminalPresent ? "session-console-terminal-present" : ""} ${terminalExpanded ? "session-console-terminal-active" : ""}`}
				style={{ "--terminal-panel-width": TERMINAL_UI_DEFAULTS.sidePanelWidth, "--terminal-panel-transition-ms": `${TERMINAL_UI_DEFAULTS.panelTransitionMs}ms` } as CSSProperties}
			>
				<div className="session-console-header min-w-0">
					<header className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--line-soft)] bg-white/90 px-6 backdrop-blur-xl">
						<div className="min-w-0"><h1 className="truncate text-[13px] font-semibold tracking-[-0.01em]">{item.session.displayName}</h1><p className="mt-0.5 truncate text-[10px] text-zinc-400">{item.workspace.displayName} · local {item.session.workDir ?? intl.formatMessage({ id: "session.workDir.systemDefault.short" })}</p></div>
						<ChatStatus active={active} runStatus={runtime.state.run?.status} connection={runtime.state.connection} queueCount={pendingQueue.length} />
					</header>
					{terminalMode.error ? <button type="button" className="w-full border-b border-rose-200 bg-rose-50 px-4 py-2 text-left text-[9px] text-rose-700" onClick={() => terminalMode.setError(null)}>{terminalMode.error}</button> : null}
					<TerminalSandboxNotice sandbox={terminalActive ? terminalMode.status?.terminal?.sandbox : null} />
				</div>
				{terminalActive && terminalMode.transition === null && terminalMode.status ? <TerminalPanel sessionId={sessionId} status={terminalMode.status} onTerminalStateChange={terminalMode.refresh} /> : null}
				{terminalPresent && terminalTransition ? <TerminalConnectionState phase={terminalTransition} /> : null}

				<div className="session-console-chat relative min-h-0">
					<div ref={scrollRef} className="app-scrollbar h-full overflow-y-auto" onScroll={handleChatScroll}>
						<ChatTimeline showActivity={showActivity} loading={runtime.loading} loadingOlderMessages={runtime.loadingOlderMessages} timeline={runtime.state.timeline} tools={runtime.state.tools} approvals={runtime.state.approvals} approvalMutationId={runtime.approvalMutationId} run={runtime.state.run} latestUserText={latestUserText} onResolveApproval={resolveApproval} onRestoreDraft={restoreDraft}
							deployments={deployment.history} expandedDeploymentId={expandedDeploymentId} expandedDeployment={deploymentPanel} onOpenDeployment={(id) => { void deployment.openHistory(id); }}
							hasOlderDeployments={deployment.hasOlderHistory} loadingOlderDeployments={deployment.loadingOlderHistory} onLoadOlderDeployments={loadOlderDeployments} />
						{deploymentPanel && !expandedDeploymentId ? <div className="mx-auto max-w-[820px] px-5 pb-10 lg:px-8">{deploymentPanel}</div> : null}
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
					submitting={runtime.submitting}
					cancelling={runtime.cancelling}
					terminalBusy={terminalMode.loading || terminalMode.status?.transitionInProgress === true}
					onSubmit={submit}
					onCancel={cancelRun}
					autoAuditChecked={autoAuditChecked}
					autoAuditPending={autoAuditPending}
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

function ChatStatus({ active, runStatus, connection, queueCount }: { active: boolean; runStatus?: string; connection: string; queueCount: number }) {
	const intl = useIntl();
	const reconnecting = active && connection === "reconnecting";
	const label = intl.formatMessage({ id: reconnecting ? "chat.status.reconnecting" : active ? queueCount > 0 ? "chat.status.runningQueued" : "chat.status.running" : runStatus === "failed" ? "chat.status.failed" : runStatus === "cancelled" ? "chat.status.cancelled" : "chat.status.ready" }, { count: queueCount });
	return <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[9px] font-medium ${reconnecting ? "bg-amber-50 text-amber-700" : active ? "bg-[#edf4f0] text-[#397b5c]" : runStatus === "failed" ? "bg-rose-50 text-rose-600" : "bg-zinc-100 text-zinc-500"}`}><span className={`h-1.5 w-1.5 rounded-full ${reconnecting ? "bg-amber-500" : active ? "bg-[var(--accent)]" : runStatus === "failed" ? "bg-rose-500" : "bg-zinc-300"}`} />{label}</span>;
}
