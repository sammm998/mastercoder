#!/usr/bin/env bash
# Self-test for pre-tool-guard.sh. Usage: bash .claude/hooks/test-guard.sh
cd "$(dirname "$0")" || exit 1
fail=0
check() { # expected_exit command
  local payload
  payload=$(python3 -c 'import json,sys;print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$2")
  printf '%s' "$payload" | bash ./pre-tool-guard.sh 2>/dev/null
  local got=$?
  if [ "$got" != "$1" ]; then echo "FAIL (want $1 got $got): $2"; fail=1; fi
}
D='$'
check 2 "cat .env"
check 2 "cat apps/x/.env.local"
check 0 "cat .env.example"
check 2 "printenv"
check 2 "env | grep KEY"
check 2 "echo ${D}OPENAI_API_KEY"
check 0 "cat > README.md <<'EOF'
| Env |
EOF"
check 0 "pnpm test"
check 0 "FOO=1 pnpm x"
w=$(python3 -c 'import json;print(json.dumps({"tool_name":"Write","tool_input":{"file_path":"/x/.env"}}))')
printf '%s' "$w" | bash ./pre-tool-guard.sh 2>/dev/null; [ $? = 2 ] || { echo "FAIL write .env"; fail=1; }
[ $fail = 0 ] && echo "guard ok"
exit $fail
