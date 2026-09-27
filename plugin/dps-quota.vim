if exists('g:loaded_dps_quota')
  finish
endif
let g:loaded_dps_quota = 1

command! -nargs=0 Quota call denops#notify('dps-quota', 'Quota', [])
