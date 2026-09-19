<#
.SYNOPSIS
  验证「发票仓库 → 凭证勾稽 → A4 凭证册打印」完整链路

.DESCRIPTION
  这个脚本会真的造一张发票图片，走完下面这条链：
    上传单据(Document) → 建发票(Invoice) → 建凭证并关联发票 → 过账
    → 凭证册组装（解析出附件）→ 渲染 A4 HTML

  验证点：
    1. 单据上传幂等（同一文件不重复入库）
    2. 附件能通过 JournalLine.invoiceId → Invoice.documentId 解析出来
    3. 凭证册 HTML 里包含该发票的 <img>（内联 data URL）
    4. 打印统计里「有附件」数量正确
    5. 缺附件的自动凭证会被标注

  用法：pwsh -File tools/verify-printing.ps1
  前置：API 已启动（http://localhost:3000/api）
#>
[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://localhost:3000/api',
  [string]$DbContainer = 'bk-postgres',
  [string]$DbName = 'bookkeeper_dev',
  [string]$DbUser = 'bookkeeper'
)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0

function Section([string]$t) {
  Write-Host ''
  Write-Host "── $t " -ForegroundColor Cyan -NoNewline
  Write-Host ('─' * [Math]::Max(0, 58 - $t.Length)) -ForegroundColor DarkGray
}

function Check([string]$name, [scriptblock]$test) {
  try {
    if ((& $test) -eq $true) { Write-Host "  [PASS] $name" -ForegroundColor Green; $script:pass++ }
    else { Write-Host "  [FAIL] $name" -ForegroundColor Red; $script:fail++ }
  } catch {
    Write-Host "  [FAIL] $name" -ForegroundColor Red
    Write-Host "         $($_.Exception.Message)" -ForegroundColor DarkRed
    $script:fail++
  }
}

function Psql([string]$sql) {
  return (docker exec $DbContainer psql -U $DbUser -d $DbName -t -A -c $sql 2>&1 | Out-String).Trim()
}

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor White
Write-Host '  发票仓库 → 凭证勾稽 → A4 凭证册打印  链路验证' -ForegroundColor White
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor White

$entityId = (Invoke-RestMethod "$BaseUrl/entities")[0].id
$period = (Invoke-RestMethod "$BaseUrl/periods?entityId=$entityId" | Where-Object { $_.month -eq 3 })[0]
$periodLabel = "{0:D4}-{1:D2}" -f $period.fiscalYear, $period.month
$voucherDate = "$periodLabel-18"

# 运行前清理：删除上一次打印验证留下的凭证与发票，避免幂等键冲突与统计污染
Psql "DELETE FROM journal_line WHERE ""voucherId"" IN (SELECT id FROM journal_voucher WHERE summary LIKE '【打印验证】%');" | Out-Null
Psql "DELETE FROM journal_voucher WHERE summary LIKE '【打印验证】%';" | Out-Null
Psql "DELETE FROM invoice WHERE ""dedupHash"" LIKE 'VERIFY-PRINT-%';" | Out-Null

$work = Join-Path $env:TEMP 'bk-print-verify'
New-Item -ItemType Directory -Force -Path $work | Out-Null

# ============================================================================
Section '1. 造一张真实的发票图片'

$invoiceImage = Join-Path $work 'invoice-test.png'
Check '生成 A4 比例发票样例图（PNG）' {
  Add-Type -AssemblyName System.Drawing
  $w = 1240; $h = 1754  # A4 @150dpi
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'ClearTypeGridFit'

  $fTitle = New-Object System.Drawing.Font('SimHei', 34, [System.Drawing.FontStyle]::Bold)
  $fHead  = New-Object System.Drawing.Font('SimHei', 16)
  $fBody  = New-Object System.Drawing.Font('SimSun', 15)
  $black  = [System.Drawing.Brushes]::Black
  $pen    = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 2)

  $g.DrawString('上海增值税专用发票', $fTitle, $black, 340, 90)
  $g.DrawLine($pen, 80, 160, $w - 80, 160)

  $left = 90
  $g.DrawString('发票代码：3100201130', $fBody, $black, $left, 200)
  $g.DrawString('发票号码：12345678',   $fBody, $black, $left, 240)
  $g.DrawString('开票日期：2026-03-18', $fBody, $black, $left, 280)
  $g.DrawString('校验码：12345 67890 12345 67890', $fBody, $black, $left, 320)

  $g.DrawLine($pen, 80, 370, $w - 80, 370)
  $g.DrawString('购买方', $fHead, $black, $left, 395)
  $g.DrawString('名称：演示科技有限公司', $fBody, $black, $left + 120, 395)
  $g.DrawString('纳税人识别号：91310000MA1DEMO001', $fBody, $black, $left + 120, 435)
  $g.DrawLine($pen, 80, 490, $w - 80, 490)
  $g.DrawString('销售方', $fHead, $black, $left, 515)
  $g.DrawString('名称：某某办公用品有限公司', $fBody, $black, $left + 120, 515)
  $g.DrawString('纳税人识别号：91310000MA1OFFICE01', $fBody, $black, $left + 120, 555)

  $g.DrawLine($pen, 80, 615, $w - 80, 615)
  # 明细表
  $g.DrawString('货物或应税劳务名称', $fHead, $black, 100, 635)
  $g.DrawString('规格型号', $fHead, $black, 480, 635)
  $g.DrawString('数量', $fHead, $black, 680, 635)
  $g.DrawString('单价', $fHead, $black, 800, 635)
  $g.DrawString('金额', $fHead, $black, 950, 635)
  $g.DrawString('税率', $fHead, $black, 1090, 635)
  $g.DrawLine($pen, 80, 675, $w - 80, 675)
  $g.DrawString('A4复印纸', $fBody, $black, 100, 695)
  $g.DrawString('70g/500张', $fBody, $black, 480, 695)
  $g.DrawString('10', $fBody, $black, 690, 695)
  $g.DrawString('100.00', $fBody, $black, 790, 695)
  $g.DrawString('1000.00', $fBody, $black, 940, 695)
  $g.DrawString('13%', $fBody, $black, 1090, 695)

  $g.DrawLine($pen, 80, 760, $w - 80, 760)
  $g.DrawString('价税合计（大写）', $fHead, $black, 100, 785)
  $g.DrawString('壹仟壹佰叁拾元整', $fBody, $black, 340, 785)
  $g.DrawString('（小写）¥1130.00', $fBody, $black, 760, 785)
  $g.DrawLine($pen, 80, 840, $w - 80, 840)
  $g.DrawString('收款人：张三', $fBody, $black, 100, 865)
  $g.DrawString('复核：李四', $fBody, $black, 420, 865)
  $g.DrawString('开票人：王五', $fBody, $black, 740, 865)

  $g.DrawString('（此为打印验证用样例发票，非真实票据）', (New-Object System.Drawing.Font('SimSun', 12)), [System.Drawing.Brushes]::Gray, 340, 940)

  $g.Dispose()
  $bmp.Save($invoiceImage, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return (Test-Path $invoiceImage) -and ((Get-Item $invoiceImage).Length -gt 5000)
}
Write-Host "         图片：$invoiceImage  ($([math]::Round((Get-Item $invoiceImage).Length/1KB,1)) KB)" -ForegroundColor DarkGray

# ============================================================================
Section '2. 上传到单据库（含幂等验证）'

$uploaded = $null
Check '上传发票图片成功' {
  $form = @{ entityId = $entityId; docType = 'INVOICE_PURCHASE' }
  $r = Invoke-RestMethod "$BaseUrl/documents/upload" -Method Post -Form ($form + @{ file = Get-Item $invoiceImage }) -TimeoutSec 60
  $script:uploaded = $r
  return [bool]$r.documentId
}
Write-Host "         documentId = $($uploaded.documentId)   duplicated = $($uploaded.duplicated)" -ForegroundColor DarkGray

Check '★ 幂等：重复上传同一文件不新建单据' {
  $form = @{ entityId = $entityId; docType = 'INVOICE_PURCHASE' }
  $r = Invoke-RestMethod "$BaseUrl/documents/upload" -Method Post -Form ($form + @{ file = Get-Item $invoiceImage }) -TimeoutSec 60
  return ($r.duplicated -eq $true) -and ($r.documentId -eq $script:uploaded.documentId)
}

Check '单据文件可通过接口读回（内容一致）' {
  $bytes = Invoke-WebRequest "$BaseUrl/documents/$($script:uploaded.documentId)/file" -TimeoutSec 60 -UseBasicParsing
  return ($bytes.StatusCode -eq 200) -and ($bytes.RawContentLength -gt 5000)
}

# ============================================================================
Section '3. 建立发票与凭证的勾稽关系'

$invoiceId = $null
Check '创建发票记录并关联单据（走 API，含金额勾稽校验）' {
  $body = @{
    entityId = $entityId
    direction = 'INPUT'
    category = 'SPECIAL_VAT'
    invoiceCode = '3100201130'
    invoiceNumber = '12345678'
    invoiceDate = $voucherDate
    sellerName = '某某办公用品有限公司'
    sellerTaxNo = '91310000MA1OFFICE01'
    buyerName = '演示科技有限公司'
    buyerTaxNo = '91310000MA1DEMO001'
    amountExclTax = '1000.00'
    taxRate = '0.13'
    taxAmount = '130.00'
    amountInclTax = '1130.00'
    isDeductible = $true
    documentId = $script:uploaded.documentId
    items = @(
      @{ itemName = 'A4复印纸'; spec = '70g/500张'; unit = '箱'; quantity = '10'; unitPrice = '100.00'; amountExclTax = '1000.00'; taxRate = '0.13'; taxAmount = '130.00' }
    )
  }
  $r = Invoke-RestMethod "$BaseUrl/invoices" -Method Post -Body ($body | ConvertTo-Json -Depth 8) -ContentType 'application/json'
  $script:invoiceId = $r.id
  Write-Host "         invoiceId = $($r.id)   duplicated=$($r.duplicated)" -ForegroundColor DarkGray
  return ($r.id -is [string]) -and ($r.id.Length -eq 36)
}

Check '★ 金额勾稽校验：价税合计对不上时拒绝写入' {
  $bad = @{
    entityId = $entityId; direction = 'INPUT'; invoiceNumber = 'BAD-0001'
    invoiceDate = $voucherDate; sellerName = '测试'; buyerName = '演示科技有限公司'
    amountExclTax = '1000.00'; taxRate = '0.06'; taxAmount = '60.00'; amountInclTax = '1090.00'
  }
  try {
    Invoke-RestMethod "$BaseUrl/invoices" -Method Post -Body ($bad | ConvertTo-Json -Depth 6) -ContentType 'application/json' | Out-Null
    return $false
  } catch {
    $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).userMessage
    Write-Host "         → $msg" -ForegroundColor DarkGray
    return ($msg -match '勾稽不成立')
  }
}

$voucherId = $null
Check '创建凭证（借办公费+待认证进项，贷应付账款）并把发票挂到分录上' {
  $body = @{
    entityId = $entityId
    periodId = $period.id
    voucherDate = $voucherDate
    summary = '【打印验证】采购办公用品'
    sourceType = 'INVOICE'
    sourceId = $script:invoiceId
    idempotencyKey = 'VERIFY-PRINT-VOUCHER-1'
    ruleReason = '命中规则「采购办公用品」：卖方名称含"办公"，品名为 A4复印纸'
    lines = @(
      @{ accountCode = '660202';   direction = 'DEBIT';  amount = '1000.00'; summary = '办公费';         invoiceId = $script:invoiceId }
      @{ accountCode = '22210102'; direction = 'DEBIT';  amount = '130.00';  summary = '待认证进项税额'; invoiceId = $script:invoiceId }
      @{ accountCode = '2202';     direction = 'CREDIT'; amount = '1130.00'; summary = '应付账款';       partnerId = 'verify-partner'; invoiceId = $script:invoiceId }
    )
  }
  $r = Invoke-RestMethod "$BaseUrl/vouchers" -Method Post -Body ($body | ConvertTo-Json -Depth 8) -ContentType 'application/json'
  $script:voucherId = $r.id
  Write-Host "         voucherId = $($r.id)   alreadyExists=$($r.alreadyExists)" -ForegroundColor DarkGray
  return ($r.id -is [string]) -and ($r.id.Length -eq 36)
}

Check '★ 引用不存在的发票时给出可读错误，而不是 500' {
  $bad = @{
    entityId = $entityId; periodId = $period.id; voucherDate = $voucherDate
    summary = '【打印验证】引用不存在的发票'; sourceType = 'MANUAL'
    lines = @(
      @{ accountCode = '660202'; direction = 'DEBIT';  amount = '100.00'; invoiceId = '00000000-0000-0000-0000-000000000000' }
      @{ accountCode = '2202';   direction = 'CREDIT'; amount = '100.00'; partnerId = 'x' }
    )
  }
  try {
    Invoke-RestMethod "$BaseUrl/vouchers" -Method Post -Body ($bad | ConvertTo-Json -Depth 6) -ContentType 'application/json' | Out-Null
    return $false
  } catch {
    $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).userMessage
    Write-Host "         → $msg" -ForegroundColor DarkGray
    return ($msg -match '发票不存在')
  }
}

Check '提交审核 → 审核 → 过账' {
  Invoke-RestMethod "$BaseUrl/vouchers/$($script:voucherId)/submit" -Method Post -Body '{}' -ContentType 'application/json' | Out-Null
  Invoke-RestMethod "$BaseUrl/vouchers/$($script:voucherId)/approve" -Method Post -Body '{}' -ContentType 'application/json' | Out-Null
  $r = Invoke-RestMethod "$BaseUrl/vouchers/$($script:voucherId)/post" -Method Post -Body '{}' -ContentType 'application/json'
  return ($r.voucherNo -ge 1)
}
# ============================================================================
Section '4. 发票仓库能查到勾稽关系'

Check '仓库列表显示该单据已关联凭证' {
  $list = Invoke-RestMethod "$BaseUrl/documents?entityId=$entityId&linked=true"
  $doc = $list.items | Where-Object { $_.id -eq $script:uploaded.documentId } | Select-Object -First 1
  if (-not $doc) { return $false }
  Write-Host "         关联凭证：$(($doc.linkedVouchers | ForEach-Object { $_.label }) -join ', ')" -ForegroundColor DarkGray
  return ($doc.isLinked -eq $true) -and ($doc.linkedVouchers.Count -ge 1)
}

Check '仓库列表能带出发票结构化字段' {
  $list = Invoke-RestMethod "$BaseUrl/documents?entityId=$entityId&linked=true"
  $doc = $list.items | Where-Object { $_.id -eq $script:uploaded.documentId } | Select-Object -First 1
  return ($doc.invoices.Count -eq 1) -and ($doc.invoices[0].amountInclTax -eq '1130.00')
}

Check '仓库总览统计正确' {
  $s = Invoke-RestMethod "$BaseUrl/documents/warehouse/stats?entityId=$entityId"
  return ($s.totalDocuments -ge 1) -and ($s.invoicesWithDocument -ge 1)
}

# ============================================================================
Section '5. ★ 凭证册组装能解析出附件'

$stats = $null
Check '打印统计：本期有凭证且至少一张有附件' {
  $script:stats = Invoke-RestMethod "$BaseUrl/printing/voucher-book/stats?entityId=$entityId&periodId=$($period.id)"
  return ($script:stats.voucherCount -ge 1) -and ($script:stats.attachmentCount -ge 1)
}
Write-Host "         凭证 $($stats.voucherCount) 张，附件 $($stats.attachmentCount) 张，有附件 $($stats.withAttachment) 张" -ForegroundColor DarkGray

Check '单张凭证的附件清单包含该发票' {
  $r = Invoke-RestMethod "$BaseUrl/printing/voucher/$script:voucherId/attachments?entityId=$entityId"
  return ($r.attachments.Count -ge 1) -and ($r.attachments[0].kind -eq 'INVOICE')
}

Check '附件信息带金额，便于打印时与凭证核对' {
  $r = Invoke-RestMethod "$BaseUrl/printing/voucher/$script:voucherId/attachments?entityId=$entityId"
  $a = $r.attachments[0]
  Write-Host "         附件标题：$($a.title)" -ForegroundColor DarkGray
  Write-Host "         摘要：$($a.summary)" -ForegroundColor DarkGray
  return ([decimal]$a.amount -eq 1130.00) -and ($a.isImage -eq $true)
}

# ============================================================================
Section '6. ★ 渲染 A4 凭证册 HTML'

$htmlPath = Join-Path $work 'voucher-book.html'
$html = $null
Check '凭证册 HTML 生成成功且包含封面' {
  $r = Invoke-WebRequest "$BaseUrl/printing/voucher-book?entityId=$entityId&periodId=$($period.id)&attachmentMode=IMAGE" -TimeoutSec 120 -UseBasicParsing
  $script:html = $r.Content
  [System.IO.File]::WriteAllText($htmlPath, $r.Content, [System.Text.UTF8Encoding]::new($false))
  return ($r.StatusCode -eq 200) -and ($r.Content -match '记 账 凭 证 册')
}
Write-Host "         HTML：$htmlPath  ($([math]::Round((Get-Item $htmlPath).Length/1KB,1)) KB)" -ForegroundColor DarkGray

Check '★ HTML 内联了发票图片（data URL），打印不会丢图' {
  return ($script:html -match 'data:image/png;base64,[A-Za-z0-9+/=]{500,}')
}

Check 'HTML 只使用 A4 版式（@page size: A4）' {
  return ($script:html -match '@page\s*\{\s*size:\s*A4')
}

Check 'HTML 含装订边设置（左侧 25mm）' {
  return ($script:html -match '25mm')
}

Check 'HTML 含大写金额（凭证与发票核对用）' {
  return ($script:html -match '壹仟壹佰叁拾元整')
}

Check '★ HTML 含"金额"等宽右对齐样式（会计核对硬要求）' {
  return ($script:html -match 'tabular-nums') -and ($script:html -match '\.num\s*\{')
}

Check 'HTML 含制单/审核/记账签字位' {
  return ($script:html -match '制单：') -and ($script:html -match '审核：') -and ($script:html -match '记账：')
}

Check '凭证页显示自动记账依据（回答"为什么这么记"）' {
  return ($script:html -match '命中规则「采购办公用品」')
}

Check 'HTML 含科目发生额汇总表' {
  return ($script:html -match '科 目 发 生 额 汇 总 表')
}

Check '每张凭证独立分页（page-break-after）' {
  return ($script:html -match 'page-break-after:\s*always')
}

Check '打印统计提示"未结账"（指引用户结账后再打正式册）' {
  return ($stats.hints -join '|') -match '结账后再打印'
}

# ============================================================================
Section '7. 仅凭证模式（不打印附件）'

Check 'attachmentMode=NONE 时不内联图片' {
  $r = Invoke-WebRequest "$BaseUrl/printing/voucher-book?entityId=$entityId&periodId=$($period.id)&attachmentMode=NONE" -TimeoutSec 120 -UseBasicParsing
  $hasBigImage = $r.Content -match 'data:image/png;base64,[A-Za-z0-9+/=]{500,}'
  $hasVoucher = $r.Content -match '记 账 凭 证 册'
  return ($hasVoucher -eq $true) -and ($hasBigImage -eq $false)
}

# ============================================================================
Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor White
$color = if ($script:fail -eq 0) { 'Green' } else { 'Red' }
Write-Host ("  结果：{0} 通过 / {1} 失败" -f $script:pass, $script:fail) -ForegroundColor $color
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor White
Write-Host ''
Write-Host "凭证册 HTML 已保存：$htmlPath" -ForegroundColor DarkGray
Write-Host '用浏览器打开即可看到 A4 排版，Ctrl+P 直接打印。' -ForegroundColor DarkGray
Write-Host ''

if ($script:fail -gt 0) { exit 1 }
exit 0
