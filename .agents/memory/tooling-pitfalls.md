---
name: Tooling pitfalls
description: Sharp edges in shell/dev tooling used in this repo.
---

# Tooling pitfalls

## ripgrep: never write `rg -rn` / `rg -r<x>`
`-r` is `--replace`, not "recursive" (rg recurses by default). `rg -rn "pat"`
is parsed as `--replace=n`, so every match is rewritten to the literal `n` in
the output and you get garbage/misleading results. Use `rg -n "pat"` (or
`rg --no-config -n "pat"`). This bit me twice in one session.
