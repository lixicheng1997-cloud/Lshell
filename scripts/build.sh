#!/usr/bin/env bash
# 构建 Windows 安装包（MSI + NSIS）。
#
# 用法：./scripts/build.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "构建 Lshell 安装包…"
bash "$ROOT/scripts/msvc-env.sh" npm run tauri build
