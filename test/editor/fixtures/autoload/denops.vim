function! denops#notify(plugin, method, args) abort
  call add(g:dps_quota_notify_calls, [a:plugin, a:method, a:args])
endfunction
