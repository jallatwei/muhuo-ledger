<#
  木火账房 · 安装/修复桌面快捷方式
  ============================================================
  在桌面创建「木火账房.lnk」，指向同目录的 Open-MuhuoLedger.ps1，
  并使用 muhuo-ledger.ico 作为图标。

  ★ 什么时候需要重新跑一次：
    · 换了机器，或把仓库挪了位置 —— 快捷方式里存的是**绝对路径**，
      仓库一移动它就成了死链接（表现为双击无反应或提示找不到文件）
    · 桌面上的快捷方式被误删
    · 图标改了（icon.svg / icon-small.svg 重新生成过 ico）

  用法：在仓库里执行
    pwsh -File tools\desktop\Install-Shortcut.ps1
  或右键本文件 →「使用 PowerShell 运行」。
#>

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $here)
$launcher = Join-Path $here 'Open-MuhuoLedger.ps1'
$icon = Join-Path $here 'muhuo-ledger.ico'
$shortcutName = '木火账房.lnk'

function Ok([string]$m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Bad([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Info([string]$m) { Write-Host "         $m" -ForegroundColor DarkGray }

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor White
Write-Host '  木火账房 · 安装桌面快捷方式' -ForegroundColor White
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor White
Write-Host "  仓库    : $repoRoot"
Write-Host "  启动器  : $launcher"
Write-Host "  图标    : $icon"
Write-Host ''

$failed = 0

if (-not (Test-Path $launcher)) { Bad "找不到启动器：$launcher"; $failed++ } else { Ok '启动器存在' }
if (-not (Test-Path $icon)) { Bad "找不到图标：$icon"; $failed++ } else { Ok '图标存在' }

# ★ 用 Windows PowerShell（5.1）作为目标，而不是 pwsh：
#    Store 版 pwsh 的安装路径带版本号（…WindowsApps\Microsoft.PowerShell_7.6.6.0_x64…），
#    升级后路径就变了；而 System32 下的 powershell.exe 永远在这个位置。
#    启动器是带 BOM 的 UTF-8，5.1 也能正确读中文。
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $psExe)) { Bad "找不到 Windows PowerShell：$psExe"; $failed++ } else { Ok 'Windows PowerShell 可用' }

if ($failed -gt 0) {
  Write-Host ''
  Write-Host '  上面有问题，先解决再运行。' -ForegroundColor Yellow
  exit 1
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop $shortcutName

# 已存在则覆盖：这正是"修复"的用法
if (Test-Path $lnkPath) { Info "已存在，将覆盖：$lnkPath" }

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $psExe
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$lnk.IconLocation = "$icon,0"
$lnk.WorkingDirectory = $repoRoot
$lnk.Description = '木火账房 · 小企业自动记账（小企业会计准则 · 一般纳税人）'
$lnk.Save()

Write-Host ''
Ok "快捷方式已写入：$lnkPath"

# 回读校验 —— 写进去和读出来一致才算真的成功
$check = $shell.CreateShortcut($lnkPath)
$good = ($check.TargetPath -eq $psExe) -and ($check.IconLocation -like "$icon*")
if ($good) { Ok '回读校验通过（目标与图标都正确）' } else { Bad '回读校验失败，请检查上面的值' }

Write-Host ''
Write-Host '  双击桌面上的「木火账房」即可打开。' -ForegroundColor Cyan
Info '它会先确认服务在跑（没跑就自动拉起），再打开浏览器。'
Info '出错时会弹窗说明原因；日志在 %TEMP%\muhuo-ledger-open.log'
Write-Host ''
