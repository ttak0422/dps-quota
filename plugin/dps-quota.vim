if exists('g:loaded_dps_quota')
  finish
endif
let g:loaded_dps_quota = 1

command! -nargs=? Quota call denops#notify('dps-quota', 'Quota', [<f-args>])
