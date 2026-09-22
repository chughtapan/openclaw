import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { sanitizeChatHistoryMessages } from "../../gateway/chat-display-projection.sanitize.js";
import { aggregateSessionTranscriptUsage } from "../../gateway/session-transcript-derived-readers.js";
import { computeUsageTokenTotals } from "../../infra/session-cost-usage-pricing.js";
import type { AssistantMessage } from "../../llm/types.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/hook-types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { isIntermediateAssistantTranscriptMessage } from "../embedded-agent-runner/message-visibility.js";
import { normalizeUsage } from "../usage.js";
import { persistCliAssistantTranscript } from "./cli-run-transcript.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());
afterEach(() => resetGlobalHookRunner());

it.each([
  { sourceTool: "sessions_send", hidden: true },
  { sourceTool: "subagent_announce", hidden: false },
])(
  "preserves CLI $sourceTool output with its display policy after hooks",
  async ({ sourceTool, hidden }) => {
    const root = tempDirs.make("openclaw-cli-coordination-transcript-");
    const target = {
      agentId: "main",
      sessionId: "cli-coordination-session",
      sessionKey: "agent:main:cli-coordination",
      storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: Date.now() },
    });
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "rewrite-output",
      hookName: "before_message_write",
      source: "test",
      handler: ({ message }: PluginHookBeforeMessageWriteEvent) => ({
        message: { ...message, display: true },
      }),
    });
    initializeGlobalHookRunner(registry);
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const result = await persistCliAssistantTranscript({
        runParams: {
          ...target,
          sessionFile: `sqlite://agents/main/${target.sessionId}`,
          workspaceDir: root,
          prompt: "Review the worker result",
          provider: "claude-cli",
          runId: "cli-coordination-run",
          timeoutMs: 1_000,
          persistAssistantTranscript: true,
          inputProvenance: { kind: "inter_session", sourceTool, sourceRole: "subagent" },
        },
        text: "The worker result passed validation",
        modelId: "claude-sonnet-4-6",
        stopReason: "stop",
      });
      expect(result.owned).toBe(true);
      const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
        typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
      );
      expect(messages).toMatchObject([
        {
          role: "assistant",
          content: [{ type: "text", text: "The worker result passed validation" }],
        },
      ]);
      expect(Reflect.get(messages[0]!, "display") === false).toBe(hidden);
      expect(updates).toHaveLength(1);
      expect(Reflect.get(updates[0]!.message!, "display") === false).toBe(hidden);
    } finally {
      unsubscribe();
    }
  },
);

it.each([
  { kind: "completed", yielded: undefined, stopReason: "stop" },
  { kind: "yielded", yielded: true, stopReason: "stop" },
  { kind: "interrupted", yielded: undefined, stopReason: "aborted" },
  { kind: "interrupted after yielding", yielded: true, stopReason: "aborted" },
] as const)(
  "prepares the $kind CLI assistant before its first transcript publication",
  async ({ yielded, stopReason }) => {
    const root = tempDirs.make("openclaw-cli-media-transcript-");
    const target = {
      agentId: "main",
      sessionId: "cli-media-session",
      sessionKey: "agent:main:cli-media",
      storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: Date.now() },
    });
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) =>
      applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./artifact.json"] }),
    );
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const result = await persistCliAssistantTranscript({
        runParams: {
          ...target,
          sessionFile: `sqlite://agents/main/${target.sessionId}`,
          workspaceDir: root,
          prompt: "make an artifact",
          provider: "claude-cli",
          runId: "cli-media-run",
          timeoutMs: 1_000,
          persistAssistantTranscript: true,
          prepareAssistantTranscriptMessage,
        },
        text: sourceText,
        modelId: "claude-sonnet-4-6",
        stopReason,
        yielded,
      });
      expect(result.owned).toBe(true);
      expect(prepareAssistantTranscriptMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ content: [{ type: "text", text: sourceText }] }),
        sourceText,
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]?.message).toMatchObject({
        content: [{ type: "text", text: sourceText }],
        idempotencyKey: result.idempotencyKey,
        openclawDelivery: { mediaUrls: ["./artifact.json"] },
      });
      const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
        typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
      );
      expect(messages).toHaveLength(1);
      expect(isIntermediateAssistantTranscriptMessage(messages[0])).toBe(
        yielded === true && stopReason === "stop",
      );
      expect(messages[0]).toMatchObject({ stopReason });
      if (yielded && stopReason === "stop") {
        expect(messages[0]).toMatchObject({
          openclawStreamFallback: {
            replacementText: sourceText,
            source: "segment",
            itemId: "cli-media-run",
          },
        });
      } else {
        expect(messages[0]).not.toHaveProperty("openclawStreamFallback");
      }
      expect(sanitizeChatHistoryMessages(messages)).toMatchObject([
        { content: [{ type: "text", text: "Artifacts ready" }] },
      ]);
    } finally {
      unsubscribe();
    }
  },
);

const LAST_CALL = { input: 11, output: 7, total: 18 };
const RUN = { input: 21, output: 9, total: 30 };

type CliUsageCounts = { input?: number; output?: number; total?: number };

/**
 * Persists one CLI assistant row through the real SQLite transcript and returns
 * the stored assistant messages.
 * @param usage The backend's last model call.
 * @param runUsage The backend's cumulative run usage, when it reports one.
 */
async function persistCliUsageRow(
  usage: CliUsageCounts | undefined,
  runUsage: CliUsageCounts | undefined,
): Promise<AssistantMessage[]> {
  const root = tempDirs.make("openclaw-cli-usage-transcript-");
  const target = {
    agentId: "main",
    sessionId: "cli-usage-session",
    sessionKey: "agent:main:cli-usage",
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  await persistCliAssistantTranscript({
    runParams: {
      ...target,
      sessionFile: `sqlite://agents/main/${target.sessionId}`,
      workspaceDir: root,
      prompt: "read three files",
      provider: "claude-cli",
      runId: "cli-usage-run",
      timeoutMs: 1_000,
      persistAssistantTranscript: true,
    },
    text: "done",
    modelId: "claude-sonnet-4-6",
    stopReason: "stop",
    ...(usage ? { usage } : {}),
    ...(runUsage ? { runUsage } : {}),
  });
  return (await loadTranscriptEvents(target)).flatMap((event) =>
    typeof event === "object" && event !== null && "message" in event
      ? [event.message as AssistantMessage]
      : [],
  );
}

it("bills a CLI run's cumulative usage with a total in the same scope", async () => {
  const [message] = await persistCliUsageRow(LAST_CALL, RUN);

  expect(message?.usage).toMatchObject({ input: 21, output: 9, totalTokens: 30 });
});

it("keeps a CLI run's last model call as the transcript context snapshot", async () => {
  const [message] = await persistCliUsageRow(LAST_CALL, RUN);

  expect(message?.usage.contextUsage).toEqual({
    state: "available",
    promptTokens: 11,
    totalTokens: 18,
  });
});

it("totals a CLI run's counters when the backend omits the run total", async () => {
  const [message] = await persistCliUsageRow(LAST_CALL, { input: 21, output: 9 });

  expect(message?.usage.totalTokens).toBe(30);
});

it("bills the last call when a CLI backend reports no run usage", async () => {
  const [message] = await persistCliUsageRow(LAST_CALL, undefined);

  expect(message?.usage).toMatchObject({ input: 11, output: 7, totalTokens: 18 });
});

it("reports a persisted CLI run's cumulative total to usage billing", async () => {
  const [message] = await persistCliUsageRow(LAST_CALL, RUN);

  expect(computeUsageTokenTotals(normalizeUsage(message?.usage) ?? {}).totalTokens).toBe(30);
});

it("reports a persisted CLI run's last call to the session context reader", async () => {
  const messages = await persistCliUsageRow(LAST_CALL, RUN);

  expect(aggregateSessionTranscriptUsage(messages)?.totalTokens).toBe(11);
});
