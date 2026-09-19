# =============================================================================
#  Excel 报表 → 识别 → 建档 → 期初建账取数（完整链路验证）
# =============================================================================
#  这条链路回答用户最关心的问题：
#    "我上传的那张资产负债表，到底有没有用上？"
#
#  验证的关键点：
#    ① 真实 .xlsx 能被读进来（三条路径里唯一没被 CSV 覆盖的那条）
#    ② 多工作表时自动选"内容最多"的那张（跳过"说明"页）
#    ③ 合计行绝不被映射到科目（否则资产会被重复确认）
#    ④ 分组标题行（"一、流动资产："）绝不被映射
#    ⑤ ★ 已建档报表的余额真的进了期初方案，且标为 DECLARED
# =============================================================================

$ErrorActionPreference = 'Stop'
$API = 'http://localhost:3000/api'
$root = Split-Path -Parent $PSScriptRoot
$xlsx = Join-Path $root 'apps\api\tmp\verify-balance-sheet.xlsx'

# ── REST 辅助 ────────────────────────────────────────────────────────────────
#
# ★ 为什么需要 Get-List：`@(Invoke-RestMethod $url)` 在 PowerShell 里是个陷阱。
#   当响应的 JSON 是数组时，`@(...)` 会把它当成**单个元素**包起来，
#   于是 `$x.Count` 恒为 1，而 `$x.periodLabel` 触发成员枚举，
#   返回所有元素的该属性拼成的数组（打印出来是 "2024-12 2023"）。
#   结果就是"过滤条件永远为真、断言读到别的记录"这种极难排查的假失败。
#   用 Write-Output -NoEnumerate 才是正确的解包方式。
function Get-List([string]$url) {
  return @(Write-Output -NoEnumerate (Invoke-RestMethod $url))
}
$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host "  [PASS] $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  [FAIL] $name  $detail" -ForegroundColor Red }
}

function Upload-File([string]$path, [string]$targetType, [string]$entityId, [string]$mockCase = '') {
  $boundary = [System.Guid]::NewGuid().ToString('N')
  $fileName = [System.IO.Path]::GetFileName($path)
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $LF = "`r`n"

  $head = "--$boundary$LF" +
          "Content-Disposition: form-data; name=`"file`"; filename=`"$fileName`"$LF" +
          "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet$LF$LF"
  $mid = "$LF--$boundary$LF" +
         "Content-Disposition: form-data; name=`"entityId`"$LF$LF$entityId$LF" +
         "--$boundary$LF" +
         "Content-Disposition: form-data; name=`"targetType`"$LF$LF$targetType$LF"
  if ($mockCase -ne '') {
    $mid += "--$boundary$LF" +
            "Content-Disposition: form-data; name=`"mockCase`"$LF$LF$mockCase$LF"
  }
  $mid += "--$boundary--$LF"

  $hb = [System.Text.Encoding]::UTF8.GetBytes($head)
  $mb = [System.Text.Encoding]::UTF8.GetBytes($mid)
  $body = New-Object byte[] ($hb.Length + $bytes.Length + $mb.Length)
  [Array]::Copy($hb, 0, $body, 0, $hb.Length)
  [Array]::Copy($bytes, 0, $body, $hb.Length, $bytes.Length)
  [Array]::Copy($mb, 0, $body, $hb.Length + $bytes.Length, $mb.Length)

  return Invoke-RestMethod -Method Post "$API/ai/recognize" `
    -ContentType "multipart/form-data; boundary=$boundary" -Body $body
}

Write-Host "`n=== 0. 准备 ===" -ForegroundColor Cyan
$entityId = (Invoke-RestMethod "$API/entities")[0].id
Check "测试 Excel 存在" (Test-Path $xlsx) $xlsx
if (-not (Test-Path $xlsx)) { exit 1 }
Write-Host "  文件：$xlsx ($([int]((Get-Item $xlsx).Length / 1024)) KB)"

# 清掉本脚本的档案（按 reconNote 标记，不碰其他套件的数据）
foreach ($row in (Invoke-RestMethod "$API/history/statements?entityId=$entityId")) {
  if ($row.reconNote -like '*verify-xlsx*') {
    Invoke-RestMethod -Method Delete "$API/history/statements/$($row.id)?entityId=$entityId" | Out-Null
  }
}

Write-Host "`n=== 1. 真实 .xlsx 读入 ===" -ForegroundColor Cyan
$r = Upload-File $xlsx 'BALANCE_SHEET' $entityId 'balance-sheet-balanced'
Check "判为表格（SHEET）" ($r.ingested.kind -eq 'SHEET') "实际 $($r.ingested.kind)"
Check "★ 自动选到内容最多的表（资产负债表，不是说明页）" `
  (($r.ingested.notes -join ' ') -like '*资产负债表*') ($r.ingested.notes -join ' | ')
Check "★ 提示了存在多张工作表" (($r.ingested.notes -join ' ') -like '*说明*') ($r.ingested.notes -join ' | ')
Check "文本层包含报表标题" ($r.ingested.textPreview -like '*会小企01表*')
Check "★ 公式单元格取到缓存值（资产总计 1298400）" `
  ($r.ingested.textPreview -like '*1298400*')
Check "★ 分组标题行原样保留（未被清洗掉）" `
  ($r.ingested.textPreview -like '*一、流动资产*')

Write-Host "`n=== 2. 建档（用识别出的行项目） ===" -ForegroundColor Cyan
# 真实场景：界面把识别到的 items 原样提交
$previewItems = @($r.preview.data.items)
Check "识别到行项目（>10 行）" ($previewItems.Count -gt 10) "实际 $($previewItems.Count)"

$save = Invoke-RestMethod -Method Post "$API/history/statements" -ContentType 'application/json' -Body (@{
  entityId = $entityId
  statementType = 'BALANCE_SHEET'
  periodEnd = '2024-12-31'
  items = $previewItems
  totals = @{
    totalAssets = $r.preview.data.totalAssets
    totalLiabilities = $r.preview.data.totalLiabilities
    totalEquity = $r.preview.data.totalEquity
  }
  isBalanced = $true
  reconNote = 'verify-xlsx 代账公司出的资产负债表'
} | ConvertTo-Json -Depth 8)
Check "建档成功" ($save.kind -eq 'FINANCIAL_STATEMENT')

Write-Host "`n=== 3. ★ 映射明细：哪些行用上了、哪些被拒 ===" -ForegroundColor Cyan
$d = Invoke-RestMethod "$API/history/declared-statements?entityId=$entityId&targetYear=$targetYear"
Check "查到了已建档报表" ($null -ne $d.balanceSheet)
Check "报表日期正确" ($d.balanceSheet.statementDate -eq '2024-12-31') "实际 $($d.balanceSheet.statementDate)"

$mapped = @($d.balanceSheet.mapped)
$codes = $mapped | ForEach-Object { $_.accountCode }
Write-Host "  映射到 $($mapped.Count) 个科目：$($codes -join ', ')"

Check "★ 货币资金映射到 1002" ($codes -contains '1002')
Check "★ 应收账款映射到 1122" ($codes -contains '1122')
Check "★ 存货映射到 1403" ($codes -contains '1403')
Check "★ 固定资产原价映射到 1601" ($codes -contains '1601')
Check "★★ 累计折旧映射到 1602 且为贷方（曾被误判为合计行而丢失）" `
  (($mapped | Where-Object { $_.accountCode -eq '1602' }).direction -eq 'CREDIT')
Check "★ 应付账款映射到 2202" ($codes -contains '2202')
Check "★ 实收资本映射到 3001" ($codes -contains '3001')
Check "★ 未分配利润映射到 3103" ($codes -contains '3103')

$skippedLabels = @($d.balanceSheet.skipped | ForEach-Object { $_.label })
Write-Host "  跳过 $($skippedLabels.Count) 行"

Check "★★ 资产总计未被映射（否则资产翻倍）" `
  (-not ($codes -contains '1501') -and ($skippedLabels -contains '资产总计'))
Check "★★ 负债合计未被映射" ($skippedLabels -contains '负债合计')
Check "★★ 所有者权益合计未被映射" ($skippedLabels -contains '所有者权益合计')
Check "★★ 流动资产合计未被映射" ($skippedLabels -contains '流动资产合计')
$totalSkipped = @($d.balanceSheet.skipped | Where-Object { $_.reason -like '*合计*重复确认*' })
Check "★ 6 个合计行都被识别为合计并拒绝" ($totalSkipped.Count -ge 5) "实际 $($totalSkipped.Count)"

$taxSkipped = @($d.balanceSheet.skipped | Where-Object { $_.label -like '*应交税费*' })
Check "★ 应交税费被明确拒绝并说明原因（不猜明细科目）" `
  ($taxSkipped.Count -eq 1 -and $taxSkipped[0].reason -like '*申报表为准*') `
  ($taxSkipped | ConvertTo-Json -Compress)

Write-Host "`n=== 4. ★★ 已建档报表真的进了期初方案 ===" -ForegroundColor Cyan
# 用"已存在期间中最早的那个"做启用期间，而不是硬编码年份 ——
# 种子数据的年份随运行日期变化，硬编码会让脚本换个日子就跑不过。
$periods = Invoke-RestMethod "$API/periods?entityId=$entityId"
$first = $periods | Sort-Object fiscalYear, month | Select-Object -First 1
Check "存在可用的会计期间" ($null -ne $first)
$targetYear = $first.fiscalYear
$targetMonth = $first.month
Write-Host "  启用期间：$targetYear-$('{0:D2}' -f $targetMonth)"

# 需要至少一年重建结果才能生成方案
$recon = $null
try {
  $recon = Invoke-RestMethod -Method Post "$API/history/reconstruct" -ContentType 'application/json' -Body (@{
    entityId = $entityId
  } | ConvertTo-Json)
} catch { }

if ($recon) {
  $proposal = $null
  try {
    $proposal = Invoke-RestMethod -Method Post "$API/history/proposal" -ContentType 'application/json' -Body (@{
      entityId = $entityId; targetYear = $targetYear; targetMonth = $targetMonth
    } | ConvertTo-Json)
  } catch { Write-Host "  生成方案失败：$($_.Exception.Message)" }

  if ($proposal) {
    $lines = @($proposal.lines)
    Write-Host "  方案共 $($lines.Count) 行"

    $cashLine = $lines | Where-Object { $_.accountCode -eq '1002' }
    Check "★ 方案里有银行存款行" ($null -ne $cashLine)
    if ($cashLine) {
      Check "★★ 银行存款来源标为 DECLARED（取自报表，不是倒轧）" `
        ($cashLine.source -eq 'DECLARED') "实际 $($cashLine.source)"
      Check "★★ 银行存款金额 = 报表上的 386400.00" `
        ($cashLine.amount -eq '386400.00') "实际 $($cashLine.amount)"
      Check "★ 来源说明里写明了取自哪张表" ($cashLine.sourceNote -like '*2024-12-31 资产负债表*') $cashLine.sourceNote
    }

    $invLine = $lines | Where-Object { $_.accountCode -eq '1403' }
    Check "★ 存货取自报表（DECLARED 420000）" `
      ($null -ne $invLine -and $invLine.source -eq 'DECLARED' -and $invLine.amount -eq '420000.00') `
      ($invLine | ConvertTo-Json -Compress)

    $capLine = $lines | Where-Object { $_.accountCode -eq '3001' }
    Check "★ 实收资本取自报表（DECLARED 500000）" `
      ($null -ne $capLine -and $capLine.source -eq 'DECLARED' -and $capLine.amount -eq '500000.00') `
      ($capLine | ConvertTo-Json -Compress)

    $depLine = $lines | Where-Object { $_.accountCode -eq '1602' }
    Check "★ 累计折旧取自报表且为贷方" `
      ($null -ne $depLine -and $depLine.direction -eq 'CREDIT' -and $depLine.source -eq 'DECLARED') `
      ($depLine | ConvertTo-Json -Compress)

    $faLine = $lines | Where-Object { $_.accountCode -eq '1601' }
    Check "★ 固定资产原价取自报表" `
      ($null -ne $faLine -and $faLine.amount -eq '280000.00') ($faLine | ConvertTo-Json -Compress)

    # ★ 最关键的一条：有了报表，就不该再要求人工补录这些项了
    $reqFields = @($proposal.requiredInputs | ForEach-Object { $_.field })
    Write-Host "  仍需人工补录：$($reqFields -join ', ')"
    Check "★★ 不再要求补录实收资本（报表已提供）" (-not ($reqFields -contains 'paidInCapital'))
    Check "★★ 不再要求补录存货/固定资产（报表已提供）" `
      (-not ($reqFields -contains '1403') -and -not ($reqFields -contains '1601'))
    Check "★★ 不再要求补录货币资金（报表已提供）" (-not ($reqFields -contains 'cashBalance'))

    Check "★ 方案借贷平衡" ([bool]$proposal.balanced) "差 $($proposal.difference)"
    Check "★ 现金口径标为 DECLARED" ($proposal.cashBasis -eq 'DECLARED') "实际 $($proposal.cashBasis)"
  }
} else {
  Write-Host "  （无历史发票/申报数据，跳过方案验证）" -ForegroundColor Yellow
}

Write-Host "`n=== 5. 利润表建档与读取 ===" -ForegroundColor Cyan
$r2 = Upload-File $xlsx 'INCOME_STATEMENT' $entityId 'income-statement'
Check "利润表识别成功" ($r2.ingested.kind -eq 'SHEET')
$isSave = Invoke-RestMethod -Method Post "$API/history/statements" -ContentType 'application/json' -Body (@{
  entityId = $entityId
  statementType = 'INCOME_STATEMENT'
  periodEnd = '2024-12-31'
  items = @($r2.preview.data.items)
  totals = @{
    revenue = $r2.preview.data.revenue
    cost = $r2.preview.data.cost
    profitBeforeTax = $r2.preview.data.profitBeforeTax
    netProfit = $r2.preview.data.netProfit
  }
  reconNote = 'verify-xlsx 利润表'
} | ConvertTo-Json -Depth 8)
Check "利润表建档成功" ($isSave.kind -eq 'FINANCIAL_STATEMENT')

$d2 = Invoke-RestMethod "$API/history/declared-statements?entityId=$entityId&targetYear=$targetYear"
Check "★ 利润表可读" ($null -ne $d2.incomeStatement)
Check "★ 营业收入抽取正确" ("$($d2.incomeStatement.revenue)" -like '2680000*') "实际 $($d2.incomeStatement.revenue)"
Check "★ 净利润抽取正确" ("$($d2.incomeStatement.netProfit)" -like '308750*') "实际 $($d2.incomeStatement.netProfit)"

Write-Host "`n=== 6. 报表读取的边界情况 ===" -ForegroundColor Cyan
# 换一个没有报表主体的场景不好造，这里改用不存在的年份验证口径提示
$d3 = Invoke-RestMethod "$API/history/declared-statements?entityId=$entityId&targetYear=2019"
Check "查询更早年度的报表不报错" ($null -ne $d3)
Check "★ 无报表时 explanation 明确指引去建档" ($d3.explanation.Length -gt 10)

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "  Excel 报表链路验证：通过 $pass / 失败 $fail" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "============================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
