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
import { SessionActivityProvider } from "@/features/session-activity/components/session-activity-provider";
import "./globals.css";

const FAVICON_URL = "/favicon.png?v=4";
const FAVICON_16_URL = "/favicon-16.png?v=4";
const FAVICON_32_URL = "/favicon-32.png?v=4";
const APPLE_ICON_URL = "/apple-touch-icon.png?v=4";

export async function generateMetadata(): Promise<Metadata> {
	const locale = await requestLocale();
	return {
		title: "Gori（小猩）",
		description: messagesByLocale[locale]["app.description"],
		icons: {
			icon: [
				{ url: FAVICON_16_URL, type: "image/png", sizes: "16x16" },
				{ url: FAVICON_32_URL, type: "image/png", sizes: "32x32" },
				{ url: FAVICON_URL, type: "image/png", sizes: "256x256" },
			],
			shortcut: [{ url: FAVICON_32_URL, type: "image/png" }],
			apple: [{ url: APPLE_ICON_URL, type: "image/png", sizes: "180x180" }],
		},
	};
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	const locale = await requestLocale();
	return (
		<html lang={locale} dir={localeDirection(locale)} data-locale={locale} suppressHydrationWarning>
			<head>
				<link rel="icon" href={FAVICON_16_URL} type="image/png" sizes="16x16" />
				<link rel="icon" href={FAVICON_32_URL} type="image/png" sizes="32x32" />
				<link rel="icon" href={FAVICON_URL} type="image/png" sizes="256x256" />
				<link rel="shortcut icon" href={FAVICON_32_URL} type="image/png" />
				<link rel="apple-touch-icon" href={APPLE_ICON_URL} sizes="180x180" />
				<script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
			</head>
			<body>
				<LocaleProvider initialLocale={locale}>
					<ThemeProvider>
						<LlmProviderProvider>
							<SettingsProvider><SessionActivityProvider><WorkspaceTreeProvider>{children}</WorkspaceTreeProvider></SessionActivityProvider></SettingsProvider>
						</LlmProviderProvider>
					</ThemeProvider>
				</LocaleProvider>
			</body>
		</html>
	);
}
