import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { NewSessionChat } from "../features/session/components/new-session-chat";
import { zhCNMessages } from "../features/i18n/messages/zh-CN";

const state = vi.hoisted(() => ({ defaultCwd: "/projects/example" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("../components/workspace-sidebar", () => ({ WorkspaceSidebar: () => null }));
vi.mock("../features/chat/components/chat-token-editor", () => ({ ChatTokenEditor: () => null }));
vi.mock("../features/llm-provider/components/model-thinking-selector", () => ({ ModelThinkingSelector: () => null }));
vi.mock("../features/workspace/components/workspace-tree-context", () => ({ useWorkspaceTree: () => ({
 tree: { workspaces: [{ workspace: { id: "w", displayName: "Test", defaultCwd: state.defaultCwd, host: { hostname: "localhost", port: 22 } } }] },
 loading: false, error: null, refresh: vi.fn(),
}) }));

describe("new Session workspace default directory", () => {
 it.each(["/projects/example", "/"])("fills the directory button from workspace default %s", (path) => {
  state.defaultCwd = path;
  const markup = renderToStaticMarkup(<IntlProvider locale="zh-CN" messages={zhCNMessages}><NewSessionChat workspaceId="w" /></IntlProvider>);
  expect(markup).toContain(`title="${path}"`);
  expect(markup).toContain(`aria-label="更改工作目录，当前为 ${path}"`);
  expect(markup).not.toContain('aria-label="使用工作区默认工作目录"');
 });
});
