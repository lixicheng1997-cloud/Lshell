//! 系统剪贴板读取（仅 Windows 实现）。
//!
//! WebView2 里 `navigator.clipboard.readText()` 受权限与安全上下文约束，
//! 右键粘贴这种「无用户手势触发读剪贴板」的场景并不稳定；
//! 这里直接走 Win32 剪贴板 API，与浏览器权限解耦。
//!
//! 和 `dpapi` 一样，只声明用到的几个 Win32 函数，不引入 `windows` crate，
//! 避免上万个 API 绑定带来的编译开销。

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::ptr;

    type Bool = i32;
    type Handle = *mut c_void;

    /// 剪贴板里的 Unicode 文本格式
    const CF_UNICODETEXT: u32 = 13;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hwnd: Handle) -> Bool;
        fn CloseClipboard() -> Bool;
        fn GetClipboardData(format: u32) -> Handle;
        fn IsClipboardFormatAvailable(format: u32) -> Bool;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalLock(mem: Handle) -> *mut c_void;
        fn GlobalUnlock(mem: Handle) -> Bool;
        fn GlobalSize(mem: Handle) -> usize;
    }

    /// 读取剪贴板文本；没有文本内容或被其他程序占用时返回 None。
    pub fn read_text() -> Option<String> {
        unsafe {
            if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 {
                return None;
            }

            // 剪贴板可能被其他程序短暂占用，重试几次
            let mut opened = false;
            for _ in 0..5 {
                if OpenClipboard(ptr::null_mut()) != 0 {
                    opened = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            if !opened {
                return None;
            }

            let handle = GetClipboardData(CF_UNICODETEXT);
            let text = if handle.is_null() {
                None
            } else {
                // 锁住句柄后按 UTF-16 读取，直到遇到结尾的 0
                let data = GlobalLock(handle) as *const u16;
                if data.is_null() {
                    None
                } else {
                    let cap = GlobalSize(handle) / 2;
                    let mut len = 0usize;
                    while len < cap && *data.add(len) != 0 {
                        len += 1;
                    }
                    let text =
                        String::from_utf16_lossy(std::slice::from_raw_parts(data, len));
                    GlobalUnlock(handle);
                    Some(text)
                }
            };

            CloseClipboard();
            text
        }
    }
}

#[cfg(not(windows))]
mod imp {
    /// 非 Windows 平台交给浏览器 Clipboard API 兜底
    pub fn read_text() -> Option<String> {
        None
    }
}

/// 读取系统剪贴板文本；为空或不可用时返回 None。
pub fn read_text() -> Option<String> {
    imp::read_text()
}
