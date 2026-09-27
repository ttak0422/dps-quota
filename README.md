# dps-quota

A denops plugin for checking usage quotas from Vim and Neovim. It provides the
`:Quota` command and dispatcher APIs, without adding a dedicated UI. Codex and
an experimental Claude adapter are statically registered; Codex remains the
default.

## Requirements

- Vim or Neovim
- [denops.vim](https://github.com/vim-denops/denops.vim) and Deno
- Codex CLI with support for `codex app-server`, signed in with a ChatGPT
  account (only when using the Codex provider)
- Claude Code credentials (only when using the Claude provider; see
  [Claude authentication](#claude-authentication-and-permissions))

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
:Quota claude
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

local claudeQuota = vim.fn["denops#request"](
  "dps-quota",
  "getQuota",
  { "claude" }
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
echo denops#request('dps-quota', 'getQuota', ['claude'])
```

### Raw API: `get`

`get` is retained for compatibility and returns the selected provider's raw
quota response. For Codex, `get([])` and `get(['codex'])` return the
`account/rateLimits/read` response shape, including `rateLimits` and
`rateLimitsByLimitId`. Numeric `usedPercent` values in Codex `primary` and
`secondary` windows gain a derived `remainingPercent = 100 - usedPercent`. For
Claude, `get(['claude'])` returns the raw JSON response from the experimental
OAuth usage endpoint, including unknown fields. The plugin does not add
authentication data to either raw result. Prefer `getQuota` for code that should
not depend on provider response field names.

```lua
local rawCodexQuota = vim.fn["denops#request"]("dps-quota", "get", { "codex" })
print(vim.inspect(rawCodexQuota))

local rawClaudeQuota = vim.fn["denops#request"]("dps-quota", "get", { "claude" })
print(vim.inspect(rawClaudeQuota))
```

From Vimscript:

```vim
echo denops#request('dps-quota', 'get', [])
```

Both dispatcher methods accept zero arguments or one provider id string. Unknown
providers and invalid arguments fail safely; provider names are looked up only
in the registered provider map.

## Configuration

Select the default provider with `g:quota_provider`. It defaults to `codex` and
is unchanged by the Claude adapter:

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

The Claude provider applies `g:quota_timeout_ms` to the HTTP request and
response body as one operation, and separately to an explicitly enabled Keychain
process wait (followed by bounded process cleanup). It is not an end-to-end
deadline: environment and credential-file lookup are outside those timers.
Credential files are size-bounded and non-regular files are rejected, but
filesystem operations are not deadline-bounded. Claude never changes the default
provider:

```vim
let g:quota_provider = 'claude'
let g:quota_timeout_ms = 15000
let g:quota_claude_keychain = 0
```

For Neovim with Lua:

```lua
vim.g.quota_provider = "claude"
vim.g.quota_timeout_ms = 15000
vim.g.quota_claude_keychain = 0
```

### Claude authentication and permissions

Claude credentials are selected read-only in this order:

1. `QUOTA_CLAUDE_OAUTH_TOKEN`, an explicit quota-specific opt-in.
2. `CLAUDE_CODE_OAUTH_TOKEN`.
3. `claudeAiOauth.accessToken` in `$CLAUDE_CONFIG_DIR/.credentials.json`, or
   `$HOME/.claude/.credentials.json` when `CLAUDE_CONFIG_DIR` is unset or empty.
   An existing `expiresAt` value is validated and expired credentials are
   rejected.
4. macOS Keychain, only when `g:quota_claude_keychain` is exactly `1` (default
   `0`). The lookup uses `/usr/bin/security` and the service name
   `Claude Code-credentials`. Set `g:quota_claude_keychain_service` to override
   that implementation-specific service name, for example with a custom
   `CLAUDE_CONFIG_DIR`.

The provider does not start Claude Code, run an interactive login or refresh
flow, write credentials, or open a browser. Tokens remain in memory for the
request and are not logged, returned by `get`, or included in errors. Keychain
access is opt-in because the system command may prompt. A
`CLAUDE_CODE_OAUTH_TOKEN` created by `claude setup-token` is documented as
suitable only for model requests; its ability to access this usage endpoint is
**not** promised.

Grant the Deno process used by denops only the permissions needed for the
selected auth source and provider:

- `env` access for the Claude token/config variables you use:
  `QUOTA_CLAUDE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`,
  and/or `HOME`.
- `read` access to the selected `.credentials.json` file when using file-based
  authentication.
- `net` access to `api.anthropic.com` when requesting Claude usage.
- `run` access to `/usr/bin/security` only when opting into Keychain lookup.

These are Deno permissions for denops, not permissions granted by this plugin.
Because credential sources are probed in precedence order, allow each variable
that must be checked before your selected source; for normal fallback behavior,
grant access to all four listed variables. No credential file is written or
modified.

## Architecture and adding a provider

`main.ts` composes a small, statically registered provider map. The common
dispatcher selects a registered provider, and the common formatter consumes only
a normalized `QuotaSnapshot`. Provider adapters own their configuration,
authentication, fetching, protocol handling, raw response, and mapping into that
snapshot.

To add an adapter, implement the `QuotaProvider` interface and map its response
to the normalized snapshot in a provider-specific directory, then register the
adapter in `main.ts`. The dispatcher and formatter do not need provider-specific
changes. Provider selection does not load modules dynamically; only providers
explicitly registered by the application can run.

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

The Codex provider does not read authentication files. Codex CLI / app-server
uses its existing sign-in state. Process stderr is discarded, and raw RPC errors
are replaced with safe messages. The raw `get` response contains quota response
data only; authentication data is not added to it.

### Claude OAuth usage

The Claude provider sends a `GET` request to the hard-coded
`https://api.anthropic.com/api/oauth/usage` endpoint with bearer authentication
and the `anthropic-beta: oauth-2025-04-20` header. **This endpoint and the
response schema are undocumented and experimental.** The URL, header, and
expected shape are implementation assumptions, not a supported public API
contract. Requests reject redirects, have a bounded response size and timeout,
and are not retried. Safe errors never include the server response body or
credential values.

Synthetic response fixtures cover `five_hour`, `seven_day`, and optional
`seven_day_*` windows with `utilization` and `resets_at` fields. Null windows
are ignored. The snapshot treats utilization as used percentage and derives
`remainingPercent = 100 - utilization` without clamping; a value above 100 can
therefore produce negative remaining percentage. The adapter assumes a five-hour
duration for `five_hour` and seven days for `seven_day` and its prefixed
windows. These durations are not verified against an official schema. Unknown
response fields stay in the raw result and are not interpreted. `extra_usage` is
preserved only in raw data because it represents monetary budget information,
not a subscription quota percentage. Unrecognized or malformed response shapes
fail safely rather than being reported as no quota.

There has been no authenticated live request or real-credential validation for
this adapter. In particular, endpoint availability, accepted token scopes,
actual response shape, reset timestamp variations, and the assumed window
durations remain unverified. See Anthropic's
[authentication documentation](https://code.claude.com/docs/en/authentication)
and [CLI reference](https://code.claude.com/docs/en/cli-reference) for
documented Claude Code credential behavior; neither documents this quota
endpoint.

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
