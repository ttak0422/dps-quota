// deno-lint-ignore no-import-prefix
import type { Entrypoint } from "https://deno.land/x/denops_std@v6.5.0/mod.ts";
import { createDispatcher } from "./dispatcher.ts";

export const main: Entrypoint = (denops) => {
  denops.dispatcher = createDispatcher(denops);
};
