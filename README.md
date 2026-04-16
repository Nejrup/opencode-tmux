# tmux-subagents

Local plugin that opens subagents in sibling tmux panes and cleans those panes up when sessions finish.

## What it does

- Queues `task` launches from a parent session running inside tmux.
- Spawns each child session in a new tmux pane attached to the same OpenCode server.
- Reuses tracked panes for resumed subagent sessions.
- Cleans panes up on `session.deleted` and after `session.idle` auto-close delay.

## Runtime assumptions

- OpenCode runs this plugin with Bun available (`Bun.spawnSync`, `Bun.write`, `Bun.which`).
- The parent session is already inside tmux (`TMUX` and `TMUX_PANE` set).
- `tmux` is installed and on `PATH`.
- The parent runtime provides the OpenCode server URL and auth env vars when needed.

## Local verification

Install package-local dependencies and run the deterministic checks:

```bash
npm install
npm run check:env
npm run typecheck
```

## Manual tmux smoke path

Use a live tmux session with this profile loaded.

1. Keep `opencode.jsonc` pointing at `./plugins/tmux-subagents/src/index.ts`.
2. Start OpenCode from inside tmux.
3. Trigger a `task` tool call that creates a child session.
4. Confirm a sibling pane appears for the child session (the plugin sets an initial sanitized agent label, but the attached OpenCode UI may replace the visible pane title).
5. Confirm the pane closes on `session.deleted` or after the idle cleanup delay.

The package does not ship a fake automated tmux harness; live tmux verification is the practical smoke path for pane spawning and cleanup behavior.

## Entry point

- Source: [`src/index.ts`](src/index.ts)
