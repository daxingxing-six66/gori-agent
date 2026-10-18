"use client";

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fileLanguage, highlightedCode } from "../model/file-language";

export function ReaderCode({ content, language }: { content: string; language: string }) {
	const html = useMemo(() => highlightedCode(content, language), [content, language]);
	return <pre className="reader-code"><code className={`hljs language-${language}`}
		{...(html === null ? { children: content } : { dangerouslySetInnerHTML: { __html: html } })} /></pre>;
}

export function ReaderContent({ content, path }: { content: string; path: string }) {
	const language = fileLanguage(path);
	if (language !== "markdown") return <ReaderCode content={content} language={language} />;
	return <article className="reader-markdown">
		<ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
			a: ({ href, children }) => href && /^(https?:|mailto:)/i.test(href)
				? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
			img: ({ src, alt }) => typeof src === "string" && /^https?:\/\//i.test(src)
				? <img src={src} alt={alt ?? ""} loading="lazy" /> : <span>{alt}</span>,
			pre: ({ children }) => <>{children}</>,
			code: ({ children, className }) => {
				const content = String(children);
				if (!className && !content.includes("\n")) return <code>{children}</code>;
				return <ReaderCode content={content.replace(/\n$/, "")} language={className?.replace("language-", "") ?? "plaintext"} />;
			},
		}}>{content}</ReactMarkdown>
	</article>;
}
