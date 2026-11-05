#!/usr/bin/env bash
# PreToolUse: block edits to .env files and commands that would print secrets.
input=$(cat)
read -r tool target <<<"$(printf '%s' "$input" | python3 -c '
import sys,json
d=json.load(sys.stdin); ti=d.get("tool_input",{})
print(d.get("tool_name",""), (ti.get("file_path") or ti.get("command") or "").split("<<")[0].replace("\n"," "))' 2>/dev/null)"
# Note: for Bash, only the part before any heredoc ("<<") is inspected, so file contents being written
# never trigger the guard.
case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    base=$(basename "$target")
    if [[ "$base" == .env || ( "$base" == .env.* && "$base" != .env.example ) ]]; then
      echo "Blocked: editing $base is not allowed (secrets live only in env; update .env.example instead)." >&2
      exit 2
    fi ;;
  Bash)
    # Reading a .env file (not .env.example) with a pager/printer.
    if printf '%s' "$target" | grep -Eq '(^|[;&|[:space:]])(cat|less|more|head|tail|bat|strings|xxd)[[:space:]]+([^[:space:]]*/)?\.env(\.(local|production|development|test))?([[:space:]]|$)' \
      || printf '%s' "$target" | grep -Eq '(^|[;&|][[:space:]]*)(printenv|env|set)[[:space:]]*($|[|;&>])' \
      || printf '%s' "$target" | grep -Eq '(echo|printf)[[:space:]].*\$\{?[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)'; then
      echo "Blocked: command would print secrets. Reference variable names, not values." >&2
      exit 2
    fi ;;
esac
exit 0
