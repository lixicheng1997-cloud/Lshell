fn main() {
    // 品牌图标必须显式登记为 cargo 的重跑依赖。
    //
    // 原因：tauri-winres 把 icon.ico 编译进 exe 的 Windows 资源，但它自己
    // 不声明 `cargo:rerun-if-changed`；tauri-build 只为 tauri.conf.json 声明。
    // 而 Cargo 的规则是 —— 只要 build script 输出了任意一条 rerun-if-changed，
    // 就切换成「白名单模式」，之后只跟踪被列出的路径。结果就是：
    //   图标变了、配置没变 → build script 不重跑 → Windows 资源不重新编译
    //   → exe 里嵌的还是旧图标。
    // 把图标列进白名单后，图标一变就会重新编译资源并重新链接。
    for icon in [
        "icons/icon.ico",
        "icons/16x16.png",
        "icons/32x32.png",
        "icons/48x48.png",
        "icons/128x128.png",
        "icons/256x256.png",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }

    tauri_build::build()
}
