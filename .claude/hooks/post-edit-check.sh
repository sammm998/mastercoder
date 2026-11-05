#!/usr/bin/env bash
# PostToolUse: after Edit/Write on a TS file, typecheck + lint the owning package. Non-blocking report.
input=$(cat)
file=$(printf '%s' "$input" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))' 2>/dev/null)
case "$file" in *.ts|*.tsx) ;; *) exit 0 ;; esac
dir=$(dirname "$file")
while [ "$dir" != "/" ] && [ ! -f "$dir/package.json" ]; do dir=$(dirname "$dir"); done
[ -f "$dir/tsconfig.json" ] || exit 0
cd "$dir" || exit 0
out=$( (npx --no-install tsc -p tsconfig.json --noEmit 2>&1 | head -30; npx --no-install eslint "$file" 2>&1 | head -30) )
if [ -n "$out" ]; then
  echo "typecheck/lint issues in $(basename "$dir"):" >&2
  echo "$out" >&2
  exit 2
fi
exit 0
