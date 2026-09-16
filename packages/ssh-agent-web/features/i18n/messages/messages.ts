import { enUSMessages } from "@/features/i18n/messages/en-US";
import { zhCNMessages, type MessageId } from "@/features/i18n/messages/zh-CN";
import type { SupportedLocale } from "@/features/i18n/model/locale";

export const messagesByLocale = {
	"zh-CN": zhCNMessages,
	"en-US": enUSMessages,
} satisfies Record<SupportedLocale, Record<MessageId, string>>;
