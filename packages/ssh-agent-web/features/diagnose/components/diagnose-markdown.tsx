import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Uses the existing Markdown dependencies and safe external-link policy, independent of Chat internals. */
export function DiagnoseMarkdown({ content }: { content: string }) {
	return <article className="diagnose-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
		a: ({ href, children }) => href && /^(https?:|mailto:)/i.test(href)
			? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
		img: ({ alt }) => <span>{alt}</span>,
	}}>{content}</ReactMarkdown></article>;
}
