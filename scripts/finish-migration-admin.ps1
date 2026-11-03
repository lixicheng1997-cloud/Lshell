# 管理员权限收尾脚本
#
# 背景：BuildTools 与 Windows Kits 安装在受管理员保护的目录，
# 普通权限无法删除源目录、也无法建立 junction（目录联接）。
# 本脚本以管理员身份完成最后一步：删源 + 建联接，使路径保持不变。
#
# 用法：右键 ->「使用 PowerShell 运行」，或以管理员身份执行本文件。
# 幂等：重复执行安全（已迁移的部分会跳过）。

$ErrorActionPreference = "Continue"

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Host "需要管理员权限。请右键本文件 ->「使用 PowerShell 运行」。" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}

# 要处理的迁移对：<源路径> <目标路径>
$pairs = @(
    @{ Src = "C:\BuildTools";                        Dst = "E:\data\BuildTools" },
    @{ Src = "C:\Program Files (x86)\Windows Kits\10"; Dst = "E:\data\WindowsKits\10" }
)

foreach ($p in $pairs) {
    $src = $p.Src
    $dst = $p.Dst

    if (-not (Test-Path $dst)) {
        Write-Step "跳过 $src —— 目标不存在（$dst），未迁移"
        continue
    }

    # 已经是联接就跳过
    $item = Get-Item $src -Force -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType -eq "Junction") {
        Write-Step "跳过 $src —— 已是联接（指向 $($item.Target -join ',')）"
        continue
    }

    Write-Step "处理 $src"
    Write-Host "  目标已就绪: $dst"

    # 1. 删除源目录（管理员权限下硬链接与占用都能处理）
    if (Test-Path $src) {
        # 先终止可能占用文件的 VS 语言服务
        Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -like "$src\*" } |
            ForEach-Object {
                Write-Host "  停止占用进程: $($_.ProcessName) (PID $($_.Id))"
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }
        Start-Sleep -Seconds 2

        try {
            [System.IO.Directory]::Delete($src, $true)
            Write-Host "  源目录已删除" -ForegroundColor Green
        } catch {
            Write-Host "  删除失败: $($_.Exception.Message)" -ForegroundColor Yellow
            # 退回到 robocopy 强制清空
            & robocopy.exe $src "$env:TEMP\_empty_del" /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
            Remove-Item "$env:TEMP\_empty_del" -Recurse -Force -ErrorAction SilentlyContinue
            try {
                [System.IO.Directory]::Delete($src, $true)
                Write-Host "  已通过 robocopy 清空并删除" -ForegroundColor Green
            } catch {
                Write-Host "  仍无法删除，请手动处理: $src" -ForegroundColor Red
                continue
            }
        }
    }

    # 2. 建立 junction：路径不变，内容指向 E 盘
    if (-not (Test-Path $src)) {
        New-Item -ItemType Junction -Path $src -Target $dst | Out-Null
        Start-Sleep -Seconds 1
        $li = Get-Item $src -Force
        Write-Host "  联接已建立: $src -> $($li.Target -join ',')" -ForegroundColor Green
    }
}

# 3. 验证
Write-Step "验证"
foreach ($p in $pairs) {
    $li = Get-Item $p.Src -Force -ErrorAction SilentlyContinue
    if ($li) {
        Write-Host ("  {0}  [{1}] -> {2}" -f $p.Src, $li.LinkType, ($li.Target -join ","))
    } else {
        Write-Host ("  {0}  不存在" -f $p.Src) -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "完成。现在删除 C:\BuildTools 与 Windows Kits 里的原始数据已由联接接管，" -ForegroundColor Green
Write-Host "所有硬编码路径（如注册表里的 SDK InstallationFolder）依然有效。" -ForegroundColor Green
Read-Host "按回车退出"
