"use client";

import { ChevronRight, File, Folder, LoaderCircle, Minimize2, SquareTerminal } from "lucide-react";
import {
	type DragEvent as ReactDragEvent,
	forwardRef,
	type KeyboardEvent as ReactKeyboardEvent,
	type ClipboardEvent as ReactClipboardEvent,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { useIntl } from "react-intl";
import { localFilesApi, type LocalFileEntry } from "@/features/chat/api/local-files-api";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";
import {
	fileBadgeForName,
	mimeTypeForLocalFile,
	parseChatComposerMessage,
	serializeChatComposerReference,
	type ChatComposerReference,
} from "@/features/chat/model/chat-composer";
import {
	canSelectChatComposerTool,
	chatComposerMenuIncludesFiles,
	filterChatComposerTools,
	firstEnabledComposerMenuIndex,
	matchChatComposerMenuTrigger,
	nextEnabledComposerMenuIndex,
	resolveChatComposerMenuSections,
	type ChatComposerMenuTrigger,
	type ChatComposerTool,
} from "@/features/chat/model/chat-composer-menu";

export type { ChatComposerTool } from "@/features/chat/model/chat-composer-menu";

export interface ChatTokenEditorHandle {
	focus(): void;
}

interface ChatTokenEditorProps {
	sessionId?: string;
	value: string;
	disabled?: boolean;
	autoFocus?: boolean;
	placeholder: string;
	tools?: readonly ChatComposerTool[];
	onChange(value: string): void;
	onSubmit(): void;
	onToolSelect?(toolId: string): void;
	onFiles?(files: File[]): void;
}

interface ComposerMenuState {
	trigger: ChatComposerMenuTrigger;
	query: string;
}

type ComposerMenuOption =
	| { key: string; type: "tool"; tool: ChatComposerTool; disabled: boolean }
	| { key: string; type: "file"; entry: LocalFileEntry; disabled: false };

const EMPTY_TOOLS: readonly ChatComposerTool[] = [];

export const ChatTokenEditor = forwardRef<ChatTokenEditorHandle, ChatTokenEditorProps>(function ChatTokenEditor({
	sessionId,
	value,
	disabled = false,
	autoFocus = false,
	placeholder,
	tools = EMPTY_TOOLS,
	onChange,
	onSubmit,
	onToolSelect,
	onFiles,
}, forwardedRef) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	const shellRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<HTMLDivElement>(null);
	const menuRangeRef = useRef<Range | null>(null);
	const dragDepthRef = useRef(0);
	const composingRef = useRef(false);
	const synchronizedValueRef = useRef<string | null>(null);
	const [menu, setMenu] = useState<ComposerMenuState | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const [directoryLoading, setDirectoryLoading] = useState(false);
	const [directoryError, setDirectoryError] = useState<unknown>(null);
	const [rootPath, setRootPath] = useState<string | null>(null);
	const [currentPath, setCurrentPath] = useState<string | undefined>(undefined);
	const [directoryEntries, setDirectoryEntries] = useState<LocalFileEntry[]>([]);
	const [searchLoading, setSearchLoading] = useState(false);
	const [searchError, setSearchError] = useState<unknown>(null);
	const [searchEntries, setSearchEntries] = useState<LocalFileEntry[]>([]);
	const [draggingFiles, setDraggingFiles] = useState(false);
	const menuOpen = menu !== null;
	const fileMenuOpen = menu ? chatComposerMenuIncludesFiles(menu.trigger) : false;
	const normalizedQuery = menu?.query.trim().toLocaleLowerCase() ?? "";
	const recursiveSearchActive = fileMenuOpen && sessionId !== undefined && normalizedQuery.length > 0;
	const visibleTools = menu ? filterChatComposerTools(tools, normalizedQuery) : [];
	const visibleEntries = !fileMenuOpen
		? []
		: (recursiveSearchActive
			? searchEntries
			: directoryEntries.filter((entry) => !normalizedQuery || entry.name.toLocaleLowerCase().includes(normalizedQuery)))
			.slice(0, 12);
	const loading = recursiveSearchActive ? searchLoading : directoryLoading;
	const loadError = recursiveSearchActive ? searchError : directoryError;
	const parentDirectoryPath = !recursiveSearchActive && rootPath !== null && currentPath !== undefined && currentPath !== rootPath
		? parentPath(currentPath, rootPath)
		: null;
	const menuSections = resolveChatComposerMenuSections({
		fileMenuOpen,
		fileLoading: loading,
		fileError: loadError !== null,
		hasParentDirectory: parentDirectoryPath !== null,
		visibleToolCount: visibleTools.length,
		visibleFileCount: visibleEntries.length,
	});
	const menuOptions: ComposerMenuOption[] = [
		...visibleTools.map((tool) => ({ key: `tool:${tool.id}`, type: "tool" as const, tool, disabled: tool.disabled === true })),
		...visibleEntries.map((entry) => ({ key: `file:${entry.type}:${entry.path}`, type: "file" as const, entry, disabled: false as const })),
	];
	const disabledOptions = menuOptions.map((option) => option.disabled);
	const selectedIndex = menuOptions[activeIndex] && !menuOptions[activeIndex].disabled
		? activeIndex
		: firstEnabledComposerMenuIndex(disabledOptions);
	const selectedOption = selectedIndex >= 0 ? menuOptions[selectedIndex] : undefined;

	useImperativeHandle(forwardedRef, () => ({
		focus: () => editorRef.current?.focus(),
	}), []);

	useEffect(() => {
		const editor = editorRef.current;
		if (!editor || synchronizedValueRef.current === value) return;
		renderMessage(editor, value);
		synchronizedValueRef.current = value;
	}, [value]);

	useEffect(() => {
		if (autoFocus) editorRef.current?.focus();
	}, [autoFocus]);

	useEffect(() => {
		if (!menuOpen) return;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			if (event.target instanceof Node && shellRef.current?.contains(event.target)) return;
			menuRangeRef.current = null;
			setMenu(null);
		};
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
	}, [menuOpen]);

	useEffect(() => {
		if (!fileMenuOpen) {
			setDirectoryEntries([]);
			setDirectoryError(null);
			setRootPath(null);
			setCurrentPath(undefined);
			setDirectoryLoading(false);
			return;
		}
		if (recursiveSearchActive) return;
		const controller = new AbortController();
		setDirectoryLoading(true);
		setDirectoryError(null);
		const request = sessionId
			? localFilesApi.listSession(sessionId, currentPath, controller.signal)
			: localFilesApi.listSystem(currentPath, controller.signal);
		void request.then((result) => {
			setRootPath(result.rootPath);
			setCurrentPath(result.currentPath);
			setDirectoryEntries(result.entries);
		}).catch((requestError) => {
			if (!controller.signal.aborted) setDirectoryError(requestError);
		}).finally(() => {
			if (!controller.signal.aborted) setDirectoryLoading(false);
		});
		return () => controller.abort();
	}, [currentPath, fileMenuOpen, recursiveSearchActive, sessionId]);

	useEffect(() => {
		if (!fileMenuOpen || !sessionId || !normalizedQuery) {
			setSearchEntries([]);
			setSearchError(null);
			setSearchLoading(false);
			return;
		}
		const controller = new AbortController();
		setSearchLoading(true);
		setSearchError(null);
		setSearchEntries([]);
		const timeout = window.setTimeout(() => {
			void localFilesApi.searchSession(sessionId, normalizedQuery, { signal: controller.signal }).then((result) => {
				setSearchEntries(result.entries);
			}).catch((requestError) => {
				if (!controller.signal.aborted) setSearchError(requestError);
			}).finally(() => {
				if (!controller.signal.aborted) setSearchLoading(false);
			});
		}, 180);
		return () => {
			window.clearTimeout(timeout);
			controller.abort();
		};
	}, [fileMenuOpen, normalizedQuery, sessionId]);

	useEffect(() => {
		setActiveIndex(0);
	}, [menu?.trigger, normalizedQuery]);

	const closeMenu = () => {
		menuRangeRef.current = null;
		setMenu(null);
	};

	const syncValueAndMenu = (normalize = false) => {
		if (composingRef.current) return;
		const editor = editorRef.current;
		if (!editor) return;
		if (normalize) editor.normalize();
		const nextValue = serializeEditor(editor);
		synchronizedValueRef.current = nextValue;
		if (nextValue !== value) onChange(nextValue);
		const nextMenu = composerMenuAtSelection(editor);
		menuRangeRef.current = nextMenu?.range ?? null;
		setMenu(nextMenu ? { trigger: nextMenu.trigger, query: nextMenu.query } : null);
	};

	const insertEntry = (entry: LocalFileEntry) => {
		const editor = editorRef.current;
		const range = menuRangeRef.current;
		if (!editor || !range) return;
		const reference: ChatComposerReference = entry.type === "directory"
			? { type: "folder", name: entry.name, path: entry.path }
			: {
				type: "file",
				name: entry.name,
				path: entry.path,
				mimeType: mimeTypeForLocalFile(entry.name),
			};
		range.deleteContents();
		const token = createReferenceElement(reference);
		const trailingSpace = document.createTextNode(" ");
		range.insertNode(trailingSpace);
		range.insertNode(token);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		const caret = document.createRange();
		caret.setStart(trailingSpace, 1);
		caret.collapse(true);
		selection?.addRange(caret);
		closeMenu();
		syncValueAndMenu(true);
		editor.focus();
	};

	const selectTool = (tool: ChatComposerTool) => {
		const editor = editorRef.current;
		const range = menuRangeRef.current;
		if (!editor || !range || !canSelectChatComposerTool(tool)) return;
		range.deleteContents();
		range.collapse(true);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		closeMenu();
		syncValueAndMenu(true);
		editor.focus();
		onToolSelect?.(tool.id);
	};

	const browseDirectory = (entry: LocalFileEntry) => {
		const editor = editorRef.current;
		const range = menuRangeRef.current;
		if (!editor || !range || entry.type !== "directory") return;
		range.deleteContents();
		const mentionText = document.createTextNode("@");
		range.insertNode(mentionText);
		const mentionRange = document.createRange();
		mentionRange.setStart(mentionText, 0);
		mentionRange.setEnd(mentionText, 1);
		menuRangeRef.current = mentionRange;
		const selection = window.getSelection();
		selection?.removeAllRanges();
		const caret = document.createRange();
		caret.setStart(mentionText, 1);
		caret.collapse(true);
		selection?.addRange(caret);
		setMenu({ trigger: "mention", query: "" });
		setCurrentPath(entry.path);
		syncValueAndMenu(true);
		editor.focus();
	};

	const chooseOption = (option: ComposerMenuOption | undefined) => {
		if (!option || option.disabled) return;
		if (option.type === "tool") selectTool(option.tool);
		else insertEntry(option.entry);
	};

	const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (menuOpen) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const direction = event.key === "ArrowDown" ? 1 : -1;
				setActiveIndex(nextEnabledComposerMenuIndex(disabledOptions, selectedIndex, direction));
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				chooseOption(selectedOption);
				return;
			}
			if (event.key === "ArrowRight" && selectedOption?.type === "file" && selectedOption.entry.type === "directory") {
				event.preventDefault();
				browseDirectory(selectedOption.entry);
				return;
			}
			if (event.key === "ArrowLeft" && fileMenuOpen && rootPath && currentPath && currentPath !== rootPath) {
				event.preventDefault();
				setCurrentPath(parentPath(currentPath, rootPath));
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				closeMenu();
				return;
			}
		}
		if (event.key === "Backspace" && removeReferenceBeforeCaret(editorRef.current)) {
			event.preventDefault();
			syncValueAndMenu(true);
			return;
		}
		if (event.key !== "Enter" || event.shiftKey) return;
		if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		onSubmit();
	};

	const paste = (event: ReactClipboardEvent<HTMLDivElement>) => {
		const files = clipboardFiles(event.clipboardData);
		if (files.length > 0) {
			event.preventDefault();
			insertPlainTextAtSelection(event.clipboardData.getData("text/plain"));
			syncValueAndMenu(true);
			onFiles?.(files);
			return;
		}
		event.preventDefault();
		insertPlainTextAtSelection(event.clipboardData.getData("text/plain"));
		syncValueAndMenu(true);
	};

	const dragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		dragDepthRef.current += 1;
		setDraggingFiles(true);
	};

	const dragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
		if (dragDepthRef.current === 0) setDraggingFiles(false);
	};

	const dragOver = (event: ReactDragEvent<HTMLDivElement>) => {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
	};

	const drop = (event: ReactDragEvent<HTMLDivElement>) => {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		dragDepthRef.current = 0;
		setDraggingFiles(false);
		onFiles?.(Array.from(event.dataTransfer.files));
	};

	return (
		<div ref={shellRef} className="chat-token-editor-shell" data-image-dragging={draggingFiles || undefined}>
			<div
				ref={editorRef}
				className="chat-token-editor app-scrollbar"
				contentEditable={!disabled}
				suppressContentEditableWarning
				role="textbox"
				aria-multiline="true"
				aria-label={placeholder}
				aria-disabled={disabled}
				data-placeholder={placeholder}
				onInput={() => syncValueAndMenu()}
				onKeyDown={keyDown}
				onPaste={paste}
				onDragEnter={dragEnter}
				onDragLeave={dragLeave}
				onDragOver={dragOver}
				onDrop={drop}
				onCompositionStart={() => {
					composingRef.current = true;
					closeMenu();
				}}
				onCompositionEnd={() => {
					composingRef.current = false;
					syncValueAndMenu();
				}}
			/>
			{draggingFiles ? <div className="chat-token-editor-drop-indicator" aria-hidden="true">{intl.formatMessage({ id: "chat.attachment.dropHint" })}</div> : null}
			{menu ? (
				<div className="chat-composer-menu app-scrollbar" role="listbox" aria-label={intl.formatMessage({ id: fileMenuOpen ? "chat.composer.menu.all" : "chat.composer.menu.tools" })}>
					{menuSections.showTools ? <div className="chat-composer-menu-group">
						<div className="chat-composer-menu-group-title">{intl.formatMessage({ id: "chat.composer.menu.tools" })}</div>
						{visibleTools.map((tool) => {
							const ToolIcon = tool.icon === "compact" ? Minimize2 : SquareTerminal;
							const optionIndex = menuOptions.findIndex((option) => option.type === "tool" && option.tool.id === tool.id);
							return (
								<button
									key={tool.id}
									type="button"
									role="option"
									aria-selected={optionIndex === selectedIndex}
									aria-disabled={tool.disabled === true}
									disabled={tool.disabled}
									className="chat-composer-menu-result"
									onMouseEnter={() => { if (!tool.disabled) setActiveIndex(optionIndex); }}
									onMouseDown={(event) => { event.preventDefault(); selectTool(tool); }}
								>
									<span className="chat-composer-menu-icon"><ToolIcon size={14} strokeWidth={1.8} /></span>
									<span className="chat-composer-menu-copy">
										<span className="chat-composer-menu-title">{tool.name}</span>
										<span className="chat-composer-menu-description">{tool.disabledReason ?? tool.description}</span>
									</span>
									{tool.status ? <span className={`chat-composer-menu-tool-status chat-composer-menu-tool-status-${tool.status.tone}`} aria-label={intl.formatMessage({ id: "chat.composer.menu.toolStatus" }, { status: tool.status.label })} title={tool.status.label}><span className="chat-composer-menu-tool-status-dot" /></span> : null}
								</button>
							);
						})}
					</div> : null}
					{menuSections.showFiles ? (
						<div className="chat-composer-menu-group">
							<div className="chat-composer-menu-group-title">{intl.formatMessage({ id: "chat.composer.menu.files" })}</div>
							{loading ? <div className="chat-composer-menu-state"><LoaderCircle size={13} className="animate-spin" /></div> : null}
							{!loading && loadError ? <div className="chat-composer-menu-state text-rose-600">{localizedErrorMessage(loadError)}</div> : null}
							{!loading && !loadError && visibleEntries.length === 0 ? <div className="chat-composer-menu-state">{intl.formatMessage({ id: "chat.composer.menu.files.empty" })}</div> : null}
							{parentDirectoryPath !== null ? <button type="button" className="chat-composer-menu-parent" onMouseDown={(event) => { event.preventDefault(); setCurrentPath(parentDirectoryPath); }}>{intl.formatMessage({ id: "chat.composer.menu.parent" })}</button> : null}
							{!loading && !loadError ? visibleEntries.map((entry) => {
								const Icon = entry.type === "directory" ? Folder : File;
								const optionIndex = menuOptions.findIndex((option) => option.type === "file" && option.entry.path === entry.path && option.entry.type === entry.type);
								return (
									<div
										key={`${entry.type}:${entry.path}`}
										role="option"
										aria-selected={optionIndex === selectedIndex}
										className="chat-composer-menu-result chat-composer-menu-file-result"
										onMouseEnter={() => setActiveIndex(optionIndex)}
									>
										<button type="button" className="chat-composer-menu-file-select" onMouseDown={(event) => { event.preventDefault(); insertEntry(entry); }}>
											<span className={`chat-composer-menu-icon ${entry.type === "directory" ? "chat-composer-menu-folder-icon" : "chat-composer-menu-file-icon"}`}><Icon size={15} strokeWidth={1.8} /></span>
											<span className="chat-composer-menu-copy">
												<span className="chat-composer-menu-title">{entry.name}</span>
												<span className="chat-composer-menu-description">{entry.relativePath}</span>
											</span>
										</button>
										{entry.type === "directory" ? <button type="button" className="chat-composer-menu-file-open" aria-label={intl.formatMessage({ id: "chat.composer.menu.openDirectory" }, { name: entry.name })} onMouseDown={(event) => { event.preventDefault(); browseDirectory(entry); }}><ChevronRight size={13} /></button> : null}
									</div>
								);
							}) : null}
						</div>
					) : null}
					{menuSections.showEmpty ? <div className="chat-composer-menu-state">{intl.formatMessage({ id: "chat.composer.menu.empty" })}</div> : null}
				</div>
			) : null}
		</div>
	);
});

function renderMessage(editor: HTMLElement, message: string): void {
	const fragment = document.createDocumentFragment();
	for (const part of parseChatComposerMessage(message)) {
		fragment.append(part.type === "text" ? document.createTextNode(part.text) : createReferenceElement(part.reference));
	}
	editor.replaceChildren(fragment);
}

function createReferenceElement(reference: ChatComposerReference): HTMLSpanElement {
	const token = document.createElement("span");
	token.className = "chat-reference-token";
	token.contentEditable = "false";
	token.dataset.chatReference = reference.type;
	token.dataset.name = reference.name;
	token.dataset.path = reference.path;
	if (reference.type === "file") token.dataset.mimeType = reference.mimeType;
	token.dataset.badge = reference.type === "folder" ? "DIR" : fileBadgeForName(reference.name);
	token.title = reference.path;
	token.textContent = reference.name;
	return token;
}

function referenceFromElement(element: HTMLElement): ChatComposerReference | null {
	const type = element.dataset.chatReference;
	const name = element.dataset.name;
	const path = element.dataset.path;
	if (!name || !path) return null;
	if (type === "folder") return { type, name, path };
	if (type === "file") return { type, name, path, mimeType: element.dataset.mimeType ?? "application/octet-stream" };
	return null;
}

function serializeEditor(editor: HTMLElement): string {
	return serializeChildren(editor).replaceAll("\u00a0", " ");
}

function insertPlainTextAtSelection(text: string): void {
	if (!text) return;
	const selection = window.getSelection();
	if (!selection?.rangeCount) return;
	const range = selection.getRangeAt(0);
	range.deleteContents();
	const node = document.createTextNode(text);
	range.insertNode(node);
	range.setStartAfter(node);
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

export function clipboardFiles(clipboardData: Pick<DataTransfer, "files" | "items">): File[] {
	const files = Array.from(clipboardData.files);
	if (files.length > 0) return files;
	return Array.from(clipboardData.items).flatMap((item) => {
		if (item.kind !== "file") return [];
		const file = item.getAsFile();
		return file ? [file] : [];
	});
}

function serializeChildren(parent: Node): string {
	let result = "";
	for (const node of parent.childNodes) {
		if (node.nodeType === Node.TEXT_NODE) {
			result += node.textContent ?? "";
			continue;
		}
		if (!(node instanceof HTMLElement)) continue;
		const reference = referenceFromElement(node);
		if (reference) {
			result += serializeChatComposerReference(reference);
			continue;
		}
		if (node.tagName === "BR") {
			result += "\n";
			continue;
		}
		const block = node.tagName === "DIV" || node.tagName === "P";
		if (block && result.length > 0 && !result.endsWith("\n")) result += "\n";
		result += serializeChildren(node);
	}
	return result;
}

function composerMenuAtSelection(editor: HTMLElement): (ComposerMenuState & { range: Range }) | null {
	const selection = window.getSelection();
	if (!selection?.rangeCount || !selection.isCollapsed) return null;
	const caret = selection.getRangeAt(0);
	if (!editor.contains(caret.startContainer)) return null;
	const textCaret = textCaretBefore(caret.startContainer, caret.startOffset);
	if (!textCaret) return null;
	const textNodeBeforeCaret = textCaret.node.textContent?.slice(0, textCaret.offset) ?? "";
	const messageRange = document.createRange();
	messageRange.selectNodeContents(editor);
	messageRange.setEnd(caret.startContainer, caret.startOffset);
	const match = matchChatComposerMenuTrigger(messageRange.toString(), textNodeBeforeCaret);
	if (!match) return null;
	const range = document.createRange();
	range.setStart(textCaret.node, match.startOffsetInTextNode);
	range.setEnd(textCaret.node, match.endOffsetInTextNode);
	return { trigger: match.trigger, query: match.query, range };
}

function textCaretBefore(container: Node, offset: number): { node: Text; offset: number } | null {
	if (container.nodeType === Node.TEXT_NODE) return { node: container as Text, offset };
	const previous = container.childNodes.item(offset - 1);
	if (previous?.nodeType !== Node.TEXT_NODE) return null;
	return { node: previous as Text, offset: previous.textContent?.length ?? 0 };
}

function removeReferenceBeforeCaret(editor: HTMLElement | null): boolean {
	if (!editor) return false;
	const selection = window.getSelection();
	if (!selection?.rangeCount || !selection.isCollapsed) return false;
	const range = selection.getRangeAt(0);
	if (!editor.contains(range.startContainer)) return false;
	let previous: ChildNode | null = null;
	if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset === 0) previous = range.startContainer.previousSibling;
	else if (range.startContainer === editor && range.startOffset > 0) previous = editor.childNodes.item(range.startOffset - 1);
	if (!(previous instanceof HTMLElement) || !referenceFromElement(previous)) return false;
	previous.remove();
	return true;
}

function parentPath(path: string, rootPath: string): string {
	if (path === rootPath) return rootPath;
	const separator = path.includes("\\") ? "\\" : "/";
	const parent = path.slice(0, path.lastIndexOf(separator)) || separator;
	return parent.length < rootPath.length ? rootPath : parent;
}
