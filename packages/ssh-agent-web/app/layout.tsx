import type { Metadata } from "next";
import { LocaleProvider } from "@/features/i18n/components/locale-provider";
import { messagesByLocale } from "@/features/i18n/messages/messages";
import { localeDirection } from "@/features/i18n/model/locale";
import { requestLocale } from "@/features/i18n/server/request-locale";
import { LlmProviderProvider } from "@/features/llm-provider/components/llm-provider-provider";
import { SettingsProvider } from "@/features/settings/components/settings-provider";
import { ThemeProvider } from "@/features/theme/components/theme-provider";
import { THEME_BOOTSTRAP_SCRIPT } from "@/features/theme/model/theme-bootstrap";
import { WorkspaceTreeProvider } from "@/features/workspace/components/workspace-tree-provider";
import "./globals.css";

const FAVICON_URL = "/favicon.png?v=3";

export async function generateMetadata(): Promise<Metadata> {
	const locale = await requestLocale();
	return {
		title: "Gori（小猩）",
		description: messagesByLocale[locale]["app.description"],
		icons: {
			icon: [{ url: FAVICON_URL, type: "image/png", sizes: "1254x1254" }],
			shortcut: [{ url: FAVICON_URL, type: "image/png" }],
			apple: [{ url: FAVICON_URL, type: "image/png", sizes: "1254x1254" }],
		},
	};
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	const locale = await requestLocale();
	return (
		<html lang={locale} dir={localeDirection(locale)} data-locale={locale} suppressHydrationWarning>
			<head>
				<link rel="icon" href={FAVICON_URL} type="image/png" sizes="1254x1254" />
				<link rel="shortcut icon" href={FAVICON_URL} type="image/png" />
				<link rel="apple-touch-icon" href={FAVICON_URL} sizes="1254x1254" />
				<script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
			</head>
			<body>
				<LocaleProvider initialLocale={locale}>
					<ThemeProvider>
						<LlmProviderProvider>
							<SettingsProvider><WorkspaceTreeProvider>{children}</WorkspaceTreeProvider></SettingsProvider>
						</LlmProviderProvider>
					</ThemeProvider>
				</LocaleProvider>
			</body>
		</html>
	);
}
