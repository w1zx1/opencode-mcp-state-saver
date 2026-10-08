import type { Plugin as PluginNS } from "@opencode/plugin";

const STORAGE_KEY = "disabled-servers-v1";
const DEFAULT_POLL_MS = 3000;
const STARTUP_GRACE_MS = 8000;

type StatusString =
  | "connected"
  | "pending"
  | "disabled"
  | "failed"
  | "needs_auth";

interface RuntimeRow {
  name: string;
  status: StatusString;
}

function asArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function readOptions(raw: unknown): { pollMs: number; verbose: boolean } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const pollMs =
    typeof input.pollMs === "number" &&
    Number.isFinite(input.pollMs) &&
    input.pollMs >= 500
      ? Math.floor(input.pollMs)
      : DEFAULT_POLL_MS;
  return { pollMs, verbose: input.verbose === true };
}

function log(verbose: boolean, ...args: unknown[]) {
  if (verbose) console.log("[mcp-state-saver]", ...args);
}

async function readRuntime(ctx: any): Promise<RuntimeRow[]> {
  const out = await ctx.mcp.list();
  const rows = Array.isArray(out) ? out : (out?.data ?? []);
  const result: RuntimeRow[] = [];
  for (const row of rows) {
    const name = (row as any)?.name;
    const status = (row as any)?.status?.status;
    if (typeof name === "string" && typeof status === "string") {
      result.push({ name, status: status as StatusString });
    }
  }
  return result;
}

const definition: PluginNS.Plugin = {
  id: "mcp-state-saver",

  async setup(ctx: any) {
    const { pollMs, verbose } = readOptions(ctx.options);
    const startedAt = Date.now();

    // Persisted set of server names that must stay disabled.
    let persisted = new Set<string>();
    try {
      persisted = new Set(asArray(await ctx.storage.get(STORAGE_KEY)));
    } catch (error) {
      console.error("[mcp-state-saver] storage.get failed, starting empty:", error);
    }
    log(verbose, "loaded disabled:", [...persisted]);

    const save = async () => {
      try {
        await ctx.storage.set(STORAGE_KEY, [...persisted].sort());
      } catch (error) {
        console.error("[mcp-state-saver] storage.set failed:", error);
      }
    };

    // Snapshot of config names seen inside the transform, used for pruning.
    let knownConfigNames = new Set<string>();

    // Apply persisted state on every (re)build. The callback must stay
    // synchronous: it only reads `persisted`, never awaits.
    await ctx.mcp.transform((editor: any) => {
      const entries: ReadonlyArray<readonly [string, any]> = editor.list();
      knownConfigNames = new Set(entries.map(([name]) => name));

      // First run: import `disabled: true` from opencode.json(c) into storage
      // so it survives even if the user later removes the flag from config.
      // Done synchronously here; the async save happens just below.
      let imported = false;
      for (const [name, cfg] of entries) {
        if ((cfg as any)?.disabled === true && !persisted.has(name)) {
          persisted.add(name);
          imported = true;
        }
      }
      if (imported) void save();

      for (const name of persisted) {
        const cfg = editor.get(name);
        if (!cfg) continue; // server removed from config -> pruned in sync()
        if ((cfg as any).disabled !== true) {
          editor.update(name, (draft: any) => {
            draft.disabled = true;
          });
        }
      }
    });

    let syncing = false;
    let needsReload = false;

    const syncFromRuntime = async (reason: string) => {
      if (syncing) return;
      // Skip the startup window: servers flip pending -> connected while the
      // transform above is still reconciling, which would look like the user
      // pressing "connect".
      if (Date.now() - startedAt < STARTUP_GRACE_MS) return;
      syncing = true;
      try {
        const rows = await readRuntime(ctx);
        if (rows.length === 0) return;
        const runtimeNames = new Set(rows.map((r) => r.name));

        // Prune entries for servers that no longer exist anywhere.
        let pruned = false;
        for (const name of [...persisted]) {
          if (!runtimeNames.has(name) && !knownConfigNames.has(name)) {
            persisted.delete(name);
            pruned = true;
          }
        }

        let changed = pruned;
        for (const row of rows) {
          if (row.status === "pending") continue; // still starting, ignore
          if (row.status === "disabled") {
            if (!persisted.has(row.name)) {
              persisted.add(row.name);
              changed = true;
              log(verbose, `persist disabled: ${row.name} (${reason})`);
            }
          } else if (row.status === "connected") {
            if (persisted.has(row.name)) {
              persisted.delete(row.name);
              changed = true;
              log(verbose, `persist enabled: ${row.name} (${reason})`);
            }
          }
          // "failed" / "needs_auth" are not user intent -> never persist.
        }

        if (changed) {
          await save();
          needsReload = true;
        }

        if (needsReload) {
          needsReload = false;
          try {
            await ctx.mcp.reload();
          } catch (error) {
            console.error("[mcp-state-saver] mcp.reload failed:", error);
          }
        }
      } catch (error) {
        console.error("[mcp-state-saver] sync failed:", error);
      } finally {
        syncing = false;
      }
    };

    // Event-driven sync: `mcp.status.changed` fires on connect/disconnect.
    const controller = new AbortController();
    const eventLoop = (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          const type = (event as any)?.type as string | undefined;
          if (
            type === "mcp.status.changed" ||
            type === "mcp.tools.changed" ||
            type === "mcp.resources.changed"
          ) {
            const server = (event as any)?.data?.server;
            log(verbose, `event ${type}`, server ?? "");
            await syncFromRuntime(`event:${type}`);
          }
        }
      } catch (error: any) {
        // AbortError is expected on unload.
        if (error?.name !== "AbortError") {
          console.error("[mcp-state-saver] event loop failed:", error);
        }
      }
    })();

    // Polling fallback: events are ephemeral and can be missed while the
    // plugin is (re)loading, so reconcile periodically as well.
    const timer = setInterval(() => {
      void syncFromRuntime("poll");
    }, pollMs);
    if (typeof (timer as any).unref === "function") (timer as any).unref();

    // One delayed first sync after the grace window, in case no event fires.
    const firstSync = setTimeout(() => {
      void syncFromRuntime("initial");
    }, STARTUP_GRACE_MS + 1000);
    if (typeof (firstSync as any).unref === "function")
      (firstSync as any).unref();

    return () => {
      clearInterval(timer);
      clearTimeout(firstSync);
      controller.abort();
      void eventLoop.catch(() => {});
      log(verbose, "unloaded");
    };
  },
};

export default definition;
