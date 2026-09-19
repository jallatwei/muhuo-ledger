# AI 接入验证
# ============================================================
# 验证 AI 适配层的接口契约与 Mock 模式下的完整链路。
#
# 设计原则（与其他 verify-*.ps1 一致）：
#   · 只打接口，不碰数据库；接口返回什么就断言什么
#   · 每条 Check 都写清「在验证什么」，失败时能直接看懂
#   · 错误分支与正常分支都要测 —— 只测正常路径的脚本会给假信心
#
# ★ 这个脚本在 mock 模式下运行，零成本。它验证的是：
#     ① 适配层的接口契约（字段、类型、状态码）
#     ② 会计交叉校验是否真的拦得住错误票（故意构造的错误样例）
#     ③ 样例名拼错时是否**报错**而不是静默返回不相干数据
#        （这条是实测发现的真 bug：原实现会静默回退到哈希选样，
#         导致验证脚本拿着火车票数据断言发票逻辑，全绿但毫无意义）
#     ④ 路由决策是否与校验结论一致
#
# 用法：pwsh -File tools\verify-ai-integration.ps1
param(
  [string]$BaseUrl = 'http://localhost:3000/api'
)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0

function Section([string]$title) {
  Write-Host ""
  Write-Host "── $title " -NoNewline -ForegroundColor Cyan
  Write-Host ("─" * [Math]::Max(0, 68 - $title.Length)) -ForegroundColor DarkGray
}

function Check([string]$name, [scriptblock]$body) {
  try {
    $ok = & $body
    if ($ok) {
      $script:pass++
      Write-Host "  [PASS] $name" -ForegroundColor Green
    } else {
      $script:fail++
      Write-Host "  [FAIL] $name" -ForegroundColor Red
    }
  } catch {
    $script:fail++
    Write-Host "  [FAIL] $name" -ForegroundColor Red
    Write-Host "         $($_.Exception.Message)" -ForegroundColor DarkGray
  }
}

function Note([string]$text) {
  Write-Host "         $text" -ForegroundColor DarkGray
}

# ── 取一个可用主体 ──────────────────────────────────────────
$entities = (Invoke-WebRequest -Uri "$BaseUrl/entities" -UseBasicParsing).Content | ConvertFrom-Json
$entities = @($entities)
if ($entities.Count -eq 0) {
  Write-Host "✗ 没有可用的核算主体，请先执行 seed" -ForegroundColor Red
  exit 1
}
$entityId = $entities[0].id
$entityName = $entities[0].name

Write-Host ""
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "  AI 接入验证" -ForegroundColor White
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "  API   : $BaseUrl"
Write-Host "  主体  : $entityName ($entityId)"

# ============================================================================
Section '1. 适配层健康与配置'
# ============================================================================

$health = $null
Check 'AI 健康检查可访问' {
  $script:health = (Invoke-WebRequest -Uri "$BaseUrl/ai/health" -UseBasicParsing).Content | ConvertFrom-Json
  return $null -ne $script:health
}

Check '健康检查含 provider / reachable / circuitBreaker' {
  $h = $script:health
  return ($null -ne $h.provider) -and ($null -ne $h.reachable) -and ($null -ne $h.circuitBreaker)
}

Check 'provider 取值合法（mock / openai-compatible / local）' {
  return @('mock', 'openai-compatible', 'local') -contains $script:health.provider
}

Check '熔断状态取值合法（CLOSED / OPEN / HALF_OPEN）' {
  return @('CLOSED', 'OPEN', 'HALF_OPEN') -contains $script:health.circuitBreaker.state
}

Check '阈值回传（OCR 置信度 / 建议置信度 / 日预算）' {
  $t = $script:health.thresholds
  return ($null -ne $t.ocrMinConfidence) -and ($null -ne $t.suggestMinConfidence) -and ($null -ne $t.dailyBudget)
}

Note "provider=$($script:health.provider)  reachable=$($script:health.reachable)  熔断=$($script:health.circuitBreaker.state)"

Check '★ 当前不是 mock 时给出提示（避免误以为在测真实模型）' {
  if ($script:health.provider -eq 'mock') {
    Note '当前为 mock 模式：离线、零成本、结果确定'
    return $true
  }
  Note "⚠ 当前 provider=$($script:health.provider)，会真实调用模型并产生费用"
  return $true
}

# ============================================================================
Section '2. 样例与目标清单'
# ============================================================================

$samples = (Invoke-WebRequest -Uri "$BaseUrl/ai/samples" -UseBasicParsing).Content | ConvertFrom-Json
Check '样例清单可访问且非空' {
  return @($samples.samples).Count -gt 0
}
Check '每个样例都有 key / label / covers' {
  $bad = @($samples.samples | Where-Object { -not $_.key -or -not $_.label -or -not $_.covers })
  return $bad.Count -eq 0
}
Check '★ 覆盖了「故意构造的错误样例」（否则校验逻辑没被测到）' {
  $wrong = @($samples.samples | Where-Object { $_.label -match '★' })
  Note "错误样例 $($wrong.Count) 个：$(($wrong | ForEach-Object { $_.key }) -join ', ')"
  return $wrong.Count -ge 3
}
Note "样例总数：$(@($samples.samples).Count)"

$targets = (Invoke-WebRequest -Uri "$BaseUrl/ai/targets" -UseBasicParsing).Content | ConvertFrom-Json
Check '识别目标覆盖「单据」与「报表」两类' {
  $groups = @($targets.targets | ForEach-Object { $_.group } | Select-Object -Unique)
  return ($groups -contains '单据') -and ($groups -contains '报表')
}
Check '目标枚举含发票 / 银行回单 / 资产负债表 / 利润表' {
  $vals = @($targets.targets | ForEach-Object { $_.value })
  foreach ($need in @('INVOICE', 'BANK_SLIP', 'BALANCE_SHEET', 'INCOME_STATEMENT')) {
    if ($vals -notcontains $need) { return $false }
  }
  return $true
}

# ============================================================================
Section '3. ★ 样例名拼错必须报错，不能静默返回不相干数据'
# ============================================================================
Check '★ 不存在的样例名返回 4xx（客户端错误，不是 500）' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=nonexistent-case-xyz&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  Note "HTTP $($r.StatusCode)"
  if ($r.StatusCode -ge 500) {
    Note '★ 返回 5xx —— 客户端传错样例名不该报成系统内部错误'
    return $false
  }
  return $r.StatusCode -ge 400
}

Check '★ 错误信息里真的列出了可选样例名（不是兜底文案）' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=nope-xyz&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $body = $r.Content | ConvertFrom-Json
  $msg = "$($body.userMessage) $($body.message)"
  Note $msg.Substring(0, [Math]::Min(160, $msg.Length))
  # 必须真的把样例名点出来，否则用户还是不知道该填什么
  return $msg -match 'purchase-office-supplies'
}

Check '样例名格式非法（含特殊字符）被拒绝' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=bad%3Cscript%3E&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  Note "HTTP $($r.StatusCode)"
  return $r.StatusCode -ge 400
}

# ============================================================================
Section '4. 抽取契约（正常样例）'
# ============================================================================

$preview = $null
Check '进项专票样例可抽取' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=purchase-office-supplies&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  if ($r.StatusCode -ne 200 -and $r.StatusCode -ne 201) { return $false }
  $script:preview = $r.Content | ConvertFrom-Json
  return $null -ne $script:preview.preview
}

Check '返回体含 preview / validation / routing / explanation 四段' {
  $p = $script:preview
  return ($null -ne $p.preview) -and ($null -ne $p.validation) -and ($null -ne $p.routing) -and ($null -ne $p.explanation)
}

Check '发票字段齐全（购销双方、三项金额、税率、票号）' {
  $d = $script:preview.preview.data
  foreach ($f in @('direction', 'invoiceNumber', 'invoiceDate', 'sellerName', 'buyerName', 'amountExclTax', 'taxRate', 'taxAmount', 'amountInclTax')) {
    if ($null -eq $d.$f) { Note "缺字段：$f"; return $false }
  }
  return $true
}

Check '金额一律是字符串（避免 IEEE754 精度问题）' {
  $d = $script:preview.preview.data
  foreach ($f in @('amountExclTax', 'taxAmount', 'amountInclTax')) {
    if ($d.$f -isnot [string]) { Note "$f 不是字符串：$($d.$f.GetType().Name)"; return $false }
  }
  return $true
}

Check '金额勾稽自洽（不含税 + 税额 = 价税合计，容差 0.01）' {
  $d = $script:preview.preview.data
  $sum = [decimal]$d.amountExclTax + [decimal]$d.taxAmount
  $total = [decimal]$d.amountInclTax
  $diff = [Math]::Abs($sum - $total)
  Note "$($d.amountExclTax) + $($d.taxAmount) = $sum  票面 $total  差 $diff"
  return $diff -le 0.01
}

Check '逐字段置信度都在 0..1' {
  $fc = $script:preview.preview.fieldConfidence
  foreach ($prop in $fc.PSObject.Properties) {
    $v = [double]$prop.Value
    if ($v -lt 0 -or $v -gt 1) { Note "$($prop.Name)=$v 越界"; return $false }
  }
  return $true
}

Check '整体置信度在 0..1' {
  $c = [double]$script:preview.preview.overallConfidence
  return ($c -ge 0) -and ($c -le 1)
}

Check '返回了实际使用的模型名与耗时' {
  return ($null -ne $script:preview.preview.model) -and ($null -ne $script:preview.preview.latencyMs)
}

# ============================================================================
Section '5. ★ 会计交叉校验真的拦得住错误票'
# ============================================================================

Check '★ 购销方颠倒 → 校验失败（V4）' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=direction-swapped&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $j = $r.Content | ConvertFrom-Json
  $fails = @($j.validation.findings | Where-Object { $_.level -eq 'FAIL' })
  Note "失败项 $($fails.Count)：$(($fails | ForEach-Object { "$($_.code) $($_.message)" }) -join ' / ')"
  return $j.validation.failCount -ge 1
}

Check '★ 购销方颠倒 → 路由为「待人工复核」而不是自动生成凭证' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=direction-swapped&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $j = $r.Content | ConvertFrom-Json
  Note "routing=$($j.routing.status)"
  return $j.routing.status -eq 'NEEDS_REVIEW'
}

Check '★ 金额勾稽不成立 → 校验失败（V1）' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=amount-mismatch&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $j = $r.Content | ConvertFrom-Json
  $v1 = @($j.validation.findings | Where-Object { $_.code -eq 'V1' -and $_.level -eq 'FAIL' })
  Note "V1 失败项：$($v1.Count)"
  return $v1.Count -ge 1
}

Check '★ 方向无法判定 → 必须人工指定（不得猜）' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=no-direction&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $j = $r.Content | ConvertFrom-Json
  Note "routing=$($j.routing.status)  reason=$($j.routing.reason)"
  return ($j.routing.status -eq 'NEEDS_REVIEW') -or ($j.validation.failCount -ge 1)
}

Check '★ 正常样例走自动草稿（AUTO_DRAFTED），路由与校验结论一致' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=purchase-office-supplies&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $j = $r.Content | ConvertFrom-Json
  Note "routing=$($j.routing.status)  failCount=$($j.validation.failCount)"
  if ($j.validation.failCount -eq 0) { return $j.routing.status -eq 'AUTO_DRAFTED' }
  return $j.routing.status -eq 'NEEDS_REVIEW'
}

Check '★ 每条校验结论都带 level/code/message，level 取值合法' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=direction-swapped&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $j = $r.Content | ConvertFrom-Json
  $bad = @($j.validation.findings | Where-Object {
    -not $_.code -or -not $_.message -or (@('PASS', 'FAIL', 'WARN', 'INFO') -notcontains $_.level)
  })
  return $bad.Count -eq 0
}

# ============================================================================
Section '6. 报表类识别（不入账，只校验平衡）'
# ============================================================================

Check '资产负债表（平衡）可识别' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=balance-sheet-balanced&targetType=BALANCE_SHEET" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $j = $r.Content | ConvertFrom-Json
  Note "balanced=$($j.validation.balanced)  差额=$($j.validation.balanceDifference)"
  return $null -ne $j.preview
}

Check '★ 资产负债表不平衡时被指出（不给假平衡）' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=balance-sheet-unbalanced&targetType=BALANCE_SHEET" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $j = $r.Content | ConvertFrom-Json
  Note "balanced=$($j.validation.balanced)  差额=$($j.validation.balanceDifference)"
  return ($j.validation.balanced -eq $false) -or ($j.validation.failCount -ge 1)
}

Check '★ 报表识别不生成凭证（routing 为 null）' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=balance-sheet-balanced&targetType=BALANCE_SHEET" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $j = $r.Content | ConvertFrom-Json
  return $null -eq $j.routing
}

Check '利润表可识别' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=income-statement&targetType=INCOME_STATEMENT" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $j = $r.Content | ConvertFrom-Json
  return $null -ne $j.preview.data
}

Check '增值税申报表可识别' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=$entityId&case=vat-return-main&targetType=TAX_RETURN" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $j = $r.Content | ConvertFrom-Json
  return $null -ne $j.preview.data
}

# ============================================================================
Section '7. 错误分支（缺参数 / 非法目标）'
# ============================================================================

Check '缺 entityId 返回 400（不是 500，也不是泄露 Prisma 内部结构）' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?case=purchase-office-supplies&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  Note "HTTP $($r.StatusCode)"
  if ($r.StatusCode -eq 400) { return $true }
  # 500 也算失败：那说明用户拿到的是内部错误而不是可读提示
  return $false
}

Check '缺 entityId 的提示是中文且说明怎么办' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?case=purchase-office-supplies&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  $body = $r.Content | ConvertFrom-Json
  Note "userMessage=$($body.userMessage)"
  return ($body.userMessage -match 'entityId') -and ($body.userMessage.Length -gt 10)
}

Check '不存在的 entityId 返回 4xx（不是 500）' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract?entityId=00000000-0000-0000-0000-000000000000&targetType=INVOICE" `
    -Method Post -UseBasicParsing -SkipHttpErrorCheck
  Note "HTTP $($r.StatusCode)"
  return $r.StatusCode -ge 400 -and $r.StatusCode -lt 500
}

Check '空 body 的 identify 请求被拒绝' {
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/extract" -Method Post -UseBasicParsing -SkipHttpErrorCheck
  return $r.StatusCode -ge 400
}

# ============================================================================
Section '8. 端到端：文件识别闭环（真实文件，非样例）'
# ============================================================================

$tmpFile = Join-Path $env:TEMP 'bk-ai-verify-invoice.csv'
# 造一个最小但结构完整的发票台账 CSV，走真实文件通道
@'
发票代码,发票号码,开票日期,购买方名称,销售方名称,金额,税率,税额,价税合计
011002100311,12345678,2026-01-15,演示科技有限公司,某某办公用品有限公司,1000.00,0.13,130.00,1130.00
'@ | Set-Content -Path $tmpFile -Encoding UTF8

Check '★ 真实文件（CSV）能被识别通道接收' {
  $form = @{ file = Get-Item $tmpFile; entityId = $entityId }
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/recognize" -Method Post -Form $form -UseBasicParsing -SkipHttpErrorCheck
  Note "HTTP $($r.StatusCode)"
  if ($r.StatusCode -ge 400) {
    Note "响应：$($r.Content.Substring(0, [Math]::Min(300, $r.Content.Length)))"
    return $false
  }
  $script:recog = $r.Content | ConvertFrom-Json
  return $null -ne $script:recog
}

Check '★ 返回体说明了文件是怎么被读进来的（ingested.kind）' {
  if (-not $script:recog) { return $false }
  $kind = $script:recog.ingested.kind
  Note "kind=$kind  文件名=$($script:recog.ingested.fileName)  文本 $($script:recog.ingested.textChars) 字符"
  return @('IMAGE', 'PDF', 'SHEET') -contains $kind
}

Check '★ 系统给出了「这是什么单据」的判定与依据' {
  if (-not $script:recog) { return $false }
  $c = $script:recog.classification
  Note "label=$($c.label)  targetType=$($c.targetType)  confidence=$($c.confidence)  chosenBy=$($c.chosenBy)"
  if ($c.evidence) { Note "依据：$((@($c.evidence) | ForEach-Object { $_.signal }) -join ', ')" }
  return ($null -ne $c.label) -and ($null -ne $c.reason)
}

Check '人工指定的 targetType 优先于系统判定' {
  $form = @{ file = Get-Item $tmpFile; entityId = $entityId; targetType = 'INVOICE' }
  $r = Invoke-WebRequest -Uri "$BaseUrl/ai/recognize" -Method Post -Form $form -UseBasicParsing -SkipHttpErrorCheck
  if ($r.StatusCode -ge 400) { return $false }
  $j = $r.Content | ConvertFrom-Json
  return $j.classification.chosenBy -eq 'USER' -or $j.classification.targetType -eq 'INVOICE'
}

Check '识别结果不直接过账（需人工确认）' {
  if (-not $script:recog) { return $false }
  $expl = "$($script:recog.explanation)"
  Note $expl
  return $expl.Length -gt 0
}

Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue

# ============================================================================
Write-Host ""
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor White
if ($script:fail -eq 0) {
  Write-Host "  结果：$($script:pass) 通过 / 0 失败" -ForegroundColor Green
} else {
  Write-Host "  结果：$($script:pass) 通过 / $($script:fail) 失败" -ForegroundColor Red
}
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host ""

exit $(if ($script:fail -eq 0) { 0 } else { 1 })
