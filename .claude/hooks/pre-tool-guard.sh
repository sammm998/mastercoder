#!/usr/bin/env bash
# PreToolUse: block edits to .env files and commands that would print secrets.
input=$(cat)
read -r tool target <<<"$(printf '%s' "$input" | python3 -c '
import sys,json
d=json.load(sys.stdin); ti=d.get("tool_input",{})
print(d.get("tool_name",""), (ti.get("file_path") or ti.get("command") or "").replace("\n"," "))' 2>/dev/null)"
case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    base=$(basename "$target")
    if [[ "$base" == .env || ( "$base" == .env.* && "$base" != .env.example ) ]]; then
      echo "Blocked: editing $base is not allowed (secrets live only in env; update .env.example instead)." >&2
      exit 2
    fi ;;
  Bash)
    if printf '%s' "$target" | grep -Eqi '(cat|less|more|head|tail|bat|type)\s+[^|;]*\.env(\s|$|\.[a-z]+)' \
      || printf '%s' "$target" | grep -Eqi '(^|[;&|]\s*)(printenv|env)\s*($|[|;&])' \
      || printf '%s' "$target" | grep -Eqi 'echo\s+.*\$\{?[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)'; then
      echo "Blocked: command would print secrets. Reference variable names, not values." >&2
      exit 2
    fi ;;
esac
exit 0
