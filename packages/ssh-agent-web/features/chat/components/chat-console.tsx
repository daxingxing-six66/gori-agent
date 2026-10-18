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
import { ChatPageHeader } from "@/features/chat/components/chat-page-header";
import { SessionServerMetrics } from "@/features/server-metrics/components/session-server-metrics";
import { SessionSandboxStatus } from "@/features/session/components/session-sandbox-status";
import { isSessionSandboxCommand } from "@/features/session/model/session-sandbox-command";
import { useSessionSandbox } from "@/features/session/runtime/use-session-sandbox";
import { TerminalSandboxNotice } from "@/features/terminal/components/terminal-sandbox-notice";
import { TerminalTask } from "@/features/terminal/components/terminal-task";
import { useTerminalMode } from "@/features/terminal/runtime/use-terminal-mode";
import { useTerminalTask } from "@/features/terminal/runtime/use-terminal-task";
import { TaskContainer, type TaskTab } from "@/features/task-container/components/task-container";
import { TASK_CONTAINER_DEFAULTS } from "@/features/task-container/model/task-container-defaults";
import { useTaskContainerDisplay } from "@/features/task-container/runtime/use-task-container-display";
import { useWorkspaceTree } from "@/features/workspace/components/workspace-tree-context";
import { ApiError } from "@/shared/errors/api-error";
import { DeploymentTaskPage } from "@/features/deploy/components/deployment-task-page";
import { DeploymentFullAccessReview } from "@/features/deploy/components/deployment-full-access-review";
import { DeploymentModulePicker } from "@/features/deploy/components/deployment-module-picker";
import { useDeploymentExecution } from "@/features/deploy/runtime/use-deployment-execution";
import { useDeployment } from "@/features/deploy/runtime/use-deployment";
import { useDeploymentReview } from "@/features/deploy/runtime/use-deployment-review";
import { FileReaderPage } from "@/features/file-reader/components/file-reader-page";
import { useFileReaderTabs } from "@/features/file-reader/runtime/use-file-reader-tabs";
import "./chat-task-layout.css";

export function ChatConsole({ sessionId }: { sessionId: string }) {
	const intl = useIntl();
	const { tree, loading: treeLoading, refresh } = useWorkspaceTree();
	const item = tree?.workspaces.flatMap(({ workspace, sessions }) => sessions.map((session) => ({ session, workspace }))).find(({ session }) => session.id === sessionId);
	const runtime = useChatRuntime(sessionId);
	const terminalMode = useTerminalMode(sessionId);
	const deployment = useDeployment(sessionId, item?.workspace.id, { onHistoryMessage: runtime.receiveHistoryMessage, onHistoryResync: runtime.refreshHistory });
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
	const [showReturnToBottom, setShowReturnToBottom] = useState(false);
	const [hiddenDecisionId, setHiddenDecisionId] = useState<string | null>(null);
	const planningRequestRef = useRef<{ sessionId: string } | null>(null);
	const [planningSubmitting, setPlanningSubmitting] = useState(false);
	const [activeTaskTabId, setActiveTaskTabId] = useState<string | null>("terminal");
	const active = activeChatRun(runtime.state.run);
	const sandbox = useSessionSandbox({ sessionId, session: item?.session, refreshSessions: refresh,
		refreshTerminal: terminalMode.refresh, disabled: active || runtime.submitting || runtime.compacting || autoAuditPending || planningSubmitting || deployment.busy || terminalMode.loading || terminalMode.mutating || terminalMode.status?.transitionInProgress === true });
	const showActivity = waitingForChatResponse(runtime.state, runtime.loading, runtime.submitting);
	const autoAuditChecked = autoAuditOverride ?? item?.session.autoAudit ?? false;
	const terminalTask = useTerminalTask({ sessionId, mode: terminalMode, runActive: active,
		submitting: runtime.submitting, sandboxPending: sandbox.pending });
	const fileReader = useFileReaderTabs(sessionId, item?.session.workDir);
	const taskDisplay = useTaskContainerDisplay(sessionId, terminalTask.present || deployment.open || fileReader.documents.length > 0);
	const openFile = useCallback((path: string) => {
		setActiveTaskTabId(fileReader.open(path));
		taskDisplay.reveal();
	}, [fileReader.open, taskDisplay.reveal]);
	const terminalStatus = { label: terminalTask.label,
		tone: terminalTask.tone === "positive" ? "active" as const
			: terminalTask.tone === "warning" ? "pending" as const : "inactive" as const };
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
			...(deployment.activeTask ? { status: { label: intl.formatMessage({ id: "deploy.task.started" }), tone: "active" as const } } : {}),
			disabled: (!deployment.activeTask && (active || sandbox.readOnly)) || deployment.busy || sandbox.pending,
		},
		{
			id: "terminal",
			icon: "terminal",
			name: "Terminal Mode",
			description: intl.formatMessage({ id: terminalTask.present ? "terminal.tool.reveal.description" : "terminal.tool.open.description" }),
			keywords: ["terminal", "terminal mode", "终端", "pty"],
			status: terminalStatus,
			disabled: terminalTask.menuDisabledReason !== undefined,
			disabledReason: terminalTask.menuDisabledReason,
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
		setActiveTaskTabId("terminal");
	}, [sessionId]);

	useLayoutEffect(() => {
		const restore = historyScrollRestoreRef.current;
		const container = scrollRef.current;
		if (!restore || !container) return;
		container.scrollTop = restore.scrollTop + container.scrollHeight - restore.scrollHeight;
	}, [runtime.state.timeline]);

	useEffect(() => {
		if (!runtime.loadingOlderMessages) historyScrollRestoreRef.current = null;
	}, [runtime.loadingOlderMessages]);

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

	useEffect(() => {
		if (deployment.open) setActiveTaskTabId("deploy");
	}, [deployment.open]);

	useEffect(() => {
		if (deployment.pickerOpen) taskDisplay.changeMode("docked");
	}, [deployment.pickerOpen, taskDisplay.changeMode]);

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
	}, [active, model, modelSelection.selectModel, modelSelection.selectThinkingLevel, runtime.submit, runtime.submitting, sandbox.execute, sandbox.pending, terminalMode.loading, terminalMode.status?.effectiveServerInteractionMode, terminalMode.status?.transitionInProgress, thinkingLevel]);

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
		if (toolId === "terminal") {
			if (terminalTask.menuDisabledReason === undefined) {
				setActiveTaskTabId("terminal");
				taskDisplay.reveal();
				terminalTask.reveal();
			}
			return;
		}
		if (toolId === "sandbox") { void sandbox.execute("/sandbox"); return; }
		if (sandbox.pending) return;
		if (toolId === "deploy" && (!sandbox.readOnly || deployment.activeTask) && (!active || deployment.activeTask) && !deployment.busy) {
			if (deployment.pickerOpen) { deployment.closePicker(); composerRef.current?.focus(); return; }
			void deployment.show().then((surface) => {
				if (surface === "task") { setActiveTaskTabId("deploy"); taskDisplay.reveal(); }
			});
			return;
		}
		if (toolId === "compact" && compactionDisabledReason === undefined) void runtime.compact();
	}, [active, compactionDisabledReason, deployment, runtime.compact, sandbox.execute, sandbox.pending, sandbox.readOnly, taskDisplay.reveal, terminalTask.menuDisabledReason, terminalTask.reveal]);

	const requestBubblewrapInstallation = useCallback(async () => {
		if (!model || active || sandbox.readOnly || sandbox.pending || runtime.submitting || terminalMode.status?.effectiveServerInteractionMode !== "command") return;
		try {
			const run = await runtime.submit({ message: intl.formatMessage({ id: "terminal.openFailure.installPrompt" }),
				attachments: [], model, thinkingLevel, behavior: "follow_up", serverInteractionMode: "command" });
			if (run) terminalTask.dismiss();
		} catch { /* Chat composer shows the Run creation error. */ }
	}, [active, intl, model, sandbox.pending, sandbox.readOnly, runtime.submit, runtime.submitting, terminalTask.dismiss,
		terminalMode.status?.effectiveServerInteractionMode, thinkingLevel]);

	const startDeploymentSetup = useCallback(async () => {
		if (!model || active || sandbox.readOnly || sandbox.pending) return;
		const run = await runtime.submit({
			message: "请根据当前项目为这个 Workspace 的 SSH 主机创建 Gori deployment profile。使用 ask_user_decision 确认所有无法可靠推断的信息；只保存配置，不执行部署。",
			attachments: [], model, thinkingLevel, behavior: "follow_up",
			serverInteractionMode: terminalMode.status?.effectiveServerInteractionMode ?? "command",
			workflow: "deployment_setup",
		});
		if (run) deployment.hide();
	}, [active, deployment, model, sandbox.pending, sandbox.readOnly, runtime.submit, terminalMode.status?.effectiveServerInteractionMode, thinkingLevel]);

	const startDeploymentDiscussion = useCallback(async (profileFile: string, moduleId: string) => {
		if (!model || active || sandbox.readOnly || sandbox.pending || runtime.submitting || planningRequestRef.current) return;
		const request = { sessionId };
		planningRequestRef.current = request;
		setPlanningSubmitting(true);
		try {
			const discussion = await deployment.beginDiscussion(profileFile, moduleId);
			if (!discussion || planningRequestRef.current !== request) return;
			const run = await runtime.submit({
				message: intl.formatMessage({ id: "deploy.planning.prompt" }, { module: discussion.module.name }),
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
	}, [active, deployment, intl, model, sandbox.pending, sandbox.readOnly, runtime.submit, runtime.submitting, sessionId, terminalMode.status?.effectiveServerInteractionMode, thinkingLevel]);

	const activeDeploymentRun = deployment.activeTask?.run ?? null;
	const deploymentReview = useDeploymentReview(activeDeploymentRun);
	const execution = useDeploymentExecution({ sessionId, run: activeDeploymentRun, model, thinkingLevel,
		serverInteractionMode: terminalMode.status?.effectiveServerInteractionMode ?? "command",
		disabled: active || sandbox.readOnly || sandbox.pending || runtime.submitting || deployment.busy || Boolean(deploymentReview?.pendingExceptions.length),
		submit: runtime.submit, refresh: deployment.refresh, setError: deployment.setError });

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
	const pendingDeploymentAction = Boolean(deploymentReview?.pendingExceptions.length || pendingDecision || Object.values(runtime.state.approvals).some((approval) => approval.status === "pending"));
	const returnToConversation = () => {
		taskDisplay.changeMode("docked"); setHiddenDecisionId(null);
		requestAnimationFrame(() => {
			const target = document.querySelector<HTMLElement>(".user-decision-panel h2")
				?? scrollRef.current?.querySelector<HTMLElement>("[data-approval-id]")
				?? scrollRef.current?.querySelector<HTMLElement>("[data-deployment-review]");
			if (target) { target.scrollIntoView({ block: "nearest" }); target.focus({ preventScroll: true }); }
			else document.querySelector<HTMLElement>('.chat-composer-shell [contenteditable="true"]')?.focus();
		});
	};
	const taskTabs: TaskTab[] = terminalTask.present ? [{
		id: "terminal", title: "Terminal", status: { label: terminalTask.label, tone: terminalTask.tone },
		close: { label: intl.formatMessage({ id: "terminal.tab.close" }),
			disabled: terminalTask.operationDisabledReason !== undefined,
			disabledReason: terminalTask.operationDisabledReason,
			busy: terminalTask.transition === "disconnecting", onRequestClose: terminalTask.requestClose },
		content: <TerminalTask sessionId={sessionId} mode={terminalMode} task={terminalTask}
			canRequestInstallation={Boolean(model && !active && !runtime.submitting && !sandbox.readOnly && !sandbox.pending && terminalMode.status?.effectiveServerInteractionMode === "command")}
			onRequestInstallation={() => { void requestBubblewrapInstallation(); }} />,
	}] : [];
	if (deployment.open) taskTabs.push({ id: "deploy", title: "Deploy",
		close: { label: intl.formatMessage({ id: "deploy.task.close" }), onRequestClose: deployment.hide },
		content: <DeploymentTaskPage sessionId={sessionId} task={deployment.selectedTask} run={deployment.run} discussion={deployment.selectedDiscussion}
			logs={deployment.logs} loading={deployment.loading} busy={deployment.busy} error={deployment.error}
			fullscreen={taskDisplay.mode === "fullscreen"} pending={pendingDeploymentAction} onReturnConversation={returnToConversation}
			review={activeDeploymentRun && deploymentReview ? { runId: activeDeploymentRun.id, review: deploymentReview,
				busy: deployment.busy, starting: execution.starting, canConfirm: Boolean(model && !active && !runtime.submitting && !sandbox.readOnly && !sandbox.pending),
				onConfirm: () => { void execution.start(); }, onReviewPermissions: returnToConversation,
				onDecideRecovery: (id, approved) => { void deployment.decideRecovery(id, approved); } } : undefined}
			onExit={deployment.activeTask && deployment.activeTask.deployment.id === deployment.selectedTask?.deployment.id ? () => { void deployment.finish(); } : undefined}
			onSubmit={(message) => submit(message, [])} /> });
	for (const document of fileReader.documents) taskTabs.push({ id: document.id, title: document.name,
		close: { label: intl.formatMessage({ id: "fileReader.close" }, { name: document.name }), onRequestClose: () => fileReader.close(document.id) },
		content: <FileReaderPage key={`${sessionId}:${document.id}`} sessionId={sessionId} document={document} /> });

	if (treeLoading && tree === null) return <div className="grid h-dvh place-items-center text-sm text-zinc-400">{intl.formatMessage({ id: "session.loading" })}</div>;
	if (!item) return <div className="grid h-dvh place-items-center text-sm text-zinc-500">{intl.formatMessage({ id: "session.notFound" })}</div>;
	const sshHostname = item.workspace.host.hostname.includes(":") ? `[${item.workspace.host.hostname}]` : item.workspace.host.hostname;
	const targetHost = `${sshHostname}:${item.workspace.host.port}`;

	return (
		<div className="app-layout">
			<WorkspaceSidebar activeWorkspaceId={item.workspace.id} activeSessionId={item.session.id}
				onSessionUpdated={async (updatedId) => { if (updatedId === sessionId) await terminalMode.refresh(); }} />
			<main
				className={`session-console page-main page-main-chat ${taskTabs.length > 0 ? "session-console-tasks-present" : ""} ${(terminalTask.expanded || deployment.open || fileReader.documents.length > 0) && taskDisplay.mode === "docked" ? "session-console-tasks-active" : ""}`}
				data-task-display={taskDisplay.mode}
				data-task-container-scope
				style={{ "--task-panel-width": TASK_CONTAINER_DEFAULTS.sidePanelWidth,
					"--task-collapsed-width": TASK_CONTAINER_DEFAULTS.collapsedPanelWidth,
					"--task-panel-transition-ms": `${TASK_CONTAINER_DEFAULTS.transitionMs}ms`,
					"--terminal-panel-transition-ms": `${TASK_CONTAINER_DEFAULTS.transitionMs}ms` } as CSSProperties}
			>
				<div className="session-console-header min-w-0">
					<ChatPageHeader title={item.session.displayName} sandboxEnabled={sandbox.enabled} sandboxReadOnly={sandbox.readOnly} active={active} runStatus={runtime.state.run?.status} connection={runtime.state.connection} queueCount={pendingQueue.length}
						serverMetrics={<SessionServerMetrics workspaceId={item.workspace.id} />} />
					<SessionSandboxStatus pending={sandbox.pending} label={sandbox.statusLabel} error={sandbox.error} notice={sandbox.notice} onDismiss={sandbox.clearNotice} />
					{terminalMode.error && !terminalTask.present ? <p role="alert" className="px-4 py-2 text-xs text-danger">{terminalMode.error}</p> : null}
					<TerminalSandboxNotice sandbox={terminalTask.active ? terminalMode.status?.terminal?.sandbox : null} />
				</div>
				{taskTabs.length > 0 ? <div className="session-task-area" data-display={taskDisplay.mode}>
					<TaskContainer key={sessionId} tabs={taskTabs} activeTabId={activeTaskTabId}
						tabListLabel={intl.formatMessage({ id: "terminal.tabs.label" })} onSelect={setActiveTaskTabId}
						display={{ mode: taskDisplay.mode, onModeChange: taskDisplay.changeMode,
							fullscreenLabel: intl.formatMessage({ id: "taskContainer.fullscreen" }),
							exitFullscreenLabel: intl.formatMessage({ id: "taskContainer.exitFullscreen" }),
							collapseLabel: intl.formatMessage({ id: "taskContainer.collapse" }),
							expandLabel: intl.formatMessage({ id: "taskContainer.expand" }) }} />
				</div> : null}

				<div className="session-console-chat relative min-h-0">
					<div ref={scrollRef} className="app-scrollbar h-full overflow-y-auto" onScroll={handleChatScroll}>
						<ChatTimeline showActivity={showActivity} loading={runtime.loading} loadingOlderMessages={runtime.loadingOlderMessages} timeline={runtime.state.timeline} tools={runtime.state.tools} approvals={runtime.state.approvals} approvalMutationId={runtime.approvalMutationId} targetHost={targetHost} run={runtime.state.run} latestUserText={latestUserText} onResolveApproval={resolveApproval} onRestoreDraft={restoreDraft} onOpenFile={openFile}
							onOpenDeployment={(id) => { setActiveTaskTabId("deploy"); taskDisplay.reveal(); void deployment.openHistory(id); }} />
						{activeDeploymentRun && deploymentReview && deploymentReview.pendingExceptions.length > 0 ? <div data-deployment-review tabIndex={-1} className="mx-auto max-w-[820px] px-5 py-5 lg:px-8">
							<DeploymentFullAccessReview run={activeDeploymentRun} stages={deploymentReview.exceptionStages}
								pendingStages={deploymentReview.pendingExceptions} busy={deployment.busy}
								onDecide={(stage, id, approved) => { void deployment.decideFullAccess(stage, id, approved); }} />
						</div> : null}
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
					aboveInputPanel={deployment.pickerOpen && !pendingDecision ? <DeploymentModulePicker key={sessionId}
						discovery={deployment.discovery} loading={deployment.pickerLoading} busy={deployment.busy || planningSubmitting}
						disabled={!model || active || runtime.submitting || sandbox.readOnly || sandbox.pending} error={deployment.error}
						onSelect={startDeploymentDiscussion} onSetup={() => { void startDeploymentSetup().catch((error) => deployment.setError(error instanceof Error ? error.message : String(error))); }}
						onClose={(restoreFocus = true) => { deployment.closePicker(); if (restoreFocus) composerRef.current?.focus(); }} onRetry={() => { void deployment.show(); }} /> : undefined}
				/>
			</main>
		</div>
	);
}
