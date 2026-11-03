"""用 ctypes 调用 GDI 截取屏幕，保存为 PNG。

不依赖 PIL / ImageMagick / Add-Type，纯 ctypes + zlib 手写 PNG。

用法：python scripts/screenshot.py <输出路径> [窗口标题关键字]
"""

import ctypes
import struct
import sys
import zlib
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
SRCCOPY = 0x00CC0020
CAPTUREBLT = 0x40000000


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", ctypes.c_long),
        ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


def write_png(path, width, height, rgb_rows):
    """rgb_rows: list of bytes objects, each width*height*3 bytes"""
    raw = b"".join(b"\x00" + row for row in rgb_rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def capture_screen(out_path):
    """全屏截图"""
    width = user32.GetSystemMetrics(0)
    height = user32.GetSystemMetrics(1)

    hdc_desktop = user32.GetDC(None)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_desktop)
    hbm = gdi32.CreateCompatibleBitmap(hdc_desktop, width, height)
    gdi32.SelectObject(hdc_mem, hbm)

    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = width
    bmi.bmiHeader.biHeight = -height  # 负数表示自上而下
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bmi.bmiHeader.biCompression = 0

    buf = ctypes.create_string_buffer(width * height * 4)
    gdi32.StretchDIBits(
        hdc_mem, 0, 0, width, height, 0, 0, width, height,
        buf, ctypes.byref(bmi), DIB_RGB_COLORS, SRCCOPY,
    )

    # BGRA -> RGB
    rows = []
    stride = width * 4
    for y in range(height):
        off = y * stride
        line = bytearray(width * 3)
        row = buf.raw[off:off + stride]
        for x in range(width):
            b, g, r = row[x * 4], row[x * 4 + 1], row[x * 4 + 2]
            line[x * 3] = r
            line[x * 3 + 1] = g
            line[x * 3 + 2] = b
        rows.append(bytes(line))

    write_png(out_path, width, height, rows)

    gdi32.DeleteObject(hbm)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(None, hdc_desktop)
    return width, height


def find_window(keyword):
    """按标题关键字找窗口，返回 hwnd"""
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, _):
        length = user32.GetWindowTextLengthW(hwnd)
        if length > 0:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            title = buf.value
            if keyword.lower() in title.lower():
                found.append((hwnd, title))
        return True

    user32.EnumWindows(enum_proc, 0)
    return found


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "screen.png"
    keyword = sys.argv[2] if len(sys.argv) > 2 else None

    if keyword:
        wins = find_window(keyword)
        if wins:
            for hwnd, title in wins:
                print(f"窗口: {title} (hwnd={hwnd})")
        else:
            print(f"未找到标题含 '{keyword}' 的窗口，将截全屏")

    w, h = capture_screen(out)
    print(f"已保存 {out} ({w}x{h})")
