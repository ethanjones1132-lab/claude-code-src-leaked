# Claude Code — Source

> **Unofficial public mirror of the Claude Code CLI source.**
> This repository contains the TypeScript/React source code powering [Claude Code](https://claude.ai/code) — Anthropic's official AI-native CLI for software development.

<div align="center">

![Claude Code](https://img.shields.io/badge/Claude%20Code-CLI-blueviolet?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript)
![React](https://img.shields.io/badge/React%20%2B%20Ink-Terminal%20UI-61DAFB?style=for-the-badge&logo=react)
![Bun](https://img.shields.io/badge/Bun-Runtime-f9f1e1?style=for-the-badge&logo=bun)
![Node](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs)
![License](https://img.shields.io/badge/License-See%20Disclaimer-red?style=for-the-badge)

</div>

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Directory Structure](#directory-structure)
- [Tech Stack](#tech-stack)
- [Core Systems Deep Dive](#core-systems-deep-dive)
  - [Query Engine](#query-engine)
  - [Tool System](#tool-system)
  - [Bridge Protocol](#bridge-protocol)
  - [Skills & Plugins](#skills--plugins)
  - [MCP Integration](#mcp-integration)
  - [Permission System](#permission-system)
  - [State Management](#state-management)
- [Feature Flags](#feature-flags)
- [Disclaimers](#disclaimers)
- [Contributing](#contributing)

---

## Overview

**Claude Code** is a terminal-based AI development environment built by Anthropic. It brings Claude's reasoning capabilities directly into your shell, enabling you to:

- Write, edit, and refactor code across entire codebases
- Run shell commands with AI guidance
- Perform multi-step agentic tasks autonomously
- Integrate with IDEs (VS Code, JetBrains), browsers, and mobile apps
- Extend functionality via MCP servers, skills, and plugins
- Manage remote sessions over a bridge protocol
- Schedule background AI agents via cron-like triggers

This repository is a **source-level exploration** of the Claude Code CLI — `~12,000+ lines of TypeScript` across `332+ modules`, `80+ CLI commands`, `46+ tools`, `147 UI components`, and `88 custom hooks`.

---

## Key Features

| Feature | Description |
|---|---|
| **Agentic coding** | Claude autonomously edits files, runs tests, fixes bugs across multi-step tasks |
| **46+ Tools** | Bash, file read/write/edit, web search/fetch, glob, grep, LSP, agents, MCP |
| **80+ Commands** | `commit`, `review`, `diff`, `mcp`, `skills`, `session`, `autofix-pr`, `bughunter`, and more |
| **Plan Mode** | Claude drafts a plan for approval before executing any changes |
| **Multi-agent** | Spawns and orchestrates sub-agents for parallel workloads |
| **Remote Bridge** | Connect CLI to remote execution environments over WebSocket |
| **Skills System** | Define custom slash commands (`/my-skill`) in JavaScript |
| **MCP Protocol** | First-class support for Model Context Protocol servers |
| **Vim Mode** | Full vi-keybinding support in the terminal REPL |
| **Voice Mode** | (Feature-gated) Voice input/output support |
| **IDE Integration** | Bidirectional sync with VS Code and JetBrains via LSP |
| **Worktrees** | Git worktree isolation for parallel agent tasks |
| **Cron Triggers** | Schedule AI agents to run on intervals |
| **Cost Tracking** | Per-session token and dollar cost tracking with model pricing |
| **Theming** | Dark/light terminal themes with design token system |
| **Compaction** | Automatic context window management for long sessions |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          main.tsx                               │
│              (Bootstrap → Init → Query Loop → Cleanup)          │
└──────────────────┬──────────────────────────────────────────────┘
                   │
       ┌───────────▼────────────┐
       │      query.ts          │  ← Core event loop
       │   + QueryEngine.ts     │  ← State, compaction, API
       └───────────┬────────────┘
                   │
     ┌─────────────▼──────────────┐
     │      Claude API (SDK)      │
     │  (streaming, tool_use)     │
     └─────────────┬──────────────┘
                   │
        ┌──────────▼──────────┐
        │    Tool Dispatcher  │
        │    (tools.ts)       │
        └──────────┬──────────┘
                   │
   ┌───────────────┼───────────────┐
   │               │               │
┌──▼──┐      ┌────▼───┐     ┌─────▼────┐
│Bash │      │FileEdit│     │AgentTool │
│Tool │      │Tool    │     │(sub-agent│
└─────┘      └────────┘     │ process) │
                             └──────────┘

  ┌─────────────────────────────────────────┐
  │         Ink (React TUI)                 │
  │  components/ + hooks/ + state/          │
  │  (real-time streaming terminal output)  │
  └─────────────────────────────────────────┘

  ┌─────────────────────────────────────────┐
  │          Bridge (Remote Mode)           │
  │  bridge/ ← WebSocket ← Remote Runner   │
  └─────────────────────────────────────────┘
```

---

## Directory Structure

```
claude-code-src/
│
├── main.tsx               # CLI entry point and main event loop (~4,683 lines)
├── query.ts               # Claude API query + tool execution loop (~1,729 lines)
├── QueryEngine.ts         # Query state, compaction, API orchestration (~1,295 lines)
├── commands.ts            # All 80+ CLI command exports
├── Tool.ts                # Abstract tool interface and types (~792 lines)
├── tools.ts               # Tool registry and instantiation
├── Task.ts                # Task types and ID generation
├── history.ts             # Session history and input cache
├── context.ts             # System/user context assembly
├── cost-tracker.ts        # Token + dollar cost tracking
├── setup.ts               # Pre-init: Node checks, dirs, git, worktrees
│
├── assistant/             # KAIROS assistant mode (feature-gated)
├── bootstrap/             # Bootstrap state management
├── bridge/                # Remote session bridge protocol (33 files)
│   ├── bridgeMain.ts      # Main bridge orchestration (115KB)
│   ├── replBridge.ts      # REPL ↔ remote communication (100KB)
│   ├── remoteBridgeCore.ts
│   ├── createSession.ts
│   └── trustedDevice.ts
│
├── buddy/                 # Companion sprite/animation system
├── cli/                   # Terminal I/O, structured output, transports
├── commands/              # 80+ individual command implementations
│   ├── commit/
│   ├── review/
│   ├── mcp/
│   ├── session/
│   ├── autofix-pr/
│   ├── bughunter/
│   ├── workflows/
│   └── ...
│
├── components/            # 147 React/Ink terminal UI components
│   ├── design-system/
│   ├── agents/
│   └── ...
│
├── constants/             # Product info, OAuth config, XML tags
├── context/               # React context providers
├── coordinator/           # Multi-agent coordinator mode
├── entrypoints/           # cli.tsx, init.ts, mcp.ts, sdk/
├── hooks/                 # 88 custom React hooks
│   ├── useCanUseTool.tsx
│   ├── useGlobalKeybindings.tsx
│   ├── useIDEIntegration.tsx
│   └── ...
│
├── ink/                   # Terminal rendering (Ink wrapper, 51 files)
├── keybindings/           # Keyboard shortcut configuration
├── memdir/                # Memory file management (CLAUDE.md)
├── migrations/            # Database schema migrations
├── native-ts/             # Native TypeScript runtime utilities
├── outputStyles/          # Output formatting styles
├── plugins/               # Plugin system + bundled plugins
├── query/                 # Query planning and optimization
├── remote/                # Remote session (WebSocket, SessionManager)
├── schemas/               # Zod schemas for validation
├── screens/               # Fullscreen UI modes
├── server/                # Local server for IDE integration
│
├── services/              # 39 backend service modules
│   ├── api/               # Claude API client, retry, rate limits
│   ├── mcp/               # MCP server management
│   ├── compact/           # Context compaction
│   ├── analytics/         # GrowthBook, telemetry
│   ├── lsp/               # Language Server Protocol
│   ├── oauth/             # OAuth token management
│   └── ...
│
├── skills/                # Skills system + 19 bundled skills
│   └── bundled/
│       ├── update-config/
│       ├── simplify/
│       ├── loop/
│       ├── schedule/
│       └── ...
│
├── state/                 # Global Zustand-like app state
├── tasks/                 # Background task management
│
├── tools/                 # 46+ tool implementations
│   ├── BashTool/
│   ├── FileEditTool/
│   ├── FileReadTool/
│   ├── FileWriteTool/
│   ├── GlobTool/
│   ├── GrepTool/
│   ├── WebFetchTool/
│   ├── WebSearchTool/
│   ├── AgentTool/
│   ├── SkillTool/
│   ├── MCPTool/
│   ├── EnterPlanModeTool/
│   ├── AskUserQuestionTool/
│   ├── ScheduleCronTool/
│   └── ...
│
├── types/                 # Shared TypeScript types
├── upstreamproxy/         # Upstream HTTP proxy
├── utils/                 # 332+ utility modules
│   ├── bash/
│   ├── permissions/
│   ├── settings/
│   ├── git.ts
│   ├── auth.ts
│   ├── config.ts
│   └── ...
│
├── vim/                   # Vim keybinding mode
└── voice/                 # Voice input/output (feature-gated)
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (strict) |
| Runtime | Node.js 18+ / Bun |
| Terminal UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| State | Custom Zustand-like store |
| API Client | `@anthropic-ai/sdk` |
| Schema Validation | Zod |
| CLI Framework | Commander.js |
| HTTP | Axios |
| MCP | `@modelcontextprotocol/sdk` |
| Analytics | GrowthBook |
| Linting | Biome |
| Colors | Chalk |
| Utilities | lodash-es |

---

## Core Systems Deep Dive

### Query Engine

`query.ts` and `QueryEngine.ts` are the heart of Claude Code:

1. **Context Assembly** — Gathers git status, file contents, memory (CLAUDE.md), and system prompts
2. **API Streaming** — Sends messages to Claude API and streams `text` + `tool_use` events
3. **Tool Dispatch** — Routes `tool_use` blocks to the appropriate tool handler
4. **Result Collection** — Sends tool results back to Claude for continued reasoning
5. **Compaction** — Automatically trims the oldest messages when the context window fills

```
User Input
    ↓
Context Assembly (git, files, memory, system prompt)
    ↓
Claude API Request (streaming)
    ↓
  [text block] → render to terminal
  [tool_use block] → dispatch to tool → execute → collect result → send back
    ↓
Loop until Claude stops calling tools
    ↓
Final response rendered
```

---

### Tool System

Every capability Claude can invoke is a `Tool`:

```typescript
interface Tool {
  name: string
  description: string
  inputSchema: ZodSchema
  execute(input, context): AsyncIterable<ToolResult>
  canUseTool(input, context): PermissionResult
}
```

Tools are registered in `tools.ts` and dispatched by `QueryEngine`. Key tools:

| Tool | What it does |
|---|---|
| `BashTool` | Executes shell commands (with user confirmation) |
| `FileEditTool` | Applies precise string-replacement edits to files |
| `FileReadTool` | Reads files with line-number offsets and limits |
| `FileWriteTool` | Creates or overwrites files |
| `GlobTool` | Finds files by glob pattern, sorted by mtime |
| `GrepTool` | Ripgrep-powered content search with regex |
| `WebFetchTool` | Fetches and extracts text from web pages |
| `WebSearchTool` | Performs web searches |
| `AgentTool` | Spawns isolated sub-agent processes |
| `SkillTool` | Executes user-defined skill scripts |
| `MCPTool` | Invokes tools from MCP servers |
| `EnterPlanModeTool` | Switches to plan-review mode |
| `AskUserQuestionTool` | Prompts the user for input during a task |
| `ScheduleCronTool` | Creates recurring cron-based agent triggers |
| `LSPTool` | Queries language servers for completions/diagnostics |

---

### Bridge Protocol

The bridge system (`bridge/`) enables Claude Code to run in remote or sandboxed environments:

```
Local CLI                           Remote Runner
    │                                    │
    ├── createSession() ─── REST API ───►│
    │                                    │
    ├── replBridge.ts ─── WebSocket ────►│
    │         ◄── streaming results ─────┤
    │                                    │
    ├── trustedDevice.ts (JWT auth)      │
    └── bridgeMain.ts (orchestration)   │
```

Key files:
- `bridgeMain.ts` (~115KB) — Full bridge orchestration
- `replBridge.ts` (~100KB) — REPL message protocol over bridge
- `createSession.ts` — Session provisioning via API
- `trustedDevice.ts` — JWT-based device trust

---

### Skills & Plugins

**Skills** are user-defined slash commands:

```
~/.claude/skills/my-skill.js  →  /my-skill
```

Claude Code dynamically discovers `.js` files in the skills directory, wraps them as `SkillTool` instances, and exposes them as `/command-name` in the REPL.

**19+ bundled skills** include:
- `update-config` — Modify `settings.json` with hooks
- `simplify` — Review and refactor changed code
- `loop` — Run a prompt/command on a recurring interval
- `schedule` — Create scheduled remote agent triggers
- `commit` — Smart git commit with co-author attribution
- `claude-api` — Build apps with the Anthropic SDK
- `review-pr` — AI-powered pull request review

---

### MCP Integration

Claude Code has first-class support for [Model Context Protocol](https://modelcontextprotocol.io):

- **Server Discovery**: Loads MCP servers from official registry + `~/.claude/settings.json`
- **Dynamic Tools**: Generates `Tool` objects from MCP server capabilities at runtime
- **Resources**: Lazily fetches MCP resources on demand
- **Seamless**: MCP tools appear alongside native tools in Claude's tool list

Configure MCP servers:
```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@my-org/mcp-server"]
    }
  }
}
```

---

### Permission System

Every potentially dangerous operation passes through a permission gate:

```
Tool.canUseTool()
    ↓
Permission mode check (interactive / auto / bypass)
    ↓
  [interactive] → show confirmation dialog to user
  [auto]        → allow safe tools, confirm destructive ones
  [bypass]      → allow all (explicit opt-in)
    ↓
Denied operations logged for analytics
```

Modes:
- **Interactive** (default) — Prompts for confirmation on destructive operations
- **Auto** (`--auto`) — Allows most operations, still prompts for very dangerous ones
- **Bypass** (`--dangerously-skip-permissions`) — No prompts (use with caution)

---

### State Management

Global state uses a Zustand-like custom store (`state/`):

```typescript
// Read state
const value = useAppState(s => s.someField)

// Update state
setAppState(s => ({ ...s, someField: newValue }))

// React to changes
onChangeAppState('someField', (newVal, prevVal) => { ... })
```

The `AppStateProvider` wraps the entire React/Ink tree. State mutations are synchronous and immutable.

---

## Feature Flags

Several features are gated by Bun's dead-code-elimination (DCE) via `feature()` calls:

| Flag | Feature |
|---|---|
| `KAIROS` | KAIROS assistant mode |
| `VOICE_MODE` | Voice input/output |
| `BRIDGE_MODE` | Remote bridge support |
| `DAEMON` | Daemon/background mode |
| `COORDINATOR_MODE` | Multi-agent coordinator |
| `PROACTIVE` | Proactive suggestions |
| `MONITOR_TOOL` | Task monitoring tool |
| `AGENT_TRIGGERS` | Cron-based agent scheduling |
| `WORKFLOW_SCRIPTS` | Workflow automation scripts |
| `REACTIVE_COMPACT` | Reactive context compaction |
| `CONTEXT_COLLAPSE` | Context window optimization |
| `EXPERIMENTAL_SKILL_SEARCH` | Fuzzy skill search |

---

## Disclaimers

> **IMPORTANT — Please read before using, forking, or distributing this repository.**

### 1. Intellectual Property

This repository contains source code that is the intellectual property of **Anthropic, PBC**. Claude Code is a commercial product actively developed and maintained by Anthropic. The code in this repository was obtained through legitimate means (client-side distribution) but may be subject to Anthropic's [Terms of Service](https://www.anthropic.com/legal/consumer-terms) and proprietary licensing.

**This is not an officially sanctioned open-source release by Anthropic.**

### 2. No License Grant

The presence of this code on GitHub does **not** constitute an open-source license. No permission is granted to:
- Use this code in production systems
- Redistribute or sublicense this code
- Build commercial products based on this code
- Reverse-engineer Anthropic's systems using this code

If you wish to use Claude Code, please use the **official distribution**: `npm install -g @anthropic-ai/claude-code`

### 3. No Warranty

This code is provided **as-is for educational and research purposes only**. There is no warranty, express or implied. The author(s) of this repository take no responsibility for any damage, data loss, security vulnerabilities, or legal liability arising from use of this code.

### 4. Security

Do **not** use API keys, tokens, or credentials found in or derived from this repository. Anthropic's internal endpoints, authentication mechanisms, and session tokens visible in this code are proprietary. Attempting to access Anthropic's infrastructure using this code without authorization may violate the Computer Fraud and Abuse Act (CFAA) and equivalent laws.

### 5. Accuracy

This is a snapshot of the source at a specific point in time. It may be:
- Out of date compared to the production version
- Missing compiled assets, native modules, or build artifacts required to run
- Incomplete in ways that are not immediately obvious

### 6. Takedown

If you represent Anthropic and wish this repository to be removed, please open an issue or contact the repository owner directly. Takedown requests will be honored immediately.

---

## Contributing

Since this is an unofficial mirror, pull requests are **not** accepted for feature changes.

However, contributions are welcome for:

- **Documentation improvements** — Better explanations, diagrams, annotations
- **Research notes** — Analysis of architectural patterns, performance characteristics
- **Bug documentation** — Identifying and documenting issues (not fixes)

To contribute documentation:
1. Fork the repository
2. Create a branch: `git checkout -b docs/my-improvement`
3. Make your changes
4. Open a pull request with a clear description

---

## Resources

- [Claude Code Official Docs](https://docs.anthropic.com/en/docs/claude-code)
- [Claude Code on npm](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- [Anthropic Website](https://www.anthropic.com)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Anthropic API Docs](https://docs.anthropic.com)

---

<div align="center">

**Star this repo if you found it useful for learning about AI-native CLI architecture.**

Built with Claude Code · Powered by Anthropic

</div>
