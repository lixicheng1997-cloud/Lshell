"""生成 Lshell 品牌标识（wordmark）。

纯 Python 实现，不依赖 fontTools / PIL：
解析 TrueType 的 cmap / loca / glyf 表，把字形轮廓抽出来，转成 SVG 路径。

输出：
  design/assets/lshell-logo-on-dark.svg   深色背景用：L 与光标为靛紫，"shell" 为浅色前景
  design/assets/lshell-logo-on-light.svg  浅色背景用：L 与光标为深靛紫，"shell" 为近黑前景
  design/assets/lshell-logo-mono.svg      单色版（一个墨色，适配单色场景）
  src/components/Brand.tsx                React 字标组件（配色走 CSS 变量，自动跟随主题）

设计规格：
  字体      Segoe UI Semibold（与应用 UI 同族，Windows 原生）
  配色      两色：靛紫主色 #7C8CFF（深底） / #4F5BE8（浅底）
  特征      1) 首字母 L 用主色，"shell" 用前景色，视觉上把品牌锚定在 L 上
            2) 词尾一个实心光标块（终端光标），即 "Lshell_"
  画布      1 em = 1000 单位，路径已烘焙绝对坐标，可直接缩放

用法：
  python scripts/make_logo.py
"""
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "design", "assets")

FONT_DIR = "C:/Windows/Fonts"
FONT_SEMIBOLD = os.path.join(FONT_DIR, "seguisb.ttf")

# ---------------------------------------------------------------- 设计参数

WORD = "Lshell"           # 品牌文字
EM = 1000.0              # 1 em = 1000 SVG 单位
TRACKING = -8.0          # 字距（单位/千 em），负值收紧
LS_GAP = -12.0           # L 与 s 之间的额外光学间隙
CURSOR_W_RATIO = 0.40      # 光标块宽 / 高
CURSOR_H_RATIO = 0.88      # 光标块高 / x-height
CURSOR_GAP = 62.0          # 词尾与光标之间的间隙（字体单位）

# 配色（与 src/styles/tokens.css 保持一致）
ACCENT_DARK = "#7C8CFF"
FG_DARK = "#E6E9F0"
ACCENT_LIGHT = "#4F5BE8"
FG_LIGHT = "#121722"

# ---------------------------------------------------------------- TTF 解析


def write_if_changed(path, content):
    """内容与磁盘一致时跳过写入。

    为什么需要：生成器在每次构建前都会跑，若无条件重写，文件 mtime 每次都变，
    而 cargo 会把图标登记为重跑依赖 → 每次构建都无谓地重跑 build script
    并重新链接 exe（实测多花 ~25 秒）。内容没变就不动 mtime，构建照旧增量。
    """
    data = content.encode("utf-8") if isinstance(content, str) else content
    if os.path.exists(path):
        with open(path, "rb") as f:
            if f.read() == data:
                return False
    with open(path, "wb") as f:
        f.write(data)
    return True


class TTF:
    """够用就好的 TrueType 读取器：cmap(4) / loca / glyf / hmtx / head / maxp。"""

    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
        self.tables = {}
        num_tables = self.u16(4)
        for i in range(num_tables):
            pos = 12 + i * 16
            tag = self.data[pos:pos + 4].decode("latin-1")
            offset = self.u32(pos + 8)
            length = self.u32(pos + 12)
            self.tables[tag] = (offset, length)

        head = self.tables["head"][0]
        self.units_per_em = self.u16(head + 18)
        self.index_to_loc = self.i16(head + 50)

        self.num_glyphs = self.u16(self.tables["maxp"][0] + 4)
        self.num_h_metrics = self.u16(self.tables["hhea"][0] + 34)
        self._read_loca()
        self._read_cmap()
        self._read_hmtx()

    # -- 基础读取 -------------------------------------------------
    def u16(self, p):
        return struct.unpack_from(">H", self.data, p)[0]

    def i16(self, p):
        return struct.unpack_from(">h", self.data, p)[0]

    def u32(self, p):
        return struct.unpack_from(">I", self.data, p)[0]

    def _read_loca(self):
        off, _ = self.tables["loca"]
        n = self.num_glyphs + 1
        if self.index_to_loc == 0:
            self.loca = [self.u16(off + i * 2) * 2 for i in range(n)]
        else:
            self.loca = [self.u32(off + i * 4) for i in range(n)]

    def _read_hmtx(self):
        off, _ = self.tables["hmtx"]
        self.advances = []
        self.lsbs = []
        last = 0
        for i in range(self.num_h_metrics):
            last = self.u16(off + i * 4)
            self.advances.append(last)
            self.lsbs.append(self.i16(off + i * 4 + 2))
        for i in range(self.num_h_metrics, self.num_glyphs):
            self.advances.append(last)
            self.lsbs.append(self.i16(off + i * 4 + 2))

    def _read_cmap(self):
        off, _ = self.tables["cmap"]
        n = self.u16(off + 2)
        best = None
        for i in range(n):
            rec = off + 4 + i * 8
            plat = self.u16(rec)
            enc = self.u16(rec + 2)
            sub = off + self.u32(rec + 4)
            fmt = self.u16(sub)
            score = {(3, 10): 5, (3, 1): 4, (0, 4): 3, (0, 3): 2, (0, 6): 3}.get((plat, enc), 1)
            if fmt in (4, 12):
                if best is None or score > best[0]:
                    best = (score, sub, fmt)
        if best is None:
            raise RuntimeError("no usable cmap subtable")
        _, self.cmap_off, self.cmap_fmt = best
        self._parse_cmap_subtable()

    def _parse_cmap_subtable(self):
        base = self.cmap_off
        self.cmap = {}
        if self.cmap_fmt == 12:
            ngroups = self.u32(base + 12)
            for i in range(ngroups):
                g = base + 16 + i * 12
                start = self.u32(g)
                end = self.u32(g + 4)
                gid = self.u32(g + 8)
                for c in range(start, min(end, start + 0x10000) + 1):
                    self.cmap[c] = gid + (c - start)
        else:  # format 4
            seg_x2 = self.u16(base + 6)
            seg = seg_x2 // 2
            end_pos = base + 14
            start_pos = end_pos + seg_x2 + 2
            delta_pos = start_pos + seg_x2
            range_pos = delta_pos + seg_x2
            for i in range(seg):
                end = self.u16(end_pos + i * 2)
                start = self.u16(start_pos + i * 2)
                delta = self.i16(delta_pos + i * 2)
                ro = self.u16(range_pos + i * 2)
                if start > end:
                    continue
                for c in range(start, min(end, 0xFFFF) + 1):
                    if ro == 0:
                        gid = (c + delta) & 0xFFFF
                    else:
                        addr = range_pos + i * 2 + ro + (c - start) * 2
                        if addr + 2 > len(self.data):
                            continue
                        gid = self.u16(addr)
                        if gid != 0:
                            gid = (gid + delta) & 0xFFFF
                    if gid:
                        self.cmap[c] = gid

    # -- 字形 -----------------------------------------------------
    def gid(self, ch):
        return self.cmap.get(ord(ch))

    def advance(self, gid):
        return self.advances[gid] if gid < len(self.advances) else 0

    def x_height(self):
        """x-height：用 'x' 字形的 bbox 高度近似。"""
        g = self.gid("x")
        if g is None:
            return int(self.units_per_em * 0.5)
        contours = self.glyph_contours(g)
        ys = [pt[1] for c in contours for pt in c]
        return max(ys) - min(ys)

    def glyph_contours(self, gid, depth=0):
        """返回 [[(x, y, on_curve), ...], ...]，坐标为字体单位、y 向上。"""
        if depth > 5:
            return []
        off, _ = self.tables["glyf"]
        start = self.loca[gid]
        end = self.loca[gid + 1]
        if start == end:
            return []
        p = off + start
        n_contours = self.i16(p)
        p += 10
        if n_contours < 0:
            return self._composite(p, depth)
        end_pts = [self.u16(p + i * 2) for i in range(n_contours)]
        p += n_contours * 2
        n_points = end_pts[-1] + 1
        instr_len = self.u16(p)
        p += 2 + instr_len

        flags = []
        while len(flags) < n_points:
            f = self.data[p]
            p += 1
            flags.append(f)
            if f & 0x08:  # REPEAT
                rep = self.data[p]
                p += 1
                flags.extend([f] * rep)

        xs, v = [], 0
        for f in flags:
            if f & 0x02:
                dx = self.data[p]
                p += 1
                v += dx if (f & 0x10) else -dx
            elif not (f & 0x10):
                v += self.i16(p)
                p += 2
            xs.append(v)

        ys, v = [], 0
        for f in flags:
            if f & 0x04:
                dy = self.data[p]
                p += 1
                v += dy if (f & 0x20) else -dy
            elif not (f & 0x20):
                v += self.i16(p)
                p += 2
            ys.append(v)

        contours, s = [], 0
        for e in end_pts:
            pts = [(xs[i], ys[i], bool(flags[i] & 1)) for i in range(s, e + 1)]
            contours.append(pts)
            s = e + 1
        return contours

    def _composite(self, p, depth):
        out = []
        while True:
            flags = self.u16(p)
            glyph_index = self.u16(p + 2)
            p += 4
            if flags & 0x0001:  # ARG_ARE_XY_VALUES
                dx = self.i16(p)
                dy = self.i16(p + 2)
                p += 4
            else:
                dx = dy = 0
            a = d = 1.0
            b = c = 0.0
            if flags & 0x0008:  # WE_HAVE_A_SCALE
                a = d = self.f2dot14(p)
                p += 2
            elif flags & 0x0040:  # X_AND_Y_SCALE
                a = self.f2dot14(p)
                d = self.f2dot14(p + 2)
                p += 4
            elif flags & 0x0080:  # TWO_BY_TWO
                a = self.f2dot14(p)
                b = self.f2dot14(p + 2)
                c = self.f2dot14(p + 4)
                d = self.f2dot14(p + 6)
                p += 8
            for contour in self.glyph_contours(glyph_index, depth + 1):
                out.append([
                    (x * a + y * c + dx, x * b + y * d + dy, on) for (x, y, on) in contour
                ])
            if not (flags & 0x0020):  # MORE_COMPONENTS
                break
        return out

    def f2dot14(self, p):
        return self.i16(p) / 16384.0


# ---------------------------------------------------------------- 路径生成


def fmt(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def contour_to_path(pts):
    """TrueType 二次贝塞尔轮廓 → SVG path 片段。"""
    n = len(pts)
    if n < 2:
        return ""

    def mid(a, b):
        return ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)

    if pts[0][2]:
        start = (pts[0][0], pts[0][1])
        rest = pts[1:]
    elif pts[-1][2]:
        start = (pts[-1][0], pts[-1][1])
        rest = pts[:-1]
    else:
        start = mid(pts[-1], pts[0])
        rest = pts[:]

    d = [f"M{fmt(start[0])} {fmt(start[1])}"]
    ctrl = None
    for p in rest:
        if p[2]:
            if ctrl is None:
                d.append(f"L{fmt(p[0])} {fmt(p[1])}")
            else:
                d.append(f"Q{fmt(ctrl[0])} {fmt(ctrl[1])} {fmt(p[0])} {fmt(p[1])}")
                ctrl = None
        else:
            if ctrl is not None:
                m = mid(ctrl, p)
                d.append(f"Q{fmt(ctrl[0])} {fmt(ctrl[1])} {fmt(m[0])} {fmt(m[1])}")
            ctrl = (p[0], p[1])
    if ctrl is not None:
        d.append(f"Q{fmt(ctrl[0])} {fmt(ctrl[1])} {fmt(start[0])} {fmt(start[1])}")
    d.append("Z")
    return "".join(d)


def build_wordmark(font, word=WORD):
    """返回 (groups, cursor)，坐标单位为字体单位（y 向上，基线 = 0）。"""
    placed = []
    pen = 0.0
    for i, ch in enumerate(word):
        gid = font.gid(ch)
        if gid is None:
            raise RuntimeError(f"font has no glyph for {ch!r}")
        placed.append((ch, font.glyph_contours(gid), pen))
        pen += font.advance(gid) + TRACKING
        if i == 0:
            pen += LS_GAP

    groups = {"L": [], "shell": []}
    for idx, (ch, contours, dx) in enumerate(placed):
        key = "L" if idx == 0 else "shell"
        for c in contours:
            groups[key].append([(x + dx, y, on) for (x, y, on) in c])

    # 终端光标：自基线向上，高度取 x-height 的 86%
    xh = font.x_height()
    cursor = {
        "x": pen + CURSOR_GAP,
        "y": 0.0,
        "h": xh * CURSOR_H_RATIO,
        "w": xh * CURSOR_H_RATIO * CURSOR_W_RATIO,
    }
    return groups, cursor


def bake(groups, cursor, font, pad=0.0):
    """缩放到 SVG 单位（1 em = 1000）、翻转 y 轴，输出紧凑的 viewBox。"""
    scale = EM / font.units_per_em

    scaled = {
        key: [[(x * scale, y * scale, on) for (x, y, on) in c] for c in contours]
        for key, contours in groups.items()
    }
    cs = {
        "x": cursor["x"] * scale,
        "y": cursor["y"] * scale,
        "w": cursor["w"] * scale,
        "h": cursor["h"] * scale,
    }

    xs, ys = [], []
    for contours in scaled.values():
        for c in contours:
            for (x, y, _) in c:
                xs.append(x)
                ys.append(y)
    xs += [cs["x"], cs["x"] + cs["w"]]
    ys += [cs["y"], cs["y"] + cs["h"]]

    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    w = max_x - min_x + pad * 2
    h = max_y - min_y + pad * 2
    off_x = -min_x + pad
    off_y = max_y + pad   # y 向下：字体最高点映射到 0

    baked = {}
    for key, contours in scaled.items():
        baked[key] = [
            contour_to_path([(x + off_x, off_y - y, on) for (x, y, on) in c])
            for c in contours
        ]

    cursor_rect = {
        "x": cs["x"] + off_x,
        "y": off_y - (cs["y"] + cs["h"]),
        "w": cs["w"],
        "h": cs["h"],
    }
    return baked, cursor_rect, w, h


def svg_doc(baked, cursor_rect, w, h, colors, title, desc=""):
    L_segs = "".join(baked["L"])
    shell_segs = "".join(baked["shell"])
    accent, fg = colors
    cr = cursor_rect
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(w)} {fmt(h)}" role="img" aria-label="{title}">
  <title>{title}</title>
{f'  <desc>{desc}</desc>' if desc else ''}
  <g fill="{accent}">
    <path d="{L_segs}"/>
    <rect x="{fmt(cr['x'])}" y="{fmt(cr['y'])}" width="{fmt(cr['w'])}" height="{fmt(cr['h'])}" rx="{fmt(cr['w'] * 0.14)}"/>
  </g>
  <g fill="{fg}">
    <path d="{shell_segs}"/>
  </g>
</svg>
"""


def svg_doc_mono(baked, cursor_rect, w, h, ink, title):
    L_segs = "".join(baked["L"])
    shell_segs = "".join(baked["shell"])
    cr = cursor_rect
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(w)} {fmt(h)}" role="img" aria-label="{title}">
  <title>{title}</title>
  <g fill="{ink}">
    <path d="{L_segs}"/>
    <path d="{shell_segs}"/>
    <rect x="{fmt(cr['x'])}" y="{fmt(cr['y'])}" width="{fmt(cr['w'])}" height="{fmt(cr['h'])}" rx="{fmt(cr['w'] * 0.14)}"/>
  </g>
</svg>
"""


BRAND_TSX = '''/**
 * Lshell 品牌字标。
 *
 * 本文件由 scripts/make_logo.py 生成，请勿手工编辑。
 * 改字体 / 字距 / 配色请改生成器里的参数后重跑：
 *
 *     python scripts/make_logo.py
 *
 * 字形轮廓已烘焙为路径，不依赖系统字体；
 * 颜色走 CSS 变量（--accent / --fg），因此自动跟随深浅主题。
 */
interface Props {
  /** 字标高度（px）。宽度按字标比例自动换算。 */
  height?: number;
  className?: string;
}

const VIEWBOX = "__VIEWBOX__";
const RATIO = __RATIO__;
const L_PATH = "__LPATH__";
const SHELL_PATH = "__SHELLPATH__";
const CURSOR = {
  x: __CX__,
  y: __CY__,
  w: __CW__,
  h: __CH__,
  rx: __CRX__,
};

export default function Brand({ height = 16, className }: Props) {
  const width = Math.round(height * RATIO * 100) / 100;
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={VIEWBOX}
      role="img"
      aria-label="Lshell"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={L_PATH} style={{ fill: "var(--accent)" }} />
      <rect
        x={CURSOR.x}
        y={CURSOR.y}
        width={CURSOR.w}
        height={CURSOR.h}
        rx={CURSOR.rx}
        style={{ fill: "var(--accent)" }}
      />
      <path d={SHELL_PATH} style={{ fill: "var(--fg)" }} />
    </svg>
  );
}
'''


def write_brand_tsx(baked, cursor_rect, w, h):
    """生成 React 字标组件，供应用内使用。"""
    tsx = BRAND_TSX
    replacements = {
        "__VIEWBOX__": f"0 0 {fmt(w)} {fmt(h)}",
        "__RATIO__": f"{round(w / h, 4)}",
        "__LPATH__": "".join(baked["L"]),
        "__SHELLPATH__": "".join(baked["shell"]),
        "__CX__": fmt(cursor_rect["x"]),
        "__CY__": fmt(cursor_rect["y"]),
        "__CW__": fmt(cursor_rect["w"]),
        "__CH__": fmt(cursor_rect["h"]),
        "__CRX__": fmt(cursor_rect["w"] * 0.14),
    }
    for k, v in replacements.items():
        tsx = tsx.replace(k, v)

    path = os.path.join(ROOT, "src", "components", "Brand.tsx")
    write_if_changed(path, tsx)
    print(f"wrote {path}")



def main():
    os.makedirs(OUT, exist_ok=True)
    font = TTF(FONT_SEMIBOLD)
    groups, cursor = build_wordmark(font)
    baked, cur, w, h = bake(groups, cursor, font)

    files = {
        "lshell-logo-on-dark.svg": svg_doc(
            baked, cur, w, h, (ACCENT_DARK, FG_DARK), "Lshell",
            "深色背景使用的 Lshell 品牌标识",
        ),
        "lshell-logo-on-light.svg": svg_doc(
            baked, cur, w, h, (ACCENT_LIGHT, FG_LIGHT), "Lshell",
            "浅色背景使用的 Lshell 品牌标识",
        ),
        "lshell-logo-mono.svg": svg_doc_mono(
            baked, cur, w, h, "#121722", "Lshell",
        ),
    }
    for name, content in files.items():
        path = os.path.join(OUT, name)
        write_if_changed(path, content)
        print(f"wrote {path}  ({w:.1f} x {h:.1f})")

    # 供 HTML 页面内联使用
    manifest = {
        "width": round(w, 2),
        "height": round(h, 2),
        "L": baked["L"],
        "shell": baked["shell"],
        "cursor": cur,
    }
    import json
    manifest_path = os.path.join(OUT, "wordmark.json")
    write_if_changed(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"wrote {manifest_path}")

    write_brand_tsx(baked, cur, w, h)


if __name__ == "__main__":
    main()
