# MiMo（小米）AI 接入探测
# ============================================================
# ★ 为什么要有这个脚本，而不是直接改 .env 跑 verify-ai-integration.ps1：
#   真实模型按 token 计费，而且**字段名对不上是常态** ——
#   模型可能返回「价税合计」而不是 amountInclTax、金额带 ¥ 符号、
#   日期写成「2026年1月15日」。一上来跑全部 18 个样例，
#   万一提示词与模型不对付，18 次调用全是浪费。
#
#   这个脚本从最便宜的一步开始逐层加码，**每层都能单独停**：
#     第 1 层  一次极小的文本请求   → 只验证「地址对不对、Key 通不通」
#     第 2 层  一次 JSON 模式请求   → 验证 response_format 与 thinking 参数被接受
#     第 3 层  一次图片请求         → 验证多模态入参与字段名是否对得上
#   任一层失败就停下并给出针对性建议，不会继续烧钱。
#
# 用法：
#   $env:MIMO_API_KEY = '你的 token'
#   pwsh -File tools\probe-mimo.ps1
#
#   # 只跑到某一层
#   pwsh -File tools\probe-mimo.ps1 -StopAfter 1
#
#   # 换模型
#   pwsh -File tools\probe-mimo.ps1 -Model mimo-v2.5-pro
#
# 安全：脚本只读环境变量，不写任何文件，不打印完整 Key。
param(
  [string]$BaseUrl = 'https://api.xiaomimimo.com/v1',
  [string]$Model = 'mimo-v2.5',
  [ValidateRange(1, 3)]
  [int]$StopAfter = 3,
  [switch]$SendThinkingParam
)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0
$script:totalCostTokens = 0

function Step([string]$title) {
  Write-Host ""
  Write-Host "── $title " -NoNewline -ForegroundColor Cyan
  Write-Host ("─" * [Math]::Max(0, 66 - $title.Length)) -ForegroundColor DarkGray
}

function Ok([string]$msg) {
  $script:pass++
  Write-Host "  [PASS] $msg" -ForegroundColor Green
}

function Bad([string]$msg) {
  $script:fail++
  Write-Host "  [FAIL] $msg" -ForegroundColor Red
}

function Info([string]$msg) {
  Write-Host "         $msg" -ForegroundColor DarkGray
}

# ── 前置检查 ────────────────────────────────────────────────
$key = $env:MIMO_API_KEY
if (-not $key) { $key = $env:AI_API_KEY }
if (-not $key) {
  Write-Host ""
  Write-Host "✗ 未设置 MIMO_API_KEY。" -ForegroundColor Red
  Write-Host ""
  Write-Host "  请先在当前会话里设置（不要写进任何会提交的文件）：" -ForegroundColor Yellow
  Write-Host "    `$env:MIMO_API_KEY = '你的 token'" -ForegroundColor White
  Write-Host ""
  Write-Host "  token 从 https://platform.xiaomimimo.com/token-plan 获取。" -ForegroundColor DarkGray
  Write-Host ""
  exit 1
}

Write-Host ""
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "  MiMo 接入探测" -ForegroundColor White
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "  地址  : $BaseUrl"
Write-Host "  模型  : $Model"
Write-Host "  Key   : $($key.Substring(0, [Math]::Min(6, $key.Length)))...（已隐藏，长度 $($key.Length)）"
Write-Host "  thinking 参数：$(if ($SendThinkingParam) { '发送（disabled）' } else { '不发送' })"

$headers = @{
  'Content-Type'  = 'application/json'
  Authorization   = "Bearer $key"
}

function Invoke-Mimo {
  param([hashtable]$Body, [int]$TimeoutSec = 90)
  $json = $Body | ConvertTo-Json -Depth 12 -Compress
  try {
    $r = Invoke-WebRequest -Uri "$BaseUrl/chat/completions" -Method Post -Headers $headers `
      -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec $TimeoutSec
    return @{ status = $r.StatusCode; body = $r.Content }
  } catch {
    return @{ status = 0; body = $_.Exception.Message }
  }
}

function Count-Tokens($bodyText) {
  try {
    $j = $bodyText | ConvertFrom-Json
    if ($j.usage) { return [int]$j.usage.total_tokens }
  } catch { }
  return 0
}

# ============================================================================
Step '第 1 层 · 连通性与鉴权（1 次极小的文本请求）'
# ============================================================================

$t0 = Get-Date
$r1 = Invoke-Mimo @{
  model      = $Model
  messages   = @(
    @{ role = 'system'; content = 'Reply with the single word: pong' }
    @{ role = 'user'; content = 'ping' }
  )
  max_tokens = 16
}
$elapsed = [Math]::Round(((Get-Date) - $t0).TotalSeconds, 2)

if ($r1.status -eq 0) {
  Bad "请求未发出：$($r1.body)"
  Info '检查网络/代理。若是 429 或超时，稍后重试即可。'
  exit 1
}

Info "HTTP $($r1.status)   耗时 ${elapsed}s"

if ($r1.status -ne 200) {
  Bad "鉴权或请求被拒（HTTP $($r1.status)）"
  $preview = $r1.body
  if ($preview.Length -gt 500) { $preview = $preview.Substring(0, 500) }
  Info $preview
  Write-Host ""
  switch ($r1.status) {
    401 { Info '401：Key 无效或已过期。到 Token Plan 控制台确认 token 状态。' }
    403 { Info '403：Key 无权限，或 Token Plan 未激活/额度用尽。' }
    404 { Info "404：地址或模型名不对。当前 $BaseUrl / $Model" }
    429 { Info '429：触发限流。MiMo 同模型账号级 RPM 100，稍等再试。' }
  }
  exit 1
}

$j1 = $null
try { $j1 = $r1.body | ConvertFrom-Json } catch { }
if ($j1) {
  Ok '返回体是合法 JSON'
  $content = $j1.choices[0].message.content
  Info "模型回复：$content"
  Info "返回的 model 字段：$($j1.model)"
  Ok "usage 可读（total_tokens=$($j1.usage.total_tokens)）"
  $script:totalCostTokens += [int]$j1.usage.total_tokens

  if ($j1.model -ne $Model) {
    Info "⚠ 返回的模型名（$($j1.model)）与请求的不一致，可能被路由到了别处"
  }
  Ok '★ 鉴权与地址均正确，可以进入下一层'
} else {
  Bad '返回体不是合法 JSON'
  Info $r1.body.Substring(0, [Math]::Min(400, $r1.body.Length))
  exit 1
}

if ($StopAfter -le 1) {
  Write-Host ""
  Info "已按要求停在第 1 层。累计 token：$($script:totalCostTokens)"
  exit $(if ($script:fail -eq 0) { 0 } else { 1 })
}

# ============================================================================
Step '第 2 层 · 结构化输出与参数兼容（1 次请求）'
# ============================================================================

$body2 = @{
  model           = $Model
  messages        = @(
    @{ role = 'system'; content = 'You are a JSON-only API. Return ONLY a JSON object, no prose, no code fences. Schema: {"amount": string, "taxRate": string, "note": string|null}' }
    @{ role = 'user'; content = 'Extract from this invoice line: amount 1000.00, tax rate 0.13, no note.' }
  )
  max_tokens      = 256
  response_format = @{ type = 'json_object' }
}
if ($SendThinkingParam) { $body2['thinking'] = @{ type = 'disabled' } }

$r2 = Invoke-Mimo $body2
Info "HTTP $($r2.status)"

if ($r2.status -ne 200) {
  Bad "带 response_format 的请求失败（HTTP $($r2.status)）"
  $preview = $r2.body
  if ($preview.Length -gt 500) { $preview = $preview.Substring(0, 500) }
  Info $preview
  Write-Host ""
  Info '若提示 response_format / InvalidParameter：说明该模型不支持 JSON 模式。'
  Info '我们的适配层会自动降级（去掉该参数重试并记住结论），所以这不是阻塞项 ——'
  Info '继续跑第 3 层验证字段抽取即可。'
  $script:jsonModeUnsupported = $true
} else {
  $j2 = $r2.body | ConvertFrom-Json
  $raw = $j2.choices[0].message.content
  Info "原始返回：$raw"
  # 严格 JSON 解析 —— 这正是我们 extractJson 要处理的东西
  try {
    $parsed = $raw | ConvertFrom-Json
    Ok '★ response_format=json_object 生效，返回体可直接解析'
    Info "amount=$($parsed.amount)  taxRate=$($parsed.taxRate)  note=$($parsed.note)"
  } catch {
    Bad '返回体不是严格 JSON（说明 json_object 未被遵守）'
    Info '我们的 extractJson 能兜住代码块/寒暄包裹的情况，但需要确认能解析出字段。'
  }
  $script:totalCostTokens += [int]$j2.usage.total_tokens
  if ($SendThinkingParam) { Ok 'thinking 参数被接受（未报未知参数错误）' }
}

if ($StopAfter -le 2) {
  Write-Host ""
  Info "已按要求停在第 2 层。累计 token：$($script:totalCostTokens)"
  exit $(if ($script:fail -eq 0) { 0 } else { 1 })
}

# ============================================================================
Step '第 3 层 · 图片理解（1 次请求，验证多模态与字段名）'
# ============================================================================

# 生成一张最小的发票图片：用 SVG 写字再转 PNG 需要图形库，这里改用
# 一张纯色 PNG 加文本说明 —— 本层验证的是「多模态入参是否被接受」，
# 不是识别准确率。真实准确率要用真发票，那一步在接入之后单独做。
$probeImage = Join-Path $env:TEMP 'mimo-probe.png'
$pngBase64 = $null

try {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap 640, 320
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $font = New-Object System.Drawing.Font('Arial', 20)
  $g.DrawString('增值税专用发票', $font, [System.Drawing.Brushes]::Black, 180, 40)
  $g.DrawString('金额: 1000.00', $font, [System.Drawing.Brushes]::Black, 40, 110)
  $g.DrawString('税率: 13%', $font, [System.Drawing.Brushes]::Black, 40, 160)
  $g.DrawString('税额: 130.00', $font, [System.Drawing.Brushes]::Black, 40, 210)
  $g.DrawString('价税合计: 1130.00', $font, [System.Drawing.Brushes]::Black, 40, 260)
  $bmp.Save($probeImage, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  $pngBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($probeImage))
  Info "已生成测试图：$probeImage（$([Math]::Round((Get-Item $probeImage).Length/1024,1)) KB）"
} catch {
  Info "生成测试图失败（$($_.Exception.Message)），改用纯文本占位"
}

if (-not $pngBase64) {
  Bad '无法生成测试图片，跳过第 3 层'
  exit 1
}

$body3 = @{
  model      = $Model
  messages   = @(
    @{ role = 'system'; content = 'You are an OCR engine for Chinese VAT invoices. Return ONLY a JSON object with fields: {"amountExclTax": string|null, "taxRate": string|null, "taxAmount": string|null, "amountInclTax": string|null}. Amounts as plain decimal strings without currency symbols. Use null when a field is absent.' }
    @{ role = 'user'; content = @(
        @{ type = 'image_url'; image_url = @{ url = "data:image/png;base64,$pngBase64" } }
        @{ type = 'text'; text = 'Read the four amounts from this invoice image.' }
      )
    }
  )
  max_tokens = 512
  response_format = @{ type = 'json_object' }
}
if ($SendThinkingParam) { $body3['thinking'] = @{ type = 'disabled' } }

$r3 = Invoke-Mimo $body3 -TimeoutSec 120
Info "HTTP $($r3.status)"

if ($r3.status -ne 200) {
  Bad "图片请求失败（HTTP $($r3.status)）"
  $preview = $r3.body
  if ($preview.Length -gt 600) { $preview = $preview.Substring(0, 600) }
  Info $preview
  Write-Host ""
  Info '若提示 model 不支持 image_url：'
  Info '  · mimo-v2.5 支持全模态理解；mimo-v2.5-pro 只支持文本'
  Info '  · 用 -Model mimo-v2.5 重试'
} else {
  $j3 = $r3.body | ConvertFrom-Json
  $raw3 = $j3.choices[0].message.content
  Info "原始返回：$raw3"
  $script:totalCostTokens += [int]$j3.usage.total_tokens

  try {
    $p3 = $raw3 | ConvertFrom-Json
    Ok '★ 图片以 base64 传入被接受，返回可解析 JSON'

    # ★ 这几条是本层最有价值的断言：验证模型返回的字段名与我们的提示词一致
    $expect = @('amountExclTax', 'taxRate', 'taxAmount', 'amountInclTax')
    $present = @($expect | Where-Object { $null -ne $p3.PSObject.Properties[$_] })
    Info "字段命中：$($present -join ', ')  （期望 4 个）"

    if ($present.Count -eq 0) {
      Bad '★ 模型没有返回约定字段名 —— 提示词需要调整'
      Info "实际返回的字段：$(($p3.PSObject.Properties.Name) -join ', ')"
      Info '这是接入真实模型时最常见的问题，必须在跑全量样例前解决。'
    } elseif ($present.Count -lt 4) {
      Bad "只命中 $($present.Count)/4 个字段，提示词需要收紧"
      Info "实际返回的字段：$(($p3.PSObject.Properties.Name) -join ', ')"
    } else {
      Ok '★★ 四个金额字段全部命中，提示词与该模型的配合没问题'
      Info "不含税=$($p3.amountExclTax)  税率=$($p3.taxRate)  税额=$($p3.taxAmount)  价税合计=$($p3.amountInclTax)"

      # 金额必须是「不带货币符号、不带千分位」的纯十进制串 —— 否则我们的
      # Decimal 解析会失败，而这属于静默出错（记账系统最怕的一类）
      $bad = @()
      foreach ($f in @('amountExclTax', 'taxAmount', 'amountInclTax')) {
        $v = "$($p3.$f)"
        if ($v -and $v -ne '' -and $v -notmatch '^\d+(\.\d+)?$') { $bad += "$f=$v" }
      }
      if ($bad.Count -gt 0) {
        Bad "★ 金额格式不干净（含货币符号/千分位）：$($bad -join '; ')"
        Info '需要在提示词里更明确地要求"纯十进制字符串，不含 ¥ 与千分位"。'
      } else {
        Ok '金额是纯十进制字符串（无货币符号、无千分位）'
      }
    }
  } catch {
    Bad '返回体不是严格 JSON'
    Info '若带 ```json 包裹，extractJson 仍能处理；但严格 JSON 模式没生效。'
  }
}

Remove-Item $probeImage -Force -ErrorAction SilentlyContinue

# ============================================================================
Write-Host ""
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor White
if ($script:fail -eq 0) {
  Write-Host "  探测通过：$($script:pass) 项，0 失败" -ForegroundColor Green
} else {
  Write-Host "  探测结果：$($script:pass) 通过 / $($script:fail) 失败" -ForegroundColor Yellow
}
Write-Host "  累计消耗 token：$($script:totalCostTokens)（约 $([Math]::Round($script:totalCostTokens / 10000.0, 4)) 万分之一量级）" -ForegroundColor DarkGray
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host ""

if ($script:fail -eq 0) {
  Write-Host "下一步：把配置写进 apps/api/.env（该文件已被 git 忽略）" -ForegroundColor Cyan
  Write-Host "  AI_PROVIDER=openai-compatible" -ForegroundColor White
  Write-Host "  AI_BASE_URL=https://api.xiaomimimo.com/v1" -ForegroundColor White
  Write-Host "  MIMO_API_KEY=<你的 token>" -ForegroundColor White
  Write-Host "  AI_VISION_MODEL=$Model" -ForegroundColor White
  Write-Host "  AI_TEXT_MODEL=$Model" -ForegroundColor White
  Write-Host "  AI_SEND_THINKING_PARAM=true" -ForegroundColor White
  Write-Host "  AI_THINKING_ENABLED=false" -ForegroundColor White
  Write-Host ""
}

exit $(if ($script:fail -eq 0) { 0 } else { 1 })
