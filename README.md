# dps-quota

A denops plugin for checking usage quotas from Vim and Neovim. It provides the
`:Quota` command and dispatcher APIs, without adding a dedicated UI. Codex is
the only provider currently available.

## Requirements

- Vim or Neovim
- [denops.vim](https://github.com/vim-denops/denops.vim) and Deno
- Codex CLI with support for `codex app-server`
- Codex CLI signed in with a ChatGPT account

## Local installation

Install denops.vim and add this repository to your `runtimepath` in your startup
configuration. Alternatively, register both plugins with your plugin manager.

```vim
set runtimepath^=/path/to/dps-quota
```

For Neovim with Lua:

```lua
vim.opt.runtimepath:prepend("/path/to/dps-quota")
```

Restart the editor, then run the following after denops has loaded the plugin:

```vim
:Quota
:Quota codex
```

The provider argument is optional. Without an explicit provider, the plugin uses
`g:quota_provider`, which defaults to `codex`.

## Dispatcher APIs

### Normalized API: `getQuota`

`getQuota` is the recommended API for provider-neutral quota data. Its optional
argument selects a provider; with no argument it uses `g:quota_provider`.

```lua
local quota = vim.fn["denops#request"]("dps-quota", "getQuota", {})
print(vim.inspect(quota))

local codexQuota = vim.fn["denops#request"](
  "dps-quota",
  "getQuota",
  { "codex" }
)
```

The normalized snapshot has this shape:

```ts
{
  provider: { id: string, displayName: string },
  buckets: Array<{
    id?: string,
    displayName: string,
    windows: Array<{
      name: string,
      usedPercent?: number | null,
      remainingPercent?: number | null,
      durationMinutes?: number | null,
      resetsAtEpochSeconds?: number | null,
    }>,
  }>,
}
```

Buckets and windows are lists, not fixed `primary`/`secondary` fields. Durations
are in minutes and reset timestamps are Unix epoch seconds. Percentage values
may be missing or `null` when the provider does not supply them.

From Vimscript:

```vim
echo denops#request('dps-quota', 'getQuota', [])
echo denops#request('dps-quota', 'getQuota', ['codex'])
```

### Raw API: `get`

`get` is retained for compatibility and returns the selected provider's raw
quota response. For Codex, `get([])` and `get(['codex'])` return the
`account/rateLimits/read` response shape, including `rateLimits` and
`rateLimitsByLimitId`. Numeric `usedPercent` values in Codex `primary` and
`secondary` windows gain a derived `remainingPercent = 100 - usedPercent`.
Unknown response fields are preserved. Prefer `getQuota` for code that should
not depend on Codex response field names.

```lua
local rawCodexQuota = vim.fn["denops#request"]("dps-quota", "get", { "codex" })
print(vim.inspect(rawCodexQuota))
```

From Vimscript:

```vim
echo denops#request('dps-quota', 'get', [])
```

Both dispatcher methods accept zero arguments or one provider id string. Unknown
providers and invalid arguments fail safely; provider names are looked up only
in the registered provider map.

## Configuration

Select the default provider with `g:quota_provider`. It defaults to `codex`:

```vim
let g:quota_provider = 'codex'
```

For Neovim with Lua:

```lua
vim.g.quota_provider = "codex"
```

Configure the Codex executable and timeout for startup, initialization, and the
quota request using:

```vim
let g:quota_codex_path = '/opt/homebrew/bin/codex'
let g:quota_timeout_ms = 15000
```

For Neovim with Lua:

```lua
vim.g.quota_codex_path = "/opt/homebrew/bin/codex"
vim.g.quota_timeout_ms = 15000
```

The executable defaults to `codex` on your `PATH` and is launched without a
shell. The timeout must be an integer from 100 to 120000 milliseconds and
defaults to 15000 milliseconds.

## Architecture and adding a provider

`main.ts` composes a small, statically registered provider map. The common
dispatcher selects a registered provider, and the common formatter consumes only
a normalized `QuotaSnapshot`. Provider adapters own their configuration,
fetching, protocol handling, raw response, and mapping into that snapshot.

To add an adapter, implement the `QuotaProvider` interface and map its response
to the normalized snapshot in a provider-specific directory, then register the
adapter in `main.ts`. The dispatcher and formatter do not need provider-specific
changes. Provider selection does not load modules dynamically; only providers
explicitly registered by the application can run. Codex is the only registered
provider in this release.

## Quota semantics and limitations

Codex quotas are read through the Codex app-server `account/rateLimits/read`
method. **Remaining and used percentages describe usage quotas, not remaining
token counts.** Window durations and reset times come from the server response;
the plugin does not assume fixed quota periods.

Protocol reference:
[Codex App Server](https://developers.openai.com/codex/app-server). Live quota
retrieval and display have been verified with Codex CLI 0.157.1, Deno 2.8.0, and
Neovim. The plugin does not send model inference requests or create threads or
turns.

This is an experimental integration: the Codex app-server and rate limits API
may change, and compatibility is not guaranteed. API-key authentication is not
supported for these usage quotas. Sign in with a ChatGPT account using
`codex login`.

The plugin does not read authentication files. Codex CLI / app-server uses its
existing sign-in state. Process stderr is discarded, and raw RPC errors are
replaced with safe messages. The raw `get` response contains quota response data
only; authentication data is not added to it.

## Development

```sh
deno task fmt
deno task check
deno task lint
deno task test
deno task test:editor
```

`deno task test:editor` requires Neovim. It runs the headless command-forwarding
regression test with a stub `denops#notify`; it does not start denops or contact
a quota provider. The equivalent direct command is:

```sh
nvim --headless -u NONE -S test/editor/quota_command_test.vim
```
