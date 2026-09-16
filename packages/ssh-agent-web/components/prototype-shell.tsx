"use client";

import { useState } from "react";
import { useIntl } from "react-intl";
import {
	Bot,
	ChevronDown,
	Clock3,
	Download,
	FileArchive,
	FileText,
	Folder,
	FolderOpen,
	Maximize2,
	Plus,
	RefreshCw,
	Send,
	SquareTerminal,
	Upload,
	X,
} from "lucide-react";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { ModelSelector } from "@/features/llm-provider/components/model-selector";
import type { LlmModel } from "@/features/llm-provider/model/llm-provider";
import { commandOutput } from "@/lib/mock-data";

function CommandCard() {
	const intl = useIntl();
	const [expanded, setExpanded] = useState(true);

	return (
		<section className="overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--surface-strong)]">
			<div className={`flex items-center gap-3 px-4 py-3 ${expanded ? "border-b border-[var(--line-soft)]" : ""}`}>
				<div className="grid h-7 w-7 shrink-0 place-items-center text-[#397b5c]">
					<SquareTerminal size={15} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2.5">
						<p className="truncate text-[12px] font-semibold">{intl.formatMessage({ id: "prototype.command.title" })}</p>
						<span className="inline-flex shrink-0 items-center gap-1.5 text-[8px] font-semibold uppercase tracking-[0.06em] text-[#397b5c]">
							<span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" /> {intl.formatMessage({ id: "prototype.command.completed" })}
						</span>
					</div>
					<p className="mt-1 truncate font-mono text-[9px] text-zinc-400">ubuntu@10.24.8.16 · /opt/api/current</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<span className="inline-flex items-center gap-1 text-[9px] text-zinc-400"><Clock3 size={11} /> 1.2s</span>
					<button
						className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 transition hover:bg-black/[0.04] hover:text-zinc-700"
						onClick={() => setExpanded((value) => !value)}
						aria-label={intl.formatMessage({ id: expanded ? "prototype.command.output.hide" : "prototype.command.output.show" })}
					>
						<ChevronDown size={13} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
					</button>
				</div>
			</div>
			<div className={`${expanded ? "block" : "hidden"} bg-[#f3f2ee] px-4 py-3 font-mono text-[10px] leading-5 text-zinc-600`}>
				<div className="mb-2 flex items-center gap-2">
					<span className="text-[#397b5c]">$</span>
					<span className="text-zinc-700">sudo systemctl status api.service --no-pager</span>
				</div>
				{commandOutput.map((line, index) => (
					<div key={line} className={index === 2 ? "text-[#a45660]" : undefined}>
						{line}
					</div>
				))}
			</div>
		</section>
	);
}

function Conversation({ onOpenFiles, onToggleTerminal }: { onOpenFiles: () => void; onToggleTerminal: () => void }) {
	const intl = useIntl();
	const [draft, setDraft] = useState("");
	const [sentMessages, setSentMessages] = useState<string[]>([]);
	const [selectedModel, setSelectedModel] = useState<LlmModel | null>(null);

	const submitDraft = () => {
		const message = draft.trim();
		if (!message) return;
		setSentMessages((messages) => [...messages, message]);
		setDraft("");
	};

	return (
		<main className="flex min-w-0 flex-1 flex-col bg-[var(--panel)]">
			<header className="flex h-[64px] shrink-0 items-center justify-between border-b border-[var(--line-soft)] bg-[color-mix(in_srgb,var(--surface)_88%,transparent)] px-6 backdrop-blur-xl">
				<div className="flex min-w-0 items-center gap-3">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h1 className="truncate text-[13px] font-semibold tracking-[-0.01em]">修复部署后 502</h1>
							<span className="rounded border border-rose-200/80 bg-rose-50/60 px-1.5 py-0.5 text-[8px] font-bold tracking-[0.08em] text-rose-600">PROD</span>
						</div>
						<p className="mt-0.5 truncate text-[10px] text-zinc-400">Production API · ubuntu@10.24.8.16</p>
					</div>
				</div>
				<div className="flex items-center gap-3">
					<span className="hidden items-center gap-2 text-[9px] font-medium text-zinc-500 md:flex">
						<span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" /> SSH · 18 ms
					</span>
					<div className="ui-toolbar">
						<button className="ui-toolbar-button hidden sm:flex" onClick={onOpenFiles}><FolderOpen size={13} /> {intl.formatMessage({ id: "prototype.files.open" })}</button>
						<button className="ui-toolbar-button" onClick={onToggleTerminal}><SquareTerminal size={13} /> {intl.formatMessage({ id: "prototype.terminal.open" })}</button>
					</div>
				</div>
			</header>

			<div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex min-h-full max-w-[820px] flex-col px-5 lg:px-8">
					<div className="flex-1 space-y-8 pb-8 pt-10">
						<div className="flex justify-end">
							<div className="max-w-[78%] rounded-[14px] rounded-br-[5px] border border-[#dbe3dd] bg-[#edf2ee] px-4 py-3 text-[12px] leading-6 text-zinc-700">
								刚完成 production-api 的部署，但外部访问一直返回 502。帮我检查原因并修复。
							</div>
						</div>

						<div className="flex gap-3.5">
							<div className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-[#d6e4da] bg-[#eaf2ec] text-[#277b58]">
								<Bot size={16} />
							</div>
							<div className="min-w-0 flex-1 space-y-4">
								<div>
									<div className="mb-1.5 flex items-center gap-2">
										<p className="text-[11px] font-semibold">SSH Agent</p>
										<span className="text-[9px] text-zinc-400">10:42</span>
									</div>
									<p className="text-[12px] leading-6 text-zinc-600">我先检查 API 服务和 Nginx 上游状态，确认 502 是应用未启动还是代理配置问题。</p>
								</div>
								<CommandCard />
							</div>
						</div>

						{sentMessages.map((message) => (
							<div key={message} className="flex justify-end">
								<div className="max-w-[78%] rounded-[14px] rounded-br-[5px] border border-[#dbe3dd] bg-[#edf2ee] px-4 py-3 text-[12px] leading-6 text-zinc-700">
									{message}
								</div>
							</div>
						))}
					</div>

					<div className="sticky bottom-0 z-20 bg-[linear-gradient(to_bottom,transparent_0%,var(--panel)_32%)] pb-5 pt-10">
						<div className="rounded-[18px] border border-[var(--line)] bg-[var(--surface-strong)] px-3 pb-3 pt-2.5 shadow-[0_16px_48px_rgb(24_26_23/7%)] transition focus-within:border-[#b4c0b8] focus-within:shadow-[0_18px_52px_rgb(24_26_23/9%)]">
							<textarea
								className="chat-composer-input min-h-[72px] w-full resize-none border-0 bg-transparent px-2 py-2 text-[13px] leading-6 text-zinc-800 outline-none placeholder:text-zinc-400"
								placeholder={intl.formatMessage({ id: "session.new.composer.placeholder" })}
								value={draft}
								onChange={(event) => setDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										submitDraft();
									}
								}}
								rows={2}
							/>
							<div className="flex items-center justify-between pt-1">
								<button className="grid h-8 w-8 place-items-center rounded-full text-zinc-500 transition hover:bg-black/[0.045] hover:text-zinc-800" aria-label={intl.formatMessage({ id: "prototype.attachment.add" })}>
									<Plus size={17} />
								</button>
								<div className="flex items-center gap-1.5">
									<ModelSelector selectedModel={selectedModel} onSelect={setSelectedModel} />
									<button
										className="grid h-8 w-8 place-items-center rounded-full bg-[#282b28] text-white transition hover:bg-[#171a17] disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400"
										aria-label={intl.formatMessage({ id: "chat.send" })}
										disabled={!draft.trim()}
										onClick={submitDraft}
									>
										<Send size={13} />
									</button>
								</div>
							</div>
						</div>
						<p className="mt-2 text-center text-[8px] tracking-[0.01em] text-zinc-400">{intl.formatMessage({ id: "prototype.guard.notice" })}</p>
					</div>
				</div>
			</div>
		</main>
	);
}


const mirroredCommands = [
	{
		id: "cmd-01",
		command: "sudo systemctl status api.service --no-pager",
		output: ["● api.service - Production API", "Active: failed (Result: exit-code)", "Main PID: 28419 (status=1/FAILURE)"],
	},
	{
		id: "cmd-02",
		command: "journalctl -u api.service -n 80 --no-pager",
		output: ["PermissionError: cannot read .env.production", "api.service: Main process exited, status=1/FAILURE"],
	},
	{
		id: "cmd-03",
		command: "stat -c '%U:%G %a %n' .env.production",
		output: ["root:root 600 .env.production"],
	},
];

function CommandMirrorRail() {
	const intl = useIntl();

	return (
		<aside className="context-rail terminal-shell flex w-[360px] shrink-0 flex-col overflow-hidden border-l border-[var(--terminal-line)] bg-[var(--terminal-bg)] text-[var(--terminal-ink)]">
			<header className="flex h-[64px] shrink-0 items-center justify-between border-b border-[var(--terminal-line)] bg-[var(--terminal-chrome)] px-4">
				<div className="flex items-center gap-3">
					<div className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--terminal-line)] bg-[var(--surface-strong)] text-[var(--terminal-accent)]">
						<SquareTerminal size={15} />
					</div>
					<div><p className="text-[11px] font-semibold text-zinc-800">AI Terminal</p><p className="mt-0.5 font-mono text-[8px] text-[var(--terminal-muted)]">ubuntu@production-api</p></div>
				</div>
				<div className="text-right"><p className="text-[8px] font-semibold tracking-[0.12em] text-[var(--terminal-muted)]">{intl.formatMessage({ id: "prototype.terminal.readOnly" })}</p><p className="mt-1 inline-flex items-center gap-1.5 text-[8px] text-[var(--terminal-accent)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--terminal-accent)]" /> {intl.formatMessage({ id: "prototype.terminal.connected" })}</p></div>
			</header>

			<div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-5 font-mono text-[10px] leading-[1.75]">
				<div className="mb-5 text-[var(--terminal-muted)]">
					<p>{intl.formatMessage({ id: "prototype.terminal.shell" })}</p>
					<p>{intl.formatMessage({ id: "prototype.terminal.connectedTo" }, { host: "production-api" })}</p>
					<p>{intl.formatMessage({ id: "prototype.terminal.workingDirectory" }, { path: "/opt/api/current" })}</p>
				</div>

				{mirroredCommands.map((item, index) => (
					<div key={item.id} className="mb-5">
						<div className="flex items-start"><span className="mr-1.5 shrink-0 font-semibold text-[var(--terminal-accent)]">ubuntu@prod</span><span className="mr-2 text-[var(--terminal-muted)]">$</span><span className="break-all text-[var(--terminal-command)]">{item.command}</span></div>
						<div className="mt-1 text-[var(--terminal-output)]">
							{item.output.map((line, outputIndex) => <p key={line} className={index < 2 && outputIndex === item.output.length - 1 ? "text-[var(--terminal-error)]" : undefined}>{line}</p>)}
						</div>
					</div>
				))}

				<div className="flex items-center"><span className="mr-1.5 font-semibold text-[var(--terminal-accent)]">ubuntu@prod</span><span className="mr-2 text-[var(--terminal-muted)]">$</span><span className="h-3.5 w-1.5 animate-pulse bg-[var(--terminal-accent)]/70" /></div>
			</div>

			<footer className="flex h-9 shrink-0 items-center justify-between border-t border-[var(--terminal-line)] bg-[var(--terminal-chrome)] px-4 font-mono text-[8px] text-[var(--terminal-muted)]"><span>ssh-01 · exec-03</span><span>UTF-8</span></footer>
		</aside>
	);
}

function FileBrowserDialog({ onClose }: { onClose: () => void }) {
	const intl = useIntl();
	const files = [
		{ name: "bin", type: "folder", size: "—", updatedAt: intl.formatMessage({ id: "prototype.files.todayAt" }, { time: "10:39" }) },
		{ name: "config", type: "folder", size: "—", updatedAt: intl.formatMessage({ id: "prototype.files.yesterdayAt" }, { time: "18:12" }) },
		{ name: ".env.production", type: "text", size: "2.1 KB", updatedAt: intl.formatMessage({ id: "prototype.files.todayAt" }, { time: "10:41" }) },
		{ name: "release-v2.4.1.tar.gz", type: "archive", size: "32.8 MB", updatedAt: intl.formatMessage({ id: "prototype.files.todayAt" }, { time: "10:31" }) },
		{ name: "server.log", type: "text", size: "8.6 MB", updatedAt: intl.formatMessage({ id: "prototype.files.todayAt" }, { time: "10:42" }) },
	];

	return (
		<div className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/35 p-5 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label={intl.formatMessage({ id: "prototype.files.remote" })}>
			<div className="flex max-h-[78vh] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgb(15_23_42/24%)]">
				<header className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
					<div><p className="text-[13px] font-semibold">{intl.formatMessage({ id: "prototype.files.remote" })}</p><p className="mt-1 font-mono text-[10px] text-zinc-400">ubuntu@10.24.8.16:/opt/api/current</p></div>
					<div className="flex items-center gap-2">
						<button className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-[10px] font-semibold text-zinc-600 hover:bg-zinc-50"><Upload size={14} /> {intl.formatMessage({ id: "prototype.files.upload" })}</button>
						<button className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" onClick={onClose} aria-label={intl.formatMessage({ id: "prototype.files.close" })}><X size={17} /></button>
					</div>
				</header>
				<div className="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50/70 px-5 py-3 font-mono text-[10px] text-zinc-500">
					<Folder size={14} className="text-amber-500" /><span>/</span><span>opt</span><span>/</span><span>api</span><span>/</span><span className="font-semibold text-zinc-800">current</span>
				</div>
				<div className="app-scrollbar min-h-0 overflow-y-auto p-3">
					<div className="grid grid-cols-[minmax(0,1fr)_90px_110px_36px] px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.1em] text-zinc-400"><span>{intl.formatMessage({ id: "prototype.files.name" })}</span><span>{intl.formatMessage({ id: "prototype.files.size" })}</span><span>{intl.formatMessage({ id: "prototype.files.modified" })}</span><span /></div>
					{files.map((file) => (
						<div key={file.name} className="grid grid-cols-[minmax(0,1fr)_90px_110px_36px] items-center rounded-xl px-3 py-3 text-[11px] hover:bg-zinc-50">
							<div className="flex min-w-0 items-center gap-3">
								<div className={`grid h-8 w-8 place-items-center rounded-lg ${file.type === "folder" ? "bg-amber-50 text-amber-500" : "bg-zinc-100 text-zinc-500"}`}>
									{file.type === "folder" ? <Folder size={15} /> : file.type === "archive" ? <FileArchive size={15} /> : <FileText size={15} />}
								</div><span className="truncate font-medium text-zinc-700">{file.name}</span>
							</div>
							<span className="text-zinc-400">{file.size}</span><span className="text-zinc-400">{file.updatedAt}</span>
							<button className="rounded-lg p-2 text-zinc-400 hover:bg-white hover:text-zinc-700" aria-label={intl.formatMessage({ id: "sftp.download" }, { name: file.name })}><Download size={14} /></button>
						</div>
					))}
				</div>
				<footer className="flex items-center justify-between border-t border-zinc-100 bg-zinc-50/60 px-5 py-3 text-[9px] text-zinc-400"><span>{intl.formatMessage({ id: "prototype.files.summary" }, { count: files.length })}</span><span>{intl.formatMessage({ id: "prototype.files.private" })}</span></footer>
			</div>
		</div>
	);
}

function TerminalDrawer({ onClose }: { onClose: () => void }) {
	const intl = useIntl();
	const [command, setCommand] = useState("");
	const [history, setHistory] = useState<string[]>([
		"Last login: Sat Aug 22 10:33:41 2026 from 10.24.1.6",
		"ubuntu@production-api:/opt/api/current$ ls -la .env.production",
		"-rw------- 1 root root 2138 Aug 22 10:41 .env.production",
	]);

	const runTerminalCommand = () => {
		const value = command.trim();
		if (!value) return;
		setHistory((lines) => [...lines, `ubuntu@production-api:/opt/api/current$ ${value}`, intl.formatMessage({ id: "prototype.terminal.commandCaptured" })]);
		setCommand("");
	};

	return (
		<section className="terminal-shell absolute inset-x-0 bottom-0 z-40 flex h-[300px] flex-col border-t border-[var(--terminal-line)] bg-[var(--terminal-bg)] text-[var(--terminal-ink)] shadow-[0_-18px_48px_rgb(35_38_34/10%)]">
			<header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--terminal-line)] bg-[var(--terminal-chrome)] px-3">
				<div className="flex h-full items-center gap-1 px-3">
					<span className="text-[10px] font-semibold text-zinc-800">{intl.formatMessage({ id: "prototype.terminal.open" })}</span>
					<span className="ml-3 inline-flex items-center gap-1.5 rounded-full bg-[#e1eee6] px-2 py-1 text-[9px] font-medium text-[var(--terminal-accent)]"><RefreshCw size={10} /> {intl.formatMessage({ id: "prototype.terminal.syncsToContext" })}</span>
				</div>
				<div className="flex items-center gap-1"><button className="rounded-md p-2 text-[var(--terminal-muted)] hover:bg-black/[0.04] hover:text-zinc-700" aria-label={intl.formatMessage({ id: "prototype.terminal.maximize" })}><Maximize2 size={14} /></button><button className="rounded-md p-2 text-[var(--terminal-muted)] hover:bg-black/[0.04] hover:text-zinc-700" onClick={onClose} aria-label={intl.formatMessage({ id: "prototype.terminal.close" })}><X size={15} /></button></div>
			</header>
			<div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-[11px] leading-5">
				{history.map((line, index) => <div key={`${index}-${line}`} className={line.startsWith("[") ? "text-[var(--terminal-accent)]" : undefined}>{line}</div>)}
				<div className="mt-1 flex items-center gap-2">
					<span className="shrink-0 font-semibold text-[var(--terminal-accent)]">ubuntu@production-api:/opt/api/current$</span>
					<input className="terminal-input min-w-0 flex-1 bg-transparent text-[var(--terminal-command)] outline-none" value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") runTerminalCommand(); }} autoFocus aria-label={intl.formatMessage({ id: "prototype.terminal.command" })} />
				</div>
			</div>
		</section>
	);
}

export function PrototypeShell() {
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [filesOpen, setFilesOpen] = useState(false);

	return (
		<div className="flex h-dvh min-h-[640px] min-w-[320px] overflow-hidden bg-[var(--canvas)]">
			<WorkspaceSidebar />
			<div className="relative flex min-w-0 flex-1">
				<div className="relative flex min-w-0 flex-1">
					<Conversation onOpenFiles={() => setFilesOpen(true)} onToggleTerminal={() => setTerminalOpen((open) => !open)} />
					{terminalOpen ? <TerminalDrawer onClose={() => setTerminalOpen(false)} /> : null}
				</div>
				<CommandMirrorRail />
				{filesOpen ? <FileBrowserDialog onClose={() => setFilesOpen(false)} /> : null}
			</div>
		</div>
	);
}
