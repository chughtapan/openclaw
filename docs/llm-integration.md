# How OpenClaw's LLM Integration Works

OpenClaw is a multi-channel AI gateway that orchestrates Large Language Model (LLM) interactions across messaging platforms (Telegram, Discord, Slack, WhatsApp, Signal, iMessage, and more). This document explains the end-to-end architecture of how LLM calls are made, from an incoming user message to a streamed response.

---

## High-Level Architecture

```
User Message (Telegram / Discord / Slack / WhatsApp / ...)
    │
    ▼
Gateway Layer (WebSocket + HTTP)
    │
    ▼
Agent Runner  (pi-embedded-runner)
    │
    ├─► Model Selection & Auth Resolution
    ├─► System Prompt Construction
    ├─► Tool Definition Assembly
    │
    ▼
Pi SDK  (streamSimple / createAgentSession)
    │
    ▼
LLM Provider API  (Anthropic, OpenAI, Gemini, Ollama, ...)
    │
    ▼
Streaming Response Processing
    │
    ├─► Tool Call Execution (if any)
    │     └─► Results fed back to LLM
    │
    ▼
Formatted Reply → Messaging Channel
```

---

## Core Components

### 1. The Pi SDK Foundation

OpenClaw delegates all direct LLM communication to the **Pi SDK**, a set of three packages:

| Package | Role |
|---------|------|
| `@mariozechner/pi-ai` | Low-level streaming inference (`streamSimple`), image content types |
| `@mariozechner/pi-agent-core` | Agent message types, session abstractions |
| `@mariozechner/pi-coding-agent` | High-level agent sessions (`createAgentSession`, `SessionManager`, `SettingsManager`), model registry |

The SDK provides a unified interface over multiple LLM provider APIs, handling serialization, streaming, token counting, and tool-call extraction. OpenClaw never constructs raw HTTP requests to LLM providers — it always goes through the Pi SDK.

**Key import** (`src/agents/pi-embedded-runner/run/attempt.ts:3-4`):
```typescript
import { streamSimple } from "@mariozechner/pi-ai";
import { createAgentSession, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
```

### 2. Model Catalog & Discovery

Models are discovered and cataloged at startup via `loadModelCatalog()` in `src/agents/model-catalog.ts:41`. Each model entry contains:

```typescript
type ModelCatalogEntry = {
  id: string;            // e.g. "claude-opus-4-6"
  name: string;          // Human-readable name
  provider: string;      // e.g. "anthropic", "openai"
  contextWindow?: number;// e.g. 200000
  reasoning?: boolean;   // Supports extended thinking?
  input?: Array<"text" | "image">;
};
```

The catalog merges models from two sources:
- **Implicit providers** — built-in definitions in `src/agents/models-config.providers.ts` for 15+ providers
- **Explicit config** — user-defined models in `~/.openclaw/openclaw.json` under `models.providers`

The merge mode (`"merge"` or `"replace"`) determines whether user config supplements or overrides the built-ins.

### 3. Supported LLM Providers

OpenClaw supports a broad range of providers out of the box (defined in `src/agents/models-config.providers.ts`):

| Provider | Protocol | Notable Features |
|----------|----------|-----------------|
| **Anthropic** | Native Anthropic API | Prompt caching, extended thinking |
| **OpenAI** | OpenAI completions | Function calling, vision |
| **Google Gemini** | OpenAI-compatible | Safety settings, special turn ordering |
| **Ollama** | OpenAI-compatible | Local inference (127.0.0.1:11434) |
| **Amazon Bedrock** | AWS SDK auth | AWS-hosted models |
| **OpenRouter** | OpenAI-compatible | Multi-model gateway |
| **Groq** | OpenAI-compatible | Fast inference |
| **Mistral** | OpenAI-compatible | Mistral models |
| **MiniMax** | OpenAI-compatible | Chinese LLM provider |
| **Moonshot (Kimi)** | OpenAI-compatible | Long-context models |
| **Venice AI** | OpenAI-compatible | Privacy-focused |
| **GitHub Copilot** | OAuth + OpenAI-compat | Token refresh flow |
| **Cloudflare AI Gateway** | OpenAI-compatible | Edge inference |
| **Vercel AI Gateway** | OpenAI-compatible | Vercel-hosted |

All OpenAI-compatible providers share the `openai-completions` API protocol, meaning adding a new provider often requires only a base URL and API key.

---

## Request Lifecycle

### Step 1: Message Ingestion

A user message arrives through a messaging channel (Telegram, Discord, etc.) and is routed to the agent handler. The gateway layer (`src/gateway/`) supports three protocols:

- **WebSocket** — Custom real-time protocol (`src/gateway/server-methods/chat.ts`)
- **OpenAI-compatible HTTP** — `/v1/chat/completions` (`src/gateway/openai-http.ts`)
- **OpenResponses HTTP** — `/v1/responses` (`src/gateway/openresponses-http.ts`)

### Step 2: Agent Run Initialization

The `runEmbeddedAttempt()` function (`src/agents/pi-embedded-runner/run/attempt.ts:140`) is the main entry point. It:

1. Resolves the workspace directory and optional sandbox
2. Loads workspace skill entries (SKILL.md files)
3. Loads bootstrap context files (AGENTS.md, SOUL.md, TOOLS.md)
4. Resolves channel capabilities (what the messaging platform supports)

### Step 3: Model Selection & Authentication

**Model selection** (`src/agents/model-selection.ts`) picks a model based on:
- The agent's configured primary model
- User overrides per session
- Fallback defaults

**Authentication** (`src/agents/model-auth.ts`, `src/agents/auth-profiles/`) resolves credentials through:
1. Stored auth profiles in `~/.openclaw/auth.json`
2. Environment variables (e.g. `ANTHROPIC_API_KEY`)
3. OAuth token flows (for GitHub Copilot, Qwen Portal)
4. AWS SDK credentials (for Bedrock)

Profiles support round-robin failover — if one API key hits rate limits, the system rotates to the next.

### Step 4: System Prompt Construction

The system prompt is built by `buildEmbeddedSystemPrompt()` (`src/agents/pi-embedded-runner/system-prompt.ts:11`), assembling these sections in `src/agents/system-prompt.ts`:

| Section | Purpose |
|---------|---------|
| **Identity** | Who the AI persona is (from SOUL.md) |
| **Skills** | Available SKILL.md entries for domain-specific behavior |
| **Memory Recall** | Instructions for searching memory files |
| **User Identity** | Owner phone numbers / identifiers |
| **Date & Time** | Current timezone and timestamp |
| **Reply Tags** | Platform-native features (reactions, buttons, etc.) |
| **Channel Tools** | Messaging-platform-specific tool hints |
| **Tools** | Available tools (bash, web search, image gen, etc.) |
| **Runtime Info** | Current model, provider, capabilities |
| **Bootstrap Files** | AGENTS.md, SOUL.md, TOOLS.md contents |

The prompt mode can be `"full"` (main agent), `"minimal"` (subagents), or `"none"` (bare identity).

### Step 5: Tool Assembly

Tools are created by `createOpenClawCodingTools()` (`src/agents/pi-tools.ts`) and adapted for the Pi SDK via `toClientToolDefinitions()` (`src/agents/pi-tool-definition-adapter.ts`). Available tools include:

- **Shell**: `exec`, `bash_process` (PTY-based)
- **File I/O**: `read`, `write`, `edit`
- **Web**: `web_search` (Brave), `web_fetch`
- **Media**: `image_generate` (DALL-E)
- **Memory**: `memory_search`, `memory_get`
- **Messaging**: `telegram`, `discord`, `slack`, `whatsapp`, etc.
- **Sessions**: `sessions_spawn` (subagent creation)

### Step 6: LLM Invocation via Pi SDK

The assembled session (system prompt + conversation history + tool definitions) is passed to the Pi SDK's `streamSimple()` function. The SDK:

1. Serializes the request for the target provider's API format
2. Sends the HTTP request with appropriate auth headers
3. Parses the streaming response (SSE for most providers)
4. Extracts text chunks, tool calls, and usage metadata
5. Emits events that OpenClaw subscribes to

### Step 7: Streaming & Event Handling

`subscribeEmbeddedPiSession()` (`src/agents/pi-embedded-subscribe.ts:31`) subscribes to the Pi SDK's event stream. Events are dispatched through a handler chain:

| Handler File | Responsibility |
|-------------|---------------|
| `pi-embedded-subscribe.handlers.ts` | Main event dispatch |
| `pi-embedded-subscribe.handlers.lifecycle.ts` | Session start/end |
| `pi-embedded-subscribe.handlers.messages.ts` | Assistant text streaming |
| `pi-embedded-subscribe.handlers.tools.ts` | Tool call execution |

Key streaming features:
- **Partial replies** — text chunks streamed to the user in real time
- **Reasoning streaming** — thinking/reasoning blocks for models with extended thinking
- **Block chunking** — grouping chunks by message boundaries for clean UI updates

### Step 8: Tool Execution Loop

When the LLM emits a tool call:

1. The tool handler identifies and validates the tool
2. The tool is executed (e.g., running a shell command, fetching a URL)
3. The result is truncated if too large (`src/agents/pi-embedded-runner/tool-result-truncation.ts`)
4. The result is fed back into the conversation
5. The LLM generates the next response (which may include more tool calls)

This loop continues until the LLM produces a final text response with no tool calls.

### Step 9: Response Delivery

`buildEmbeddedRunPayloads()` (`src/agents/pi-embedded-runner/run/payloads.ts:23`) assembles the final response payloads, which may include:
- Text messages
- Media URLs (images, files)
- Error indicators

These payloads are sent back through the originating messaging channel.

---

## Error Handling & Failover

The `FailoverError` class (`src/agents/failover-error.ts:6`) categorizes LLM errors:

| Reason | HTTP Status | Behavior |
|--------|------------|----------|
| `billing` | 402 | Quota exhausted — rotate auth profile |
| `rate_limit` | 429 | Too many requests — rotate or wait |
| `auth` | 401 | Invalid credentials — try next profile |
| `timeout` | 408 | Request timed out — retry |
| `format` | 400 | Malformed request — log and report |

Error classification happens in `src/agents/pi-embedded-helpers/errors.ts`, which detects patterns like context window overflow, compaction failures, and provider-specific error formats. The failover strategy:

1. Try the primary auth profile
2. Rotate to secondary profiles (round-robin)
3. Optionally switch to an alternative model
4. Emit a failover event to inform the user
5. Return a formatted error message if all options are exhausted

---

## Token Management & Context Window

### Context Window Guard
`src/agents/context-window-guard.ts` validates that the conversation fits within the model's context window before sending.

### Conversation Compaction
When conversations grow too long, `src/agents/pi-embedded-runner/compact.ts` and `src/agents/compaction.ts` summarize earlier turns to free up context space while preserving essential information.

### Tool Result Truncation
`src/agents/pi-embedded-runner/tool-result-truncation.ts` caps tool output size to prevent blowing the context budget on a single large result.

---

## Prompt Caching

For Anthropic models, OpenClaw supports native prompt caching (`src/agents/pi-embedded-runner/cache-ttl.ts`). This reduces cost and latency for repeated system prompts by caching them server-side. Cache eligibility is checked with `isCacheTtlEligibleProvider()`, and TTL timestamps are appended to enable cache reuse.

---

## Embeddings & Memory

The memory system (`src/agents/memory-search.ts`) supports semantic search over stored memories using embeddings:

| Provider | Default Model |
|----------|--------------|
| OpenAI | `text-embedding-3-small` |
| Google Gemini | `gemini-embedding-001` |
| Voyage | `voyage-4-large` |
| Local | Self-hosted model |

Embeddings are stored in SQLite with a vector extension, enabling similarity search over the agent's long-term memory files (`MEMORY.md`, `memory/*.md`).

---

## Provider-Specific Handling

Some providers require special treatment:

- **Google Gemini** (`src/agents/pi-embedded-runner/google.ts`) — Custom turn ordering, safety setting adjustments, tool schema sanitization
- **OpenAI** (`src/agents/pi-embedded-helpers/openai.ts`) — Reasoning level downgrade for unsupported models
- **Anthropic** (`src/agents/anthropic-payload-log.ts`) — Debug payload logging, native caching, turn validation via `validateAnthropicTurns()`

---

## Configuration

All LLM configuration lives in `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6"
      }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "anthropic": {
        "apiKey": "ANTHROPIC_API_KEY",
        "models": [
          {
            "id": "claude-opus-4-6",
            "contextWindow": 200000,
            "reasoning": true,
            "input": ["text", "image"]
          }
        ]
      },
      "ollama": {
        "baseUrl": "http://127.0.0.1:11434/v1",
        "models": [
          { "id": "llama3", "contextWindow": 8192 }
        ]
      }
    }
  }
}
```

Model configuration types are defined in `src/config/types.models.ts`, with Zod validation schemas in `src/config/zod-schema.providers.ts`.

---

## Summary

OpenClaw's LLM integration is a layered architecture:

1. **Gateway Layer** — Accepts messages from 10+ messaging platforms and HTTP/WS APIs
2. **Agent Runner** — Orchestrates model selection, prompt construction, and tool assembly
3. **Pi SDK** — Provides unified streaming inference across all supported providers
4. **Failover & Auth** — Manages multi-profile authentication with automatic rotation on errors
5. **Streaming Pipeline** — Delivers partial responses in real time with tool execution loops
6. **Memory & Context** — Manages long conversations through compaction, caching, and embeddings

The design philosophy is provider-agnostic: all provider-specific logic is isolated behind the Pi SDK's abstractions and OpenClaw's provider helpers, so the core agent loop works identically regardless of whether the underlying model is Claude, GPT, Gemini, or a local Ollama instance.
