// deno-lint-ignore no-import-prefix
import type { Entrypoint } from "https://deno.land/x/denops_std@v6.5.0/mod.ts";
import { createDispatcher } from "./dispatcher.ts";
import type { QuotaProvider } from "./quota.ts";
import { createCodexProvider } from "./providers/codex/provider.ts";
import { createClaudeProvider } from "./providers/claude/provider.ts";

export const main: Entrypoint = (denops) => {
  const providers = new Map<string, QuotaProvider>([
    ["codex", createCodexProvider((expression) => denops.eval(expression))],
    ["claude", createClaudeProvider((expression) => denops.eval(expression))],
  ]);
  denops.dispatcher = createDispatcher(denops, providers, "codex");
};
