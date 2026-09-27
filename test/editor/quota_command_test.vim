let s:repo_root = fnamemodify(expand('<sfile>:p'), ':h:h:h')
execute 'set runtimepath^=' . fnameescape(s:repo_root . '/test/editor/fixtures')
execute 'set runtimepath^=' . fnameescape(s:repo_root)

let g:dps_quota_notify_calls = []
runtime plugin/dps-quota.vim

Quota
Quota codex

call assert_equal([
      \ ['dps-quota', 'Quota', []],
      \ ['dps-quota', 'Quota', ['codex']],
      \ ], g:dps_quota_notify_calls)

if !empty(v:errors)
  for s:error in v:errors
    echomsg s:error
  endfor
  cquit 1
endif
qa!
