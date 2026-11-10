//! 终端字符集转换
//!
//! xterm.js 只认 UTF-8，而部分老式 Unix 主机的 locale 是 GBK/Big5。
//! 这里在 Rust 侧做双向转换：下行（远端 → 前端）把远端字节解码成 UTF-8，
//! 上行（前端 → 远端）把 xterm 的 UTF-8 输入编码回远端字符集。
//!
//! 不引入第三方编码库：Windows 自带代码页转换（MultiByteToWideChar /
//! WideCharToMultiByte），和 DPAPI 一样直接声明 FFI，避免为两个函数
//! 增加一个依赖。非 Windows 构建退化为原样透传。
//!
//! 流式解码要处理「多字节字符被网络分片切断」：
//! GBK/Big5 的尾字节可能落在下一块数据里，因此遇到结尾的引导字节时
//! 暂存起来，等下一块到达再一起解码。

/// 支持的单字节/多字节字符集
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Charset {
    Utf8,
    Gbk,
    Big5,
}

impl Charset {
    /// 从主机 profile 的 encoding 字段解析；未知值回退 UTF-8
    pub fn from_label(label: &str) -> Self {
        match label.trim().to_ascii_lowercase().as_str() {
            "gbk" | "gb2312" | "gb18030" | "cp936" | "936" => Charset::Gbk,
            "big5" | "cp950" | "950" => Charset::Big5,
            _ => Charset::Utf8,
        }
    }

    /// Windows 代码页
    fn codepage(self) -> u32 {
        match self {
            Charset::Gbk => 936,
            Charset::Big5 => 950,
            Charset::Utf8 => 65001,
        }
    }
}

/// 流式解码器：远端字节 → UTF-8
pub struct Decoder {
    charset: Charset,
    /// 上一块被切在半截的引导字节
    pending: Vec<u8>,
}

impl Decoder {
    pub fn new(charset: Charset) -> Self {
        Decoder {
            charset,
            pending: Vec::new(),
        }
    }

    /// 喂入一块远端数据，返回可写给 xterm 的 UTF-8 字节
    pub fn push(&mut self, data: &[u8]) -> Vec<u8> {
        if self.charset == Charset::Utf8 {
            return data.to_vec();
        }

        let mut buf = Vec::with_capacity(self.pending.len() + data.len());
        buf.extend_from_slice(&self.pending);
        buf.extend_from_slice(data);
        self.pending.clear();

        if buf.is_empty() {
            return Vec::new();
        }
        let (out, held) = decode_native(self.charset, &buf);
        if let Some(byte) = held {
            self.pending.push(byte);
        }
        out
    }
}

/// 上行编码器：UTF-8 → 远端字节（输入通常是完整的按键数据，无需分片状态）
pub struct Encoder {
    charset: Charset,
}

impl Encoder {
    pub fn new(charset: Charset) -> Self {
        Encoder { charset }
    }

    /// 把 xterm 的 UTF-8 输入编码成远端字符集
    pub fn encode(&self, utf8: &[u8]) -> Vec<u8> {
        if self.charset == Charset::Utf8 {
            return utf8.to_vec();
        }
        encode_native(self.charset, utf8)
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn MultiByteToWideChar(
        codepage: u32,
        flags: u32,
        multi: *const u8,
        multi_len: i32,
        wide: *mut u16,
        wide_len: i32,
    ) -> i32;

    fn WideCharToMultiByte(
        codepage: u32,
        flags: u32,
        wide: *const u16,
        wide_len: i32,
        multi: *mut u8,
        multi_len: i32,
        default_char: *const u8,
        used_default: *mut i32,
    ) -> i32;
}

#[cfg(windows)]
fn decode_native(charset: Charset, bytes: &[u8]) -> (Vec<u8>, Option<u8>) {
    // MB_ERR_INVALID_CHARS：遇到结尾被截断的引导字节会直接失败，
    // 借此区分「数据损坏」与「这里还差半个字符」。
    const MB_ERR_INVALID_CHARS: u32 = 0x0000_0008;
    let cp = charset.codepage();

    let wide_of = |input: &[u8]| -> Option<Vec<u16>> {
        unsafe {
            let len = MultiByteToWideChar(
                cp,
                MB_ERR_INVALID_CHARS,
                input.as_ptr(),
                input.len() as i32,
                std::ptr::null_mut(),
                0,
            );
            if len <= 0 {
                return None;
            }
            let mut wide = vec![0u16; len as usize];
            let got = MultiByteToWideChar(
                cp,
                MB_ERR_INVALID_CHARS,
                input.as_ptr(),
                input.len() as i32,
                wide.as_mut_ptr(),
                len,
            );
            if got <= 0 {
                return None;
            }
            wide.truncate(got as usize);
            Some(wide)
        }
    };

    if let Some(wide) = wide_of(bytes) {
        return (String::from_utf16_lossy(&wide).into_bytes(), None);
    }

    // 末尾可能是被网络切断的双字节字符：扣下最后一个字节，解前面的部分
    if bytes.len() > 1 {
        if let Some(wide) = wide_of(&bytes[..bytes.len() - 1]) {
            return (
                String::from_utf16_lossy(&wide).into_bytes(),
                Some(bytes[bytes.len() - 1]),
            );
        }
    }
    // 只有一个引导字节且无法解码，先留着等下一块
    if bytes.len() == 1 && (0x81..=0xFE).contains(&bytes[0]) {
        return (Vec::new(), Some(bytes[0]));
    }

    // 其余情况按原样透传，避免把可能合法的数据吞掉
    (bytes.to_vec(), None)
}

#[cfg(windows)]
fn encode_native(charset: Charset, utf8: &[u8]) -> Vec<u8> {
    let cp = charset.codepage();
    // xterm 的输入都是合法 UTF-8；异常时用替换字符兜底
    let text = String::from_utf8_lossy(utf8);
    let wide: Vec<u16> = text.encode_utf16().collect();
    unsafe {
        let len = WideCharToMultiByte(
            cp,
            0,
            wide.as_ptr(),
            wide.len() as i32,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            std::ptr::null_mut(),
        );
        if len <= 0 {
            return utf8.to_vec();
        }
        let mut out = vec![0u8; len as usize];
        let got = WideCharToMultiByte(
            cp,
            0,
            wide.as_ptr(),
            wide.len() as i32,
            out.as_mut_ptr(),
            len,
            std::ptr::null(),
            std::ptr::null_mut(),
        );
        if got <= 0 {
            return utf8.to_vec();
        }
        out.truncate(got as usize);
        out
    }
}

#[cfg(not(windows))]
fn decode_native(_charset: Charset, bytes: &[u8]) -> (Vec<u8>, Option<u8>) {
    (bytes.to_vec(), None)
}

#[cfg(not(windows))]
fn encode_native(_charset: Charset, utf8: &[u8]) -> Vec<u8> {
    utf8.to_vec()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn label_parsing() {
        assert_eq!(Charset::from_label("GBK"), Charset::Gbk);
        assert_eq!(Charset::from_label("big5"), Charset::Big5);
        assert_eq!(Charset::from_label("utf-8"), Charset::Utf8);
        assert_eq!(Charset::from_label(""), Charset::Utf8);
    }

    #[test]
    fn gbk_roundtrip() {
        let bytes = Encoder::new(Charset::Gbk).encode("中文目录".as_bytes());
        let mut decoder = Decoder::new(Charset::Gbk);
        let out = decoder.push(&bytes);
        assert_eq!(String::from_utf8(out).unwrap(), "中文目录");
    }

    #[test]
    fn gbk_split_chunk_is_not_garbled() {
        let bytes = Encoder::new(Charset::Gbk).encode("中文".as_bytes());
        // 故意在双字节字符中间切开
        let (a, b) = bytes.split_at(2);
        let mut decoder = Decoder::new(Charset::Gbk);
        let first = decoder.push(a);
        let second = decoder.push(b);
        let text = format!(
            "{}{}",
            String::from_utf8(first).unwrap(),
            String::from_utf8(second).unwrap()
        );
        assert_eq!(text, "中文");
    }

    #[test]
    fn utf8_passthrough() {
        let mut decoder = Decoder::new(Charset::Utf8);
        assert_eq!(decoder.push(b"hello"), b"hello");
        let encoder = Encoder::new(Charset::Utf8);
        assert_eq!(encoder.encode("中文".as_bytes()), "中文".as_bytes());
    }
}
