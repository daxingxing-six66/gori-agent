"use client";

import { BookOpen, FileCode2, LoaderCircle, RefreshCw } from "lucide-react";
import { useIntl } from "react-intl";
import { errorMessage } from "@/shared/errors/api-error";
import type { ReaderDocument } from "../model/reader-file";
import { fileLanguage, MAX_HIGHLIGHT_CHARACTERS } from "../model/file-language";
import { useReaderFile } from "../runtime/use-reader-file";
import { ReaderContent } from "./reader-content";
import "./file-reader.css";

export function FileReaderPage({ sessionId, document }: { sessionId: string; document: ReaderDocument }) {
	const intl = useIntl();
	const { file, loading, error, refresh } = useReaderFile(sessionId, document.path, document.revision);
	const language = fileLanguage(file?.path ?? document.path);
	return <section className="file-reader" aria-label={intl.formatMessage({ id: "fileReader.label" }, { name: document.name })} aria-busy={loading}>
		<header className="file-reader-header">
			{language === "markdown" ? <BookOpen size={15} aria-hidden="true" /> : <FileCode2 size={15} aria-hidden="true" />}
			<span className="file-reader-path" title={file?.path ?? document.path}>{file?.path ?? document.path}</span>
			<button type="button" className="file-reader-refresh" onClick={refresh} disabled={loading}
				aria-label={intl.formatMessage({ id: "fileReader.refresh" })} title={intl.formatMessage({ id: "fileReader.refresh" })}>
				<RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />
			</button>
		</header>
		<div className="file-reader-meta">
			<span>{intl.formatMessage({ id: language === "markdown" ? "fileReader.preview" : "fileReader.readOnly" })}</span>
			<span>{language === "plaintext" ? intl.formatMessage({ id: "fileReader.plainText" }) : language}</span>
			{file ? <span>{intl.formatNumber(file.size)} B</span> : null}
		</div>
		{loading && !file ? <div className="file-reader-state" role="status"><LoaderCircle size={18} className="animate-spin" aria-hidden="true" />{intl.formatMessage({ id: "fileReader.loading" })}</div> : null}
		{error ? <div className="file-reader-state" role="alert"><p>{errorMessage(error, intl.formatMessage({ id: "fileReader.failed" }))}</p><button type="button" onClick={refresh}>{intl.formatMessage({ id: "fileReader.retry" })}</button></div> : null}
		{file && !file.content ? <p className="file-reader-state">{intl.formatMessage({ id: "fileReader.empty" })}</p> : null}
		{file && file.content.length > MAX_HIGHLIGHT_CHARACTERS && language !== "markdown" ? <p className="file-reader-notice">{intl.formatMessage({ id: "fileReader.largePlainText" })}</p> : null}
		<div className="file-reader-scroll app-scrollbar" tabIndex={0} aria-label={intl.formatMessage({ id: "fileReader.content" })}>
			{file?.content ? <ReaderContent content={file.content} path={file.path} /> : null}
		</div>
	</section>;
}
