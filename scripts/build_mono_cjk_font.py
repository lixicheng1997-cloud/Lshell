#!/usr/bin/env python
"""
合成「等宽中文」字体。

终端要求固定字宽：等宽英文字体里每个英文字符宽度相同，中文字符要正好占两格。
可爱中文界面字体（站酷快乐体 / 站酷小薇体）中文字宽统一，但英文字宽各异，
直接放进终端会让表格错位。

这个脚本把两款字体合成一款：
  - 英文与数字：取等宽英文字体（Consolas）的字形，宽度完全一致
  - 中文与标点：保留可爱中文字体的字形，并把字宽统一成英文的两倍
  - 结果同时满足「界面可爱」与「终端对齐」，应用与终端可以真正共用一套

用法：
  PYTHONPATH=<fonttools 路径> python scripts/build_mono_cjk_font.py
"""

from __future__ import annotations

import copy
import os
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import Glyph, table__g_l_y_f

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "design" / "fonts-src"
OUT_DIR = ROOT / "src" / "assets" / "fonts"

# 等宽英文来源：Windows 自带 Consolas
MONO_SOURCE = Path("C:/Windows/Fonts/consola.ttf")

# 合成配方：(输出文件名, 可爱中文字体, 输出字体族名)
RECIPES = [
    # 快乐体：全量 GB2312（6913 字）
    ("mono-cjk-kuaile.woff2", "ZCOOLKuaiLe-Regular.ttf", "Lshell Mono KuaiLe", "full"),
    # 小薇体：一级常用字（3894 字），控制体积
    ("mono-cjk-xiaowei.woff2", "ZCOOLXiaoWei-Regular.ttf", "Lshell Mono XiaoWei", "l1"),
]

ASCII = "".join(chr(c) for c in range(0x20, 0x7F))


def is_cjk(ch: str) -> bool:
    """是否是需要按两格宽度处理的中日韩字符（含全角标点）"""
    code = ord(ch)
    return (
        0x2E80 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
        or 0xFF00 <= code <= 0xFF60
        or 0x3000 <= code <= 0x303F
    )


def build(cute_path: Path, out_name: str, family_name: str, charset: str = "full") -> None:
    cute = TTFont(str(cute_path))
    mono = TTFont(str(MONO_SOURCE))

    # 按需裁剪：只保留指定字符集，减小产物体积
    if charset != "full":
        keep = set(open(SRC_DIR / "subset-l1.txt", encoding="utf-8").read())
        keep.update(ASCII)
        subsetter = subset.Subsetter(options=subset.Options())
        subsetter.populate(text="".join(sorted(keep)))
        subsetter.subset(cute)
        subsetter.subset(mono)

    cute_upm = cute["head"].unitsPerEm
    mono_upm = mono["head"].unitsPerEm
    cute_hmtx = cute["hmtx"]
    mono_hmtx = mono["hmtx"]
    cute_cmap = cute.getBestCmap()
    mono_cmap = mono.getBestCmap()

    # 等宽英文字宽：取 ASCII 众数
    widths = {
        mono_hmtx[mono_cmap[ord(c)]][0]
        for c in ASCII
        if ord(c) in mono_cmap
    }
    if len(widths) != 1:
        raise SystemExit(f"等宽英文字体宽度不一致：{widths}")
    mono_advance = widths.pop()
    # 英文宽度换算到中文体的 upm（保持 em 值不变）
    mono_advance_cute = round(mono_advance * cute_upm / mono_upm)
    # 中文 = 两个英文字格（同样以中文体 upm 计）
    cjk_advance = mono_advance_cute * 2

    # 字形表：保留可爱字体原有字形，加入等宽英文字形
    glyph_order = list(cute.getGlyphOrder())
    glyph_set = cute.getGlyphSet()
    glyf = cute["glyf"]
    hmtx = cute["hmtx"]

    # 关键：把 ASCII 字形整体换成等宽英文字体的字形。
    # 只改字宽不改字形的话，字母仍按原比例形状绘制，
    # 在等宽格子里会显得松散不匀 —— 换成真正的等宽字形才一致。
    mono_glyf = mono["glyf"]
    replaced = 0
    for ch in ASCII:
        if ch == " ":
            continue
        src_name = mono_cmap.get(ord(ch))
        dst_name = cute_cmap.get(ord(ch))
        if src_name is None or dst_name is None:
            continue
        src_glyf = mono_glyf[src_name]
        # 复合字形（含组件引用）无法直接搬运，跳过
        if src_glyf.isComposite():
            continue
        dst_glyf = glyf[dst_name]
        # 深拷贝字形：保留 program 等编译所需属性，避免共享引用被改坏
        copied = copy.deepcopy(src_glyf)
        copied.program = getattr(src_glyf, "program", None)
        # 纵向缩放：等宽字体 upm 与中文体不同，轮廓要按比例缩放
        scale = cute_upm / mono_upm
        if scale != 1 and copied.coordinates is not None:
            copied.coordinates.scale((scale, scale))
        glyf.glyphs[dst_name] = copied
        hmtx.metrics[dst_name] = (
            mono_advance_cute,
            int(src_glyf.xMin * scale) if src_glyf.xMin is not None else 0,
        )
        replaced += 1

    # 空格单独处理
    space_name = cute_cmap.get(ord(" "))
    if space_name:
        hmtx.metrics[space_name] = (mono_advance_cute, 0)

    # 中文字宽统一为两格
    for code, gn in list(cute_cmap.items()):
        if is_cjk(chr(code)) and gn in hmtx.metrics:
            hmtx.metrics[gn] = (cjk_advance, hmtx.metrics[gn][1])

    cute.setGlyphOrder(glyph_order)
    glyf.glyphOrder = glyph_order

    # 家族名
    name_table = cute["name"]
    for name_id, value in ((1, family_name), (4, family_name), (6, family_name.replace(" ", ""))):
        name_table.setName(value, name_id, 3, 1, 0x409)
        name_table.setName(value, name_id, 1, 0, 0)

    cute.flavor = "woff2"
    out_path = OUT_DIR / out_name
    cute.save(str(out_path))
    print(
        f"{out_name}: 英文 advance={mono_advance_cute} 中文 advance={cjk_advance}"
        f" 替换等宽英文字形 {replaced} 个 -> {out_path.stat().st_size // 1024} KB"
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if not MONO_SOURCE.exists():
        raise SystemExit(f"缺少等宽英文字体：{MONO_SOURCE}")
    for out_name, cute_file, family, charset in RECIPES:
        build(SRC_DIR / cute_file, out_name, family, charset)


if __name__ == "__main__":
    main()
