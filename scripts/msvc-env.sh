#!/usr/bin/env bash
# 在 Git Bash 中加载 MSVC 构建环境并执行命令。
#
# 背景：Git Bash 自带 GNU 版的 link.exe，会遮蔽 MSVC 的链接器，
# 导致 cargo 报 "link: extra operand"。必须把 MSVC 的 bin 目录放到 PATH 最前面，
# 并补充 Windows SDK 的库路径。
#
# 用法：./scripts/msvc-env.sh cargo build --release

set -euo pipefail

# 工具链位置：优先用 E 盘（数据已迁走），回退 C 盘
# 显式设置 BUILD_TOOLS / WINDOWS_KITS_ROOT 可覆盖
BUILD_TOOLS="${BUILD_TOOLS:-}"
if [ -z "$BUILD_TOOLS" ]; then
  for candidate in "E:/data/BuildTools" "C:/BuildTools"; do
    if [ -d "$candidate/VC/Tools/MSVC" ]; then
      BUILD_TOOLS="$candidate"
      break
    fi
  done
fi

if [ -z "$BUILD_TOOLS" ] || [ ! -d "$BUILD_TOOLS/VC/Tools/MSVC" ]; then
  echo "错误：未找到 MSVC 工具链，请先安装 VS Build Tools" >&2
  echo "  winget install --id Microsoft.VisualStudio.2022.BuildTools" >&2
  exit 1
fi

VC_VER="$(ls "$BUILD_TOOLS/VC/Tools/MSVC" 2>/dev/null | sort -V | tail -1)"

if [ -z "$VC_VER" ]; then
  echo "错误：未找到 MSVC 工具链，请先安装 VS Build Tools" >&2
  echo "  winget install --id Microsoft.VisualStudio.2022.BuildTools" >&2
  exit 1
fi

VC_BIN="$BUILD_TOOLS/VC/Tools/MSVC/$VC_VER/bin/Hostx64/x64"

# Windows SDK 版本目录：同样优先 E 盘
SDK_ROOT="${WINDOWS_KITS_ROOT:-}"
if [ -z "$SDK_ROOT" ]; then
  for candidate in "E:/data/WindowsKits/10" "C:/Program Files (x86)/Windows Kits/10"; do
    if [ -d "$candidate/Include" ]; then
      SDK_ROOT="$candidate"
      break
    fi
  done
fi

SDK_VER=""
if [ -n "$SDK_ROOT" ] && [ -d "$SDK_ROOT/Include" ]; then
  SDK_VER="$(ls "$SDK_ROOT/Include" 2>/dev/null | sort -V | tail -1)"
fi

if [ -n "$SDK_VER" ]; then
  export LIB="$VC_BIN/../lib;$SDK_ROOT/Lib/$SDK_VER/um/x64;$SDK_ROOT/Lib/$SDK_VER/ucrt/x64"
  export INCLUDE="$VC_BIN/../include;$SDK_ROOT/Include/$SDK_VER/um;$SDK_ROOT/Include/$SDK_VER/shared;$SDK_ROOT/Include/$SDK_VER/ucrt"
fi

# MSVC 的 bin 必须排在 PATH 最前，避免被 Git Bash 的 link.exe 抢占
export PATH="$VC_BIN:$PATH"

# cargo / rustup
export PATH="$HOME/.cargo/bin:$PATH"

if [ $# -eq 0 ]; then
  echo "MSVC $VC_VER 已就绪 (SDK: ${SDK_VER:-未安装})"
  exit 0
fi

exec "$@"
