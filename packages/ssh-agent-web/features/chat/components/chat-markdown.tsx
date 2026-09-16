"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useIntl } from "react-intl";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function ChatMarkdown({ children, subtle = false }: { children: string; subtle?: boolean }) {
	return (
		<div className={`chat-markdown ${subtle ? "chat-markdown-subtle" : ""}`}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ children: label, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{label}</a>,
					pre: ({ children: preChildren }) => <>{preChildren}</>,
					code: ({ children: codeChildren, className }) => {
						const code = String(codeChildren).replace(/\n$/, "");
						const language = className?.replace("language-", "") ?? "";
						if (!className && !String(codeChildren).includes("\n")) return <code>{codeChildren}</code>;
						return <CodeBlock code={code} language={language} />;
					},
				}}
			>{children}</ReactMarkdown>
		</div>
	);
}

function CodeBlock({ code, language }: { code: string; language: string }) {
	const intl = useIntl();
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1_500);
		} catch {
			setCopied(false);
		}
	};
	return (
		<div className="chat-code-block">
			<div className="chat-code-header"><span>{language || "code"}</span><button type="button" onClick={() => void copy()}>{copied ? <Check size={11} /> : <Copy size={11} />}{intl.formatMessage({ id: copied ? "chat.code.copied" : "chat.code.copy" })}</button></div>
			<pre><code>{code}</code></pre>
		</div>
	);
}
