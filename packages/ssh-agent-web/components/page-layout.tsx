import type { ReactNode } from "react";
import "./page-layout.css";

interface PageHeaderProps {
	title: string;
	subtitle?: string;
	compact?: boolean;
	leading?: ReactNode;
	meta?: ReactNode;
	actions?: ReactNode;
}

/** Persistent context above the page's navigation or content. */
export function PageHeader({ title, subtitle, compact = false, leading, meta, actions }: PageHeaderProps) {
	return (
		<header className={`page-header${compact ? " page-header-compact" : ""}`}>
			{leading}
			<div className="page-header-identity">
				<h1 title={title}>{title}</h1>
				{subtitle ? <p title={subtitle}>{subtitle}</p> : null}
			</div>
			{meta ? <div className="page-header-meta">{meta}</div> : null}
			{actions ? <div className="page-header-actions">{actions}</div> : null}
		</header>
	);
}
