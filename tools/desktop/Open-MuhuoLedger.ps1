<#
  木火账房 · 一键打开
  ============================================================
  桌面快捷方式指向本脚本。它做三件事：

    1. 确认 Docker 栈在跑（postgres / api / web），没跑就拉起来
    2. 等它就绪（轮询健康检查，有超时）
    3. 用默认浏览器打开

  ★ 为什么不是"快捷方式直接指向 http://localhost:8080"：
    那样点开时服务没起来就是一个"无法访问此网站"的死页面，
    而用户完全不知道该怎么办。记账软件不该以一句浏览器报错开场。

  ★ 为什么用隐藏窗口 + 失败弹窗：
    正常运行时不闪黑框；出错时用弹窗说明原因与下一步，
    而不是静默失败（快捷方式静默失败最难查）。

  日志写在 %TEMP%\muhuo-ledger-open.log，出问题时可以看。
#>

$ErrorActionPreference = 'Stop'

$logPath = Join-Path $env:TEMP 'muhuo-ledger-open.log'
$lockPath = Join-Path $env:TEMP 'muhuo-ledger-open.lock'

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $logPath -Value $line -Encoding UTF8
}

function Show-Failure([string]$title, [string]$message) {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    [System.Windows.Forms.MessageBox]::Show(
      $message, $title,
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
  } catch {
    # 连弹窗都起不来时至少留下日志
    Write-Log "无法显示弹窗：$($_.Exception.Message)"
  }
}

function Test-Url([string]$url, [int]$timeoutSec = 4) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec -ErrorAction Stop
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

try {
  # ── 防重复点击：已经在跑就等它，不叠加第二份
  if (Test-Path $lockPath) {
    $age = (Get-Date) - (Get-Item $lockPath).LastWriteTime
    if ($age.TotalSeconds -lt 60) {
      Write-Log '已有另一个打开流程在进行，本次直接退出'
      exit 0
    }
  }
  New-Item -ItemType File -Path $lockPath -Force | Out-Null

  # 脚本在 <repo>/tools/desktop/ 下，仓库根是上两级
  $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $composeFile = Join-Path $repoRoot 'docker\prod\docker-compose.yml'
  $envFile = Join-Path $repoRoot 'deploy\env\.env.prod'
  $appUrl = 'http://localhost:8080'
  $healthUrl = "$appUrl/api/health"

  Write-Log "开始：repo=$repoRoot"

  if (-not (Test-Path $composeFile)) {
    Show-Failure '木火账房' "找不到部署文件：`n$composeFile`n`n说明项目位置被移动过。请重新运行一次安装快捷方式的脚本。"
    exit 1
  }

  # ── 已经在服务就直接开，省掉 docker 的几秒开销
  if (Test-Url $healthUrl) {
    Write-Log '服务已在运行，直接打开'
    Start-Process $appUrl
    exit 0
  }

  # ── 检查 Docker 是否可用
  $dockerOk = $false
  try {
    # ★ 以**退出码**为准。docker 会把提示写到 stderr，而 2>&1 会把
    #   stderr 变成错误记录，在 ErrorActionPreference=Stop 下直接抛异常 ——
    #   那是"探测失败"的假象，不是真失败。
    $null = & docker version --format '{{.Server.Version}}' 2>$null
    $dockerOk = ($LASTEXITCODE -eq 0)
  } catch { $dockerOk = $false }

  if (-not $dockerOk) {
    Show-Failure '木火账房' @"
连不上 Docker，服务起不来。

请先启动 Docker Desktop（开始菜单里搜 Docker），
等托盘图标变成运行中，再双击本快捷方式。

如果还没装 Docker Desktop，需要先安装它。
"@
    exit 1
  }

  Write-Log 'Docker 可用，拉起服务栈'
  $envArgs = @()
  if (Test-Path $envFile) { $envArgs = @('--env-file', $envFile) }

  <#
    ★ 这里必须临时把 ErrorActionPreference 调回 Continue。

    `docker compose up -d` 把进度（"Container bk-api-prod Starting" 之类）
    写到 **stderr**，这是它的正常行为。而 `2>&1` 会把 stderr 包装成
    ErrorRecord，在 ErrorActionPreference='Stop' 下第一条就抛终止性异常 ——
    实测表现为：容器其实已经正常拉起来了（10.8 秒就绪），脚本却走进异常分支
    弹了个"打开失败"，浏览器根本没打开。

    判断成败要看**退出码**，不是看有没有输出到 stderr。
  #>
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $composeOut = & docker compose -f $composeFile @envArgs up -d 2>&1
  $composeCode = $LASTEXITCODE
  $ErrorActionPreference = $prevEap

  $composeOut | ForEach-Object { Write-Log "  $_" }

  if ($composeCode -ne 0) {
    throw "docker compose up 失败（退出码 $composeCode）"
  }

  # ── 等它就绪。首次启动要跑数据库迁移，给足时间
  $deadline = (Get-Date).AddSeconds(120)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Url $healthUrl) { $ready = $true; break }
    Start-Sleep -Seconds 2
  }

  if (-not $ready) {
    Show-Failure '木火账房' @"
服务在 120 秒内没有就绪。

可以直接看容器状态：
  docker compose -f "$composeFile" ps
或者看日志：
  docker compose -f "$composeFile" logs --tail 50 api

详细日志：$logPath
"@
    exit 1
  }

  Write-Log '服务就绪，打开浏览器'
  Start-Process $appUrl
}
catch {
  Write-Log "异常：$($_.Exception.Message)"
  Show-Failure '木火账房' "打开失败：`n$($_.Exception.Message)`n`n详细日志：$logPath"
  exit 1
}
finally {
  Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
}
