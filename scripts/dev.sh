#!/usr/bin/env bash
# 启动 Lshell 开发模式。
#
# 会在 Git Bash 中加载 MSVC 环境（解决 link.exe 被 Git 自带版本抢占的问题），
# 然后运行 Tauri 开发服务器。
#
# 用法：./scripts/dev.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "启动 Lshell 开发模式…"
exec bash "$ROOT/scripts/msvc-env.sh" npm run tauri dev
