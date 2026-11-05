#!/usr/bin/env bash
# Usage: scripts/new-package.sh <name> [description]
set -euo pipefail
name="$1"; desc="${2:-Forge package}"
dir="packages/$name"
mkdir -p "$dir/src" "$dir/test"
[ -f "$dir/package.json" ] || cat > "$dir/package.json" <<JSON
{
  "name": "@forge/$name",
  "version": "0.1.0",
  "private": true,
  "description": "$desc",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "lint": "eslint src test",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {},
  "devDependencies": {}
}
JSON
[ -f "$dir/tsconfig.json" ] || cat > "$dir/tsconfig.json" <<JSON
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
JSON
[ -f "$dir/src/index.ts" ] || echo "export {};" > "$dir/src/index.ts"
echo "created $dir"
