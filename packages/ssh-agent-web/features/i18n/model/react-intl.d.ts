import type { MessageId } from "@/features/i18n/messages/zh-CN";
import type { SupportedLocale } from "@/features/i18n/model/locale";

declare global {
	namespace FormatjsIntl {
		interface Message {
			ids: MessageId;
		}
		interface IntlConfig {
			locale: SupportedLocale;
		}
	}
}

export {};
