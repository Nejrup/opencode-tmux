# opencode-tmux

Local plugin that manages subagent sessions in tmux panes.

## Overview

When OpenCode runs inside tmux, this plugin spawns each subagent as a sibling pane attached to the same OpenCode server. Child sessions open in new tmux panes while resumed sessions reuse existing tracked panes. Panes clean up automatically when sessions end.

## Behaviors

- **Task queuing**: Intercepts `task` tool calls from parent sessions inside tmux and queues them for child spawning.
- **Sibling pane spawning**: Opens each child session in a new tmux pane split from the existing pane layout.
- **Resumed session reuse**: Finds and reuses tracked panes for sessions that resume (identified by `task_id` matching the session ID).
- **Pane ordering**: First delegated pane opens as a horizontal split. Subsequent panes append as vertical splits below the existing stack, so the oldest pane stays at the top and newer panes appear below.
- **Explicit cleanup**: Closes panes immediately on `session.deleted` events.
- **Deferred cleanup**: Schedules pane closure after `session.idle` with a short delay (4s) and a fresh-pane guard (5s) to prevent flicker when sessions open and close rapidly.
- **Process shutdown**: Immediate pane cleanup attempts a graceful process termination before closing the tmux pane. Deferred idle cleanup closes the pane directly.

## Requirements

- **tmux**: Must be installed and on PATH.
- **Bun**: Used for spawning processes (`Bun.spawnSync`, `Bun.which`).
- **Parent session inside tmux**: `TMUX` and `TMUX_PANE` environment variables must be set.
- **OpenCode server**: The parent session provides `OPENCODE_SERVER_URL`, `OPENCODE_SERVER_USERNAME`, and `OPENCODE_SERVER_PASSWORD` environment variables when needed.

## Local verification

Install dependencies and run the available checks:

```bash
npm install
npm run check:env
npm run typecheck
```

`check:env` validates the expected local environment. `typecheck` is the intended static check for the plugin code.

## Manual smoke test

Verify the full pane spawn and cleanup flow in a live tmux session:

1. Ensure your `opencode.jsonc` points at this plugin entry point (for example `./plugins/opencode-tmux/src/index.ts` in a profile-local setup).
2. Start OpenCode from inside tmux.
3. Trigger a `task` tool call that creates a child session.
4. Confirm a sibling pane appears for the child session.
5. Confirm the pane closes on `session.deleted` or after the idle cleanup delay.

## Entry point

- Source: [`src/index.ts`](src/index.ts)
