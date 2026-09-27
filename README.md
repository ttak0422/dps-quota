# dps-quota

A denops plugin for checking Codex usage quotas from Vim and Neovim. It provides
the `:Quota` command and a `get` dispatcher API, without adding a dedicated UI.

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
```

## Dispatcher API

`get` returns the result of `account/rateLimits/read` as a dictionary. To fetch
and print it from Neovim Lua:

```lua
local quota = vim.fn["denops#request"]("dps-quota", "get", {})
print(vim.inspect(quota))
```

From Vimscript:

```vim
echo denops#request('dps-quota', 'get', [])
```

The response preserves the fields returned by the server in `rateLimits` and
`rateLimitsByLimitId`. Each `primary` or `secondary` window with a numeric
`usedPercent` gains a derived `remainingPercent = 100 - usedPercent` field.
Missing fields and `null` values are not filled in.

## Configuration

Use Vim global variables to configure the Codex executable and the timeout for
startup, initialization, and the quota request:

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

## Quota semantics and limitations

This plugin reads usage quotas through the Codex app-server
`account/rateLimits/read` method. **Remaining and used percentages describe
usage quotas, not remaining token counts.** Window durations and reset times
come from the server response; the plugin does not assume fixed quota periods.

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
replaced with safe messages. `:Quota` displays only known quota fields; the
`get` API returns the server's quota response with derived remaining
percentages. The plugin does not add authentication data to that response.

## Development

```sh
deno task fmt
deno task check
deno task lint
deno task test
```
