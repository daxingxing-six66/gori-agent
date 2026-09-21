"use client";

import { FolderOpen, LoaderCircle, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { ToggleSwitch } from "@/components/toggle-switch";
import { chatApi } from "@/features/chat/api/chat-api";
import { ChatTokenEditor, type ChatComposerTool, type ChatTokenEditorHandle } from "@/features/chat/components/chat-token-editor";
import { hasChatComposerContent } from "@/features/chat/model/chat-composer";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import { resolveConfiguredModel } from "@/features/llm-provider/api/llm-provider-api";
import { ModelThinkingSelector } from "@/features/llm-provider/components/model-thinking-selector";
import { thinkingLevelForModel, type LlmModel, type ThinkingLevel } from "@/features/llm-provider/model/llm-provider";
import { readLastModelSelection } from "@/features/llm-provider/model/last-model-selection";
import { sessionApi } from "@/features/session/api/session-api";
import { LocalDirectoryPicker } from "@/features/session/components/local-directory-picker";
import type { Session } from "@/features/session/model/session";
import { useWorkspaceTree } from "@/features/workspace/components/workspace-tree-context";
import { ApiError } from "@/shared/errors/api-error";

export function NewSessionChat({ workspaceId }: { workspaceId: string }) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const router = useRouter();
	const { tree, loading, error: treeError, refresh } = useWorkspaceTree();
	const workspace = tree?.workspaces.find((item) => item.workspace.id === workspaceId)?.workspace;
	const [draft, setDraft] = useState("");
	const [model, setModel] = useState<LlmModel | null>(null);
	const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
	const [autoAudit, setAutoAudit] = useState(false);
	const [selectedWorkDir, setWorkDir] = useState<string | null>(null);
	const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
	const [createdSession, setCreatedSession] = useState<Session | null>(null);
	const workDir = createdSession?.workDir ?? selectedWorkDir ?? workspace?.defaultCwd ?? "";
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const modelRestoreRef = useRef<AbortController | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		modelRestoreRef.current = controller;
		const previous = readLastModelSelection();
		if (previous) {
			void resolveConfiguredModel(previous, controller.signal).then((restored) => {
				if (controller.signal.aborted || !restored) return;
				setModel(restored);
				setThinkingLevel(thinkingLevelForModel(restored, "off"));
			}).catch(() => {
				// A stale preference or unavailable catalog leaves manual selection available.
			});
		}
		return () => controller.abort();
	}, []);
	const editorRef = useRef<ChatTokenEditorHandle>(null);
	const requestIdRef = useRef<string | null>(null);
	const hasContent = hasChatComposerContent(draft);
	const modelRequired = hasContent && model === null;
	const sessionSettingsLocked = submitting || createdSession !== null;
	const workDirLabel = workDir.split("/").filter(Boolean).pop() ?? workDir;
	const composerTools = useMemo<readonly ChatComposerTool[]>(() => [{
		id: "terminal",
		icon: "terminal",
		name: "Terminal Mode",
		description: intl.formatMessage({ id: "session.tool.terminal.description" }),
		keywords: ["terminal", "terminal mode", "终端", "pty"],
		status: { label: intl.formatMessage({ id: "session.tool.notStarted" }), tone: "inactive" },
		disabled: true,
		disabledReason: intl.formatMessage({ id: "session.tool.availableAfterCreate" }),
	}], [intl]);

	const submit = async () => {
		const message = draft.trim();
		if (!hasChatComposerContent(message) || submitting) return;
		if (!model) return;

		setSubmitting(true);
		setSubmitError(null);
		try {
			let session = createdSession;
			if (!session) {
				session = await sessionApi.create(workspaceId, intl.formatMessage({ id: "session.name.fallback" }), {
					autoAudit,
					workDir: workDir || undefined,
				});
				setCreatedSession(session);
				await refresh();
			}

			const requestId = requestIdRef.current ?? crypto.randomUUID();
			requestIdRef.current = requestId;
			await chatApi.createRun(session.id, {
				requestId,
				generateTitle: true,
				providerId: model.providerId,
				modelId: model.id,
				thinkingLevel,
				message,
				serverInteractionMode: "command",
			});
			setDraft("");
			await refresh();
			router.replace(`/sessions/${session.id}`);
		} catch (requestError) {
			setSubmitError(localizedErrorMessage(requestError));
			if (requestError instanceof ApiError && requestError.code === "chat_thinking_level_unsupported" && model) {
				try {
					const refreshedModel = await resolveConfiguredModel({ providerId: model.providerId, modelId: model.id });
					if (refreshedModel) {
						setModel(refreshedModel);
						setThinkingLevel(thinkingLevelForModel(refreshedModel, thinkingLevel));
					}
				} catch {
					// Keep the original Run error visible when catalog recovery also fails.
				}
			}
		} finally {
			setSubmitting(false);
		}
	};

	const selectModel = (nextModel: LlmModel | null) => {
		modelRestoreRef.current?.abort();
		setModel(nextModel);
		setThinkingLevel(nextModel ? thinkingLevelForModel(nextModel, thinkingLevel) : "off");
		setSubmitError(null);
	};

	if (loading && tree === null) {
		return <div className="grid h-dvh place-items-center text-sm text-zinc-400">{intl.formatMessage({ id: "workspace.loading" })}</div>;
	}

	if (!workspace) {
		return (
			<div className="flex h-dvh min-h-[640px] overflow-hidden bg-[var(--canvas)]">
				<WorkspaceSidebar activeWorkspaceId={workspaceId} />
				<main className="grid min-w-0 flex-1 place-items-center bg-[var(--panel)] px-6 text-center">
					<div><p className="text-[14px] font-semibold text-zinc-700">{intl.formatMessage({ id: "workspace.notFound" })}</p><p className="mt-2 text-[10px] text-zinc-400">{treeError ? localizedErrorMessage(treeError) : intl.formatMessage({ id: "workspace.possiblyDeleted" })}</p></div>
				</main>
			</div>
		);
	}

	return (
		<>
			<div className="flex h-dvh min-h-[640px] overflow-hidden bg-[var(--canvas)]">
			<WorkspaceSidebar activeWorkspaceId={workspace.id} />
			<main className="flex min-w-0 flex-1 flex-col bg-[var(--panel)]">
				<header className="flex h-16 shrink-0 items-center border-b border-[var(--line-soft)] bg-white/90 px-6 backdrop-blur-xl">
					<div className="min-w-0"><h1 className="truncate text-[13px] font-semibold tracking-[-0.01em]">{intl.formatMessage({ id: "session.new" })}</h1><p className="mt-0.5 truncate text-[10px] text-zinc-400">{workspace.displayName} · {workspace.host.hostname}:{workspace.host.port}</p></div>
				</header>

				<div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto flex min-h-full max-w-[820px] flex-col px-5 lg:px-8">
						<div className="flex flex-1 items-center justify-center py-12">
							<div className="text-center">
								<span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl border border-[#d8e5dc] bg-[#edf4f0] text-[#397b5c]"><Sparkles size={18} /></span>
								<h2 className="mt-5 text-[20px] font-semibold tracking-[-0.025em] text-zinc-800">{intl.formatMessage({ id: "session.new.heading" }, { name: workspace.displayName })}</h2>
								<p className="mt-2 text-[11px] leading-5 text-zinc-400">{intl.formatMessage({ id: "session.new.description" })}</p>
							</div>
						</div>
					</div>
				</div>

				<div className="z-20 shrink-0 bg-[linear-gradient(to_bottom,transparent_0%,var(--panel)_26%)] px-5 pb-5 pt-8 lg:px-8">
					<div className="mx-auto w-full max-w-[756px]">
						<div className="chat-composer-shell rounded-[18px] border border-[var(--line)] bg-[var(--surface-strong)] px-3 pb-3 pt-2.5 shadow-[0_16px_48px_rgb(24_26_23/7%)] transition focus-within:border-[#b4c0b8] focus-within:shadow-[0_18px_52px_rgb(24_26_23/9%)]">
							{submitError ? <button type="button" className="mb-1 w-full rounded-lg bg-rose-50 px-3 py-2 text-left text-[9px] leading-4 text-rose-700" onClick={() => setSubmitError(null)}>{submitError}{createdSession ? <span className="mt-1 block text-rose-500">{intl.formatMessage({ id: "session.new.createdRetry" })}</span> : null}</button> : null}
							<ChatTokenEditor ref={editorRef} value={draft} disabled={submitting} autoFocus placeholder={intl.formatMessage({ id: "session.new.composer.placeholder" })} tools={composerTools} onChange={setDraft} onSubmit={() => void submit()} />
							<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-1">
								<div className="flex min-w-0 items-center gap-1">
									<div className="flex min-w-0 items-center">
										<button type="button" className="flex h-7 min-w-0 max-w-[140px] items-center gap-2 rounded-lg px-2 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-default disabled:opacity-50 sm:max-w-[180px]" aria-label={workDir ? intl.formatMessage({ id: "session.new.workDir.change" }, { path: workDir }) : intl.formatMessage({ id: "session.new.workDir.select" })} title={workDir || intl.formatMessage({ id: "session.new.workDir.title" })} disabled={sessionSettingsLocked} onClick={() => setDirectoryPickerOpen(true)}>
											<FolderOpen size={12} className="shrink-0 text-zinc-400" />
											<span className="truncate text-[9px] font-medium leading-none text-zinc-500">{workDirLabel || intl.formatMessage({ id: "session.new.workDir.label" })}</span>
										</button>
										{selectedWorkDir !== null ? <button type="button" className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-default disabled:opacity-40" aria-label={intl.formatMessage({ id: "session.new.workDir.useDefault" })} title={intl.formatMessage({ id: "session.new.workDir.useDefault" })} disabled={sessionSettingsLocked} onClick={() => setWorkDir(null)}><X size={10} /></button> : null}
									</div>
									<div className="flex shrink-0 items-center gap-2 px-1.5 text-[9px] font-medium text-zinc-500" title={intl.formatMessage({ id: "session.new.autoApproval.hint" })}>
										<ShieldCheck size={12} className={autoAudit ? "text-[#397b5c]" : "text-zinc-400"} /><span>{intl.formatMessage({ id: "session.new.autoApproval" })}</span><ToggleSwitch checked={autoAudit} disabled={sessionSettingsLocked} label={intl.formatMessage({ id: "session.new.autoApproval.label" })} onChange={setAutoAudit} />
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-1.5"><ModelThinkingSelector selectedModel={model} thinkingLevel={thinkingLevel} disabled={submitting} attention={modelRequired} appearance="composer" onSelectModel={selectModel} onSelectThinkingLevel={setThinkingLevel} /><button type="button" className="grid h-8 w-8 place-items-center rounded-full bg-[#282b28] text-white transition hover:bg-[#171a17] disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400" aria-label={intl.formatMessage({ id: "session.new.submit" })} disabled={!hasContent || model === null || submitting} onClick={() => void submit()}>{submitting ? <LoaderCircle size={13} className="animate-spin" /> : <Send size={13} />}</button></div>
							</div>
						</div>
						<p className="mt-2 text-center text-[8px] tracking-[0.01em] text-zinc-400">{intl.formatMessage({ id: "session.new.guardNotice" })}</p>
					</div>
				</div>
			</main>
			</div>
			{directoryPickerOpen ? <LocalDirectoryPicker initialPath={workDir || undefined} onClose={() => setDirectoryPickerOpen(false)} onSelect={(path) => { setWorkDir(path); setDirectoryPickerOpen(false); }} /> : null}
		</>
	);
}
