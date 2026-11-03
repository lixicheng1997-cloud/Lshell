"""生成 Lshell 应用图标。

不依赖 PIL，纯 Python 写 PNG（zlib + struct）。

图形：把「主标识」原样搬进方形徽标 —— 不改字标的任何设计：
  * 徽标底 = 应用深色主题底（--bg-app / --bg-panel 之间的渐变）
  * 字标   = wordmark.json 里的原版轮廓与配色
             L 与光标块 = 主色 #7C8CFF，shell = 前景色 #E6E9F0
  * 轮廓、字距、大小关系与界面里的字标完全一致（等比缩放，不做任何重排）

字形轮廓与配色直接取自 `design/assets/wordmark.json` —— 与品牌字标是同一套数据，
因此图标与界面里的 logo 永远一致；改字标请先重跑 `scripts/make_logo.py`。

用法：python scripts/make_icons.py
"""
import json
import os
import re
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "src-tauri", "icons")
WORDMARK = os.path.join(ROOT, "design", "assets", "wordmark.json")

# 徽标底色（应用深色主题）
BADGE_TOP = (18, 22, 30)       # #12161E
BADGE_BOT = (10, 12, 16)       # #0A0C10

# 字标配色（与主标识深底版一致）
ACCENT = (124, 140, 255)       # #7C8CFF —— L 与光标块
FG = (230, 233, 240)           # #E6E9F0 —— shell

# 版式
RADIUS = 0.225                # 圆角半径 / 边长
PAD_BIG = 0.070               # 安全边距 / 边长（≥64px）
PAD_SMALL = 0.040             # 安全边距 / 边长（<64px，小尺寸尽量放大字标）
GLOW = 0.22                   # 字标背后靛紫光晕强度
SS = 4                        # 每像素每轴的采样数（抗锯齿）
CURVE_STEPS = 12              # 每段二次贝塞尔离散成的直线段数


# ---------------------------------------------------------------- 路径解析


_TOKEN = re.compile(r"[MLQZ]|-?\d*\.?\d+(?:[eE][-+]?\d+)?")


def quad_points(p0, p1, p2, steps):
    """二次贝塞尔离散为折线点列（不含起点）。"""
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1.0 - t
        x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0]
        y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]
        pts.append((x, y))
    return pts


def parse_path(d, steps=CURVE_STEPS):
    """解析 SVG path（仅 M/L/Q/Z），返回轮廓点列列表。"""
    toks = _TOKEN.findall(d)
    contours = []
    cur = []
    pos = (0.0, 0.0)
    start = (0.0, 0.0)
    i = 0
    while i < len(toks):
        cmd = toks[i]
        i += 1
        if cmd == "M":
            if len(cur) > 2:
                contours.append(cur)
            pos = (float(toks[i]), float(toks[i + 1]))
            i += 2
            start = pos
            cur = [pos]
        elif cmd == "L":
            pos = (float(toks[i]), float(toks[i + 1]))
            i += 2
            cur.append(pos)
        elif cmd == "Q":
            ctrl = (float(toks[i]), float(toks[i + 1]))
            end = (float(toks[i + 2]), float(toks[i + 3]))
            i += 4
            cur.extend(quad_points(pos, ctrl, end, steps))
            pos = end
        elif cmd == "Z":
            if len(cur) > 2:
                contours.append(cur)
            cur = []
            pos = start
        else:
            raise RuntimeError(f"不支持的路径指令: {cmd}")
    if len(cur) > 2:
        contours.append(cur)
    return contours


def bbox_of(polys):
    xs = [p[0] for poly in polys for p in poly]
    ys = [p[1] for poly in polys for p in poly]
    return (min(xs), min(ys), max(xs), max(ys))


def load_mark():
    """从字标数据里取 L / shell 轮廓与光标块。坐标均为字标单位（y 向下）。"""
    with open(WORDMARK, "r", encoding="utf-8") as f:
        data = json.load(f)

    l_polys = [c for d in data["L"] for c in parse_path(d)]
    s_polys = [c for d in data["shell"] for c in parse_path(d)]
    if not l_polys or not s_polys:
        raise RuntimeError("wordmark.json 里没有解析到字形轮廓")

    cur = data["cursor"]
    return l_polys, s_polys, (cur["x"], cur["y"], cur["w"], cur["h"])


# ---------------------------------------------------------------- PNG 读写


def write_if_changed(path, data):
    """内容与磁盘一致时跳过写入。

    为什么需要：图标被 cargo 登记为重跑依赖（见 src-tauri/build.rs），
    若每次构建都无条件重写，mtime 每次都变 → build script 每次都重跑、
    exe 每次都重新链接（实测多花 ~25 秒）。内容没变就不动 mtime。
    """
    if os.path.exists(path):
        with open(path, "rb") as f:
            if f.read() == data:
                return False
    with open(path, "wb") as f:
        f.write(data)
    return True


def png_bytes(width, height, pixels):
    """pixels: list of rows, each row list of (r,g,b,a) -> PNG 字节"""
    raw = b""
    for row in pixels:
        raw += b"\x00"
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def write_png(path, width, height, pixels):
    write_if_changed(path, png_bytes(width, height, pixels))


def render_ico(png_paths, ico_path):
    """把多个 PNG 打包成 ICO"""
    entries = []
    data = b""
    offset = 6 + 16 * len(png_paths)

    for path, size in png_paths:
        with open(path, "rb") as f:
            blob = f.read()
        dim = 0 if size >= 256 else size
        entries.append(
            struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        )
        data += blob
        offset += len(blob)

    header = struct.pack("<HHH", 0, 1, len(png_paths))
    write_if_changed(ico_path, header + b"".join(entries) + data)


# ---------------------------------------------------------------- 几何


def inside_rounded_rect(x, y, s, r):
    """圆角矩形内部判定。

    用有向距离场：先算出点到「内缩矩形」的溢出量 (dx, dy)，
    再判断 dx^2 + dy^2 <= r^2。这样四个角共用一套公式，
    不会像逐角枚举那样把象限判定和圆心配错。
    """
    dx = max(r - x, x - (s - r), 0.0)
    dy = max(r - y, y - (s - r), 0.0)
    return dx * dx + dy * dy <= r * r


def point_in_poly(poly, x, y):
    """射线法判断点是否在多边形内（奇偶规则，天然处理字腔）。"""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            if x < xi + (y - yi) * (xj - xi) / (yj - yi):
                inside = not inside
        j = i
    return inside


def layout(size):
    """把主标识原样等比缩放进方形徽标。

    返回 (shapes, ink_box, glow)，shapes 为带颜色的图形列表：
      ('rect', x0, y0, x1, y1, rgb)   —— 光标块
      ('poly', bbox, points, rgb)     —— 字形轮廓
    """
    l_polys, s_polys, cursor = load_mark()

    # 字标整体外接框（含光标块），与主标识完全相同的几何
    l_box = bbox_of(l_polys)
    s_box = bbox_of(s_polys)
    x0 = min(l_box[0], s_box[0], cursor[0])
    y0 = min(l_box[1], s_box[1], cursor[1])
    x1 = max(l_box[2], s_box[2], cursor[0] + cursor[2])
    y1 = max(l_box[3], s_box[3], cursor[1] + cursor[3])
    mark_w = x1 - x0
    mark_h = y1 - y0

    pad = PAD_BIG if size >= 64 else PAD_SMALL
    avail = size * (1.0 - 2.0 * pad)
    k = avail / mark_w            # 等比缩放：字标比例与主标识完全一致

    left = (size - mark_w * k) / 2.0
    top = (size - mark_h * k) / 2.0

    def place(polys, color):
        out = []
        for poly in polys:
            pts = [(left + (x - x0) * k, top + (y - y0) * k) for (x, y) in poly]
            out.append(("poly", bbox_of([pts]), pts, color))
        return out

    shapes = []
    shapes += place(l_polys, ACCENT)          # L —— 主色
    shapes += place(s_polys, FG)              # shell —— 前景色
    cx = left + (cursor[0] - x0) * k
    cy = top + (cursor[1] - y0) * k
    cw = cursor[2] * k
    ch = cursor[3] * k
    shapes.append(("rect", cx, cy, cx + cw, cy + ch, ACCENT))   # 光标块 —— 主色

    ink_box = (left, top, left + mark_w * k, top + mark_h * k)

    # 字标背后的柔光：以字标中心为心的椭圆衰减
    glow = (
        left + mark_w * k / 2.0,
        top + mark_h * k / 2.0,
        max(mark_w * k / 2.0, 1.0) * 1.30,
        max(mark_h * k / 2.0, 1.0) * 2.40,
    )
    return shapes, ink_box, glow


def badge_color(x, y, size, glow):
    """徽标底色：深色渐变 + 字标背后的靛紫柔光。"""
    t = y / size
    base = [BADGE_TOP[i] + (BADGE_BOT[i] - BADGE_TOP[i]) * t for i in range(3)]
    cx, cy, rx, ry = glow
    d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
    if d < 1.0:
        k = (1.0 - d) ** 2 * GLOW
        base = [base[i] + (ACCENT[i] - base[i]) * k for i in range(3)]
    return tuple(int(round(c)) for c in base)


def color_at(x, y, size, shapes, ink_box, glow):
    """返回该采样点的 RGBA；None 表示透明。"""
    r = size * RADIUS
    if not inside_rounded_rect(x, y, size, r):
        return None

    # 先用整块墨迹的外接矩形快速排除绝大多数采样点
    if ink_box[0] <= x <= ink_box[2] and ink_box[1] <= y <= ink_box[3]:
        for sh in shapes:
            if sh[0] == "rect":
                if sh[1] <= x <= sh[3] and sh[2] <= y <= sh[4]:
                    return sh[5] + (255,)
            else:
                bb = sh[1]
                if (
                    bb[0] <= x <= bb[2]
                    and bb[1] <= y <= bb[3]
                    and point_in_poly(sh[2], x, y)
                ):
                    return sh[3] + (255,)

    return badge_color(x, y, size, glow) + (255,)


def render(size):
    """返回 size x size 的像素矩阵"""
    shapes, ink_box, glow = layout(size)
    step = 1.0 / SS
    offset = step / 2
    n = SS * SS

    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            acc_r = acc_g = acc_b = acc_a = 0
            for sy in range(SS):
                py = y + offset + sy * step
                for sx in range(SS):
                    px = x + offset + sx * step
                    c = color_at(px, py, size, shapes, ink_box, glow)
                    if c is not None:
                        acc_r += c[0]
                        acc_g += c[1]
                        acc_b += c[2]
                        acc_a += c[3]
            if acc_a == 0:
                row.append((0, 0, 0, 0))
                continue
            # 颜色按覆盖到的样本平均，alpha 单独按样本比例算
            hits = acc_a / 255.0
            row.append(
                (
                    int(round(acc_r / hits)),
                    int(round(acc_g / hits)),
                    int(round(acc_b / hits)),
                    int(round(acc_a / n)),
                )
            )
        rows.append(row)
    return rows


def main():
    os.makedirs(OUT, exist_ok=True)

    sizes = [16, 32, 48, 128, 256]
    pngs = []
    for size in sizes:
        rows = render(size)
        path = os.path.join(OUT, f"{size}x{size}.png")
        write_png(path, size, size, rows)
        pngs.append((path, size))
        print(f"wrote {path}")

    icon_ico = os.path.join(OUT, "icon.ico")
    render_ico(pngs, icon_ico)
    print(f"wrote {icon_ico}")


if __name__ == "__main__":
    main()
