import type { ReactNode } from "react";
import "./page-layout.css";

interface PageHeaderProps {
	title: string;
	subtitle?: string;
	compact?: boolean;
	leading?: ReactNode;
	titleTrailing?: ReactNode;
	meta?: ReactNode;
	actions?: ReactNode;
}

/** Persistent context above the page's navigation or content. */
export function PageHeader({ title, subtitle, compact = false, leading, titleTrailing, meta, actions }: PageHeaderProps) {
	return (
		<header className={`page-header${compact ? " page-header-compact" : ""}`}>
			{leading}
			<div className={`page-header-identity${titleTrailing ? " page-header-identity-with-trailing" : ""}`}>
				<div className="page-header-title-line"><h1 title={title}>{title}</h1>{titleTrailing}</div>
				{subtitle ? <p title={subtitle}>{subtitle}</p> : null}
			</div>
			{meta ? <div className="page-header-meta">{meta}</div> : null}
			{actions ? <div className="page-header-actions">{actions}</div> : null}
		</header>
	);
}

interface PageHeadingProps {
	title: string;
	description: string;
	actions?: ReactNode;
}

/** A content title and its related actions, distinct from persistent context. */
export function PageHeading({ title, description, actions }: PageHeadingProps) {
	return (
		<div className="page-heading">
			<div className="min-w-0">
				<h2>{title}</h2>
				<p>{description}</p>
			</div>
			{actions ? <div className="page-heading-actions">{actions}</div> : null}
		</div>
	);
}
