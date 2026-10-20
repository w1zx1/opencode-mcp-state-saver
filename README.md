# opencode-mcp-state-saver

An OpenCode **v2** plugin: persists the state of MCP servers across restarts.

The problem: the Connect/Disconnect buttons in `/mcps` only last until a restart
(`connect` — "overriding a disabled configuration until restart",
`disconnect` — "removing its tools until reconnected"). After a restart,
the server is enabled again, even if you had disabled it.

The plugin remembers your actions and, on every start, restores the servers
to the state you left them in, via `ctx.mcp.transform`
(`disabled: true/false`) + `ctx.mcp.reload()`.

No ready-made v2 plugin with this behavior was found on npm
(only the paseo plugin `opencode-mcp-toggle` and topic-specific MCP plugins) —
so this one was written.

## How it works

1. On startup, it reads the list of disabled servers from `ctx.storage`
   (key `disabled-servers-v1`) and applies it via a transform:
   `editor.update(name, c => { c.disabled = true })`.
2. It imports `disabled: true` from `opencode.json(c)` into storage on the first
   run, so the flag survives even removal from the config.
3. It listens for `mcp.status.changed` events (+ `mcp.tools.changed`,
   `mcp.resources.changed` as a fallback) and every 3 seconds reconciles
   with `ctx.mcp.list()`:
   - status `disabled` → add to storage (remember "disabled");
   - status `connected` → remove from storage (remember "enabled");
   - `pending` / `failed` / `needs_auth` are ignored — these are not user
     actions.
4. After a change, it calls `ctx.mcp.reload()` so the transform
   is recomputed and the state survives a restart.
5. It cleans up storage of servers that no longer exist in either the config
   or the runtime.

The first ~8 seconds after startup are skipped by synchronization (grace window):
servers transition `pending → connected`, and that must not be counted
as a "connect" press.

## Installation

Option A — globally for all projects:

```sh
# copy the plugin folder
cp -r savemcpstate ~/.config/opencode/plugins/mcp-state-saver
```

Plugins from `~/.config/opencode/plugins/` are picked up automatically.
Or explicitly via config:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./plugins/mcp-state-saver"], // path relative to the config file
}
```

Option B — for a single project only:

```sh
cp -r savemcpstate .opencode/plugins/mcp-state-saver
```

## Verification

1. `opencode mcp list` — note the current state.
2. Open OpenCode, `/mcps`, disable a server.
3. Wait ~5 seconds (so the plugin has time to write to storage).
4. `opencode service restart`.
5. `opencode mcp list` — the server should remain disabled.

Enable it back — after a restart it will remain enabled.

## Options

```jsonc
{
  "plugins": [{ "package": "./plugins/mcp-state-saver", "options": { "pollMs": 3000, "verbose": true } }],
}
```

| Option    | Default | Description                              |
| --------- | ------- | ---------------------------------------- |
| `pollMs`  | `3000`  | Reconciliation interval with `mcp.list()` (min 500) |
| `verbose` | `false` | `[mcp-state-saver]` logs to the server console |

## Limitations

- The state is stored in the plugin's `ctx.storage` (per-location). A global
  server disabled in one project may remain enabled in another project —
  that is the semantics of location-scoped MCP in OpenCode.
- Startup errors (`failed`) and OAuth waiting (`needs_auth`) are not persisted.
