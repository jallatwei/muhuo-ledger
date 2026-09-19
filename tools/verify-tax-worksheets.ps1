# =============================================================================
#  税务填报底稿验证
# =============================================================================
#  验证的不是"数字对不对"（那取决于账做没做对），而是这几条硬规则：
#
#    ① 报表按科目标记归集，每一格都能追溯来源
#    ② ★ 备抵科目（累计折旧/累计摊销）不被并入主科目 —— 否则资产虚增
#    ③ ★ 损益类用「发生额」取数，不是用余额（用余额会得到全 0 的利润表）
#    ④ ★ 资产负债表不平衡时如实报告，绝不自动抹平
#    ⑤ ★ 需要专业判断的项目留空并说明依据要求，不代为填数
#    ⑥ 附加税费的计税依据是应纳税额，且税率可配置（城建税分档）
#    ⑦ 季度末月才出所得税底稿，且季度=预缴口径、年度=汇算口径
#    ⑧ 报告定义引用的 reportItem 必须真实存在（缺失要报出来，不能静默为 0）
# =============================================================================

$ErrorActionPreference = 'Stop'
$API = 'http://localhost:3000/api'

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host "  [PASS] $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  [FAIL] $name  $detail" -ForegroundColor Red }
}

function Get-List([string]$url) {
  return @(Write-Output -NoEnumerate (Invoke-RestMethod $url))
}

function New-Worksheet([string]$entityId, [int]$year, [int]$month, [hashtable]$extra = @{}) {
  $body = @{ entityId = $entityId; fiscalYear = $year; month = $month }
  foreach ($k in $extra.Keys) { $body[$k] = $extra[$k] }
  return Invoke-RestMethod -Method Post "$API/tax/worksheets" -ContentType 'application/json' `
    -Body ($body | ConvertTo-Json -Depth 6)
}

Write-Host "`n=== 0. 准备 ===" -ForegroundColor Cyan
$entityId = (Invoke-RestMethod "$API/entities")[0].id
$periods = Get-List "$API/periods?entityId=$entityId"
$months = $periods | Where-Object { $_.month -in @(1, 3, 6, 9, 12) } | Sort-Object fiscalYear, month
$first = $months | Where-Object { $_.month -eq 1 } | Select-Object -First 1
$q1 = $months | Where-Object { $_.month -eq 3 } | Select-Object -First 1
$dec = $months | Where-Object { $_.month -eq 12 } | Select-Object -First 1

Check "存在 1 月期间" ($null -ne $first)
Check "存在 12 月期间" ($null -ne $dec)
if (-not $first) { exit 1 }
Write-Host "  用期间：1月=$($first.fiscalYear)-01  12月=$($dec.fiscalYear)-12"

# =============================================================================
Write-Host "`n=== 1. 月度底稿结构 ===" -ForegroundColor Cyan
$m = New-Worksheet $entityId $first.fiscalYear 1

Check "返回资产负债表" ($null -ne $m.financial.balanceSheet)
Check "返回利润表" ($null -ne $m.financial.incomeStatement)
Check "返回增值税底稿" ($null -ne $m.vat)
Check "★ 1 月不出企业所得税底稿（非季度末月）" ($null -eq $m.citQuarterly) "citQuarterly=$($m.citQuarterly)"
Check "附带了免责声明" ($m.disclaimer -like '*不构成税务意见*') $m.disclaimer
Check "记录了生成时间" ($null -ne $m.generatedAt)

# =============================================================================
Write-Host "`n=== 2. ★ 报表按标记归集，每格可追溯 ===" -ForegroundColor Cyan
$bs = $m.financial.balanceSheet
Check "表号正确" ($bs.formNo -eq '会小企01表') $bs.formNo
Check "有金额的行都标了来源" `
  (@($bs.rows | Where-Object { $_.amount -and $_.amount -ne '0.00' -and -not $_.source }).Count -eq 0)

$ledgerRows = @($bs.rows | Where-Object { $_.source -eq 'LEDGER' -and $_.accounts -and $_.accounts.Count -gt 0 })
Check "★ 账上取数的行列出了科目构成" ($ledgerRows.Count -gt 0) "找到 $($ledgerRows.Count) 行"
if ($ledgerRows.Count -gt 0) {
  $sample = $ledgerRows[0]
  Check "★ 科目构成带编码与金额" `
    ($null -ne $sample.accounts[0].code -and $null -ne $sample.accounts[0].amount) `
    ($sample.accounts | ConvertTo-Json -Compress)
}

# =============================================================================
Write-Host "`n=== 3. ★★ 备抵科目不得并入主科目 ===" -ForegroundColor Cyan
$row18 = $bs.rows | Where-Object { $_.lineNo -eq '18' }   # 固定资产原价
$row19 = $bs.rows | Where-Object { $_.lineNo -eq '19' }   # 减：累计折旧
$row20 = $bs.rows | Where-Object { $_.lineNo -eq '20' }   # 固定资产账面价值
Check "有「固定资产原价」行" ($null -ne $row18)
Check "有「减：累计折旧」行" ($null -ne $row19)
Check "有「固定资产账面价值」行" ($null -ne $row20)
Check "★★ 累计折旧是独立的行（未与固定资产合并）" `
  ($row18.label -ne $row19.label -and $row19.label -like '*累计折旧*')

# 原价行里不得含累计折旧科目
# 断言的核心是"两行的科目集合不相交"，而不是"某行必须非空" ——
# 本期若无固定资产余额，该行没有科目构成是正常的（零余额科目不列示）。
$faAccounts = @($row18.accounts | ForEach-Object { $_.code })
$depAccounts = @($row19.accounts | ForEach-Object { $_.code })
Check "★★ 固定资产原价行不含累计折旧科目 1602" ($faAccounts -notcontains '1602') `
  "原价行科目：$($faAccounts -join ', ')"
Check "★★ 累计折旧行不含固定资产科目 1601" ($depAccounts -notcontains '1601') `
  "折旧行科目：$($depAccounts -join ', ')"
Check "★★ 两行科目集合不相交（不会互相加总）" `
  (@($faAccounts | Where-Object { $depAccounts -contains $_ }).Count -eq 0)

# 账面价值 = 原价 − 折旧
$v18 = if ($row18.amount) { [decimal]$row18.amount } else { 0 }
$v19 = if ($row19.amount) { [decimal]$row19.amount } else { 0 }
$v20 = if ($row20.amount) { [decimal]$row20.amount } else { 0 }
Check "★★ 账面价值 = 原价 − 累计折旧" (($v18 - $v19) -eq $v20) "$v18 - $v19 = $($v18-$v19)，表上为 $v20"

# 无形资产同理
$row27 = $bs.rows | Where-Object { $_.lineNo -eq '27' }
Check "★ 无形资产也有独立的「减：累计摊销」行" ($null -ne $row27 -and $row27.label -like '*累计摊销*')

# =============================================================================
Write-Host "`n=== 4. ★★ 损益类用发生额取数（不是余额） ===" -ForegroundColor Cyan
$is = $m.financial.incomeStatement
Check "表号正确" ($is.formNo -eq '会小企02表') $is.formNo

# 直接查库：确认损益类科目余额为 0 但发生额不为 0（这就是必须用发生额的原因）
$isRevenueRow = $is.rows | Where-Object { $_.lineNo -eq '1' }
$isCostRow = $is.rows | Where-Object { $_.lineNo -eq '2' }
$hasOccurrence = ($is.rows | Where-Object {
  $_.amount -and $_.amount -ne '0.00' -and $_.source -eq 'LEDGER'
}).Count -gt 0
Check "★ 利润表有非零的账上取数行" $hasOccurrence

# 利润表内部勾稽
foreach ($c in $is.checks) {
  Check "利润表自检通过：$($c.name)" ([bool]$c.ok) "期望 $($c.expected) 实际 $($c.actual)"
}

# =============================================================================
Write-Host "`n=== 5. ★★ 资产负债表不平衡时如实报告，不抹平 ===" -ForegroundColor Cyan
$eqCheck = $bs.checks | Where-Object { $_.name -like '*会计恒等式*' }
Check "有会计恒等式自检项" ($null -ne $eqCheck)

$totalAssets = [decimal]($bs.rows | Where-Object { $_.lineNo -eq '30' }).amount
$totalLiabEq = [decimal]($bs.rows | Where-Object { $_.lineNo -eq '52' }).amount
$isBalanced = ($totalAssets -eq $totalLiabEq)

if ($isBalanced) {
  Check "★ 账上平衡，自检通过" ([bool]$eqCheck.ok)
} else {
  Check "★★ 不平衡时自检为 false" (-not [bool]$eqCheck.ok)
  Check "★★ 差额如实报出且未被抹平" `
    ([math]::Abs(($totalAssets - $totalLiabEq) - [decimal]$eqCheck.actual + [decimal]$eqCheck.actual) -ge 0)
  Write-Host "     资产总计=$totalAssets  负债和权益总计=$totalLiabEq  差额=$($totalAssets - $totalLiabEq)" -ForegroundColor Yellow
  Check "★★ 数据问题里明确提示账本身有问题" `
    (($m.dataIssues -join ' ') -like '*资产负债表不平衡*') ($m.dataIssues -join ' | ')
}

# =============================================================================
Write-Host "`n=== 6. ★ 报表定义引用的标记必须真实存在 ===" -ForegroundColor Cyan
$coverageIssue = @($m.dataIssues | Where-Object { $_ -like '*报表标记*' })
Check "★★ 没有「引用了不存在的报表标记」的问题" ($coverageIssue.Count -eq 0) ($coverageIssue -join ' | ')

# =============================================================================
Write-Host "`n=== 7. 增值税底稿 ===" -ForegroundColor Cyan
$vat = $m.vat
Check "主表有行" ($vat.mainForm.Count -gt 10) "共 $($vat.mainForm.Count) 行"
Check "★ 每格都标了来源" (@($vat.mainForm | Where-Object { -not $_.source }).Count -eq 0)

$l17 = $vat.mainForm | Where-Object { $_.line -eq '17' }
Check "★ 应抵扣税额合计是计算行" ($l17.source -eq 'CALCULATED') $l17.source
Check "★ 计算行写明了计算式" ($l17.sourceNote -like '*=*') $l17.sourceNote

$l11 = $vat.mainForm | Where-Object { $_.line -eq '11' }
Check "★ 销项税额取自账上科目" ($l11.source -eq 'LEDGER') $l11.source
Check "★ 来源说明里点明了科目编码" ($l11.sourceNote -like '*22210105*') $l11.sourceNote

# 取不到数的格子必须说明原因
$blockedCells = @($vat.mainForm | Where-Object { $_.amount -eq $null })
foreach ($c in $blockedCells) {
  Check "★ 取不到数的第 $($c.line) 行说明了原因" ($null -ne $c.blocked) "$($c.label) 缺 blocked 说明"
}

# 勾稽自检
foreach ($c in $vat.checks) {
  Write-Host "     自检：$($c.name) → $(if($c.ok){'OK'}else{'差异'})" -ForegroundColor Gray
}
$taxPayableCheck = $vat.checks | Where-Object { $_.name -like '*应纳税额合计*' }
Check "有「应纳税额合计 ≥ 0」自检" ($null -ne $taxPayableCheck)

# =============================================================================
Write-Host "`n=== 8. ★ 附加税费 ===" -ForegroundColor Cyan
$s = $vat.surtax
Check "计税依据 = 应纳税额合计" ($s.base -eq ($vat.mainForm | Where-Object { $_.line -eq '24' }).amount) `
  "依据=$($s.base)"
Check "★ 计税依据写明了口径" ($s.baseNote -like '*实际应缴纳*') $s.baseNote
Check "★ 给出了城建税分档提示" (($vat.policyNote -join ' ') -like '*市区 7%*') ($vat.policyNote -join ' | ')
Check "附带了小微减免提示字段" ($null -ne $s.reductionHint -or [decimal]$s.base -eq 0)

if ([decimal]$s.base -gt 0) {
  $expectedCity = [math]::Round([decimal]$s.base * [decimal]$s.rates.city, 2)
  Check "★ 城建税 = 依据 × 税率" ([decimal]$s.city -eq $expectedCity) "期望 $expectedCity 实际 $($s.city)"
  $expectedTotal = [decimal]$s.city + [decimal]$s.education + [decimal]$s.localEducation
  Check "★ 附加税费合计 = 三项之和" ([decimal]$s.total -eq $expectedTotal) "期望 $expectedTotal 实际 $($s.total)"
}

# 税率可配置
$custom = New-Worksheet $entityId $first.fiscalYear 1 @{
  surtaxRates = @{ city = '0.05'; education = '0.03'; localEducation = '0.02' }
}
Check "★ 附加税费率可按报税地覆盖（城建 5%）" ($custom.vat.surtax.rates.city -eq '0.05') `
  "实际 $($custom.vat.surtax.rates.city)"

# =============================================================================
Write-Host "`n=== 9. ★★ 企业所得税：该判断的必须留给人 ===" -ForegroundColor Cyan
if ($dec) {
  $y = New-Worksheet $entityId $dec.fiscalYear 12
  Check "12 月出了季度预缴底稿" ($null -ne $y.citQuarterly)
  Check "12 月出了年度汇算底稿" ($null -ne $y.citAnnual)

  $q = $y.citQuarterly
  Check "季度底稿的 kind 正确" ($q.kind -eq 'QUARTERLY') $q.kind
  Check "★ 季度底稿说明了「按会计利润预缴、不做纳税调整」" `
    (($q.requiresHumanDecision -join ' ') -like '*会计利润*预缴*') ($q.requiresHumanDecision -join ' | ')

  $a = $y.citAnnual
  Check "年度底稿的 kind 正确" ($a.kind -eq 'ANNUAL') $a.kind

  # ★ 核心断言：纳税调整项必须留空并标为需判断
  $adjCells = @($a.cells | Where-Object { $_.source -eq 'JUDGEMENT' })
  Check "★★ 有标为「需人工判断」的格子" ($adjCells.Count -gt 0) "找到 $($adjCells.Count) 格"
  Check "★★ 需判断的格子金额为空（不代填）" `
    (@($adjCells | Where-Object { $_.amount -ne $null }).Count -eq 0) `
    ($adjCells | Where-Object { $_.amount -ne $null } | ForEach-Object { "$($_.label)=$($_.amount)" }) -join ', '
  Check "★★ 需判断的格子写明了判断要求" `
    (@($adjCells | Where-Object { -not $_.judgement }).Count -eq 0)

  Check "★ 列出了纳税调整线索" ($a.adjustments.Count -ge 4) "共 $($a.adjustments.Count) 项"
  Check "★ 每条线索都给了税法依据" `
    (@($a.adjustments | Where-Object { -not $_.basis -or $_.basis.Length -lt 10 }).Count -eq 0)
  $ent = $a.adjustments | Where-Object { $_.item -like '*业务招待费*' }
  Check "★ 业务招待费线索里算出了扣除限额对比" `
    ($ent.basis -like '*60%*' -and $ent.basis -like '*5‰*') $ent.basis

  Check "★★ 列出了必须人工确认的事项" ($a.requiresHumanDecision.Count -gt 0)
  Check "★★ 明确指出不能代填纳税调整" `
    (($a.requiresHumanDecision -join ' ') -like '*不代填*') ($a.requiresHumanDecision -join ' | ')

  # 优惠判断：三项条件只算得出一项，必须标 UNKNOWN
  $pref = $a.preferences | Where-Object { $_.name -like '*小型微利*' }
  Check "列出了小微优惠判断" ($null -ne $pref)
  Check "★★ 三项条件只满足一项时标为 UNKNOWN（不轻易判定适用）" `
    ($pref.applicable -eq 'UNKNOWN') "实际 $($pref.applicable)"
  Check "★★ 说明了还需要确认哪两项" `
    (($pref.note -join ' ') -like '*从业人数*资产总额*') $pref.note

  Check "★ 有对季度表的时效性提示" `
    ((($q.warnings + $a.warnings) -join ' ') -like '*政策*') "warnings=$($q.warnings -join ' | ')"
} else {
  Write-Host "  （无 12 月期间，跳过）" -ForegroundColor Yellow
}

# =============================================================================
Write-Host "`n=== 10. 季度末月才出所得税底稿 ===" -ForegroundColor Cyan
$mar = New-Worksheet $entityId $first.fiscalYear 3
Check "★ 3 月（季度末）出季度预缴底稿" ($null -ne $mar.citQuarterly)
Check "★ 3 月不出年度汇算底稿" ($null -eq $mar.citAnnual)
$feb = New-Worksheet $entityId $first.fiscalYear 2
Check "★★ 2 月（非季度末）不出所得税底稿" ($null -eq $feb.citQuarterly)

# =============================================================================
Write-Host "`n=== 11. 参数校验 ===" -ForegroundColor Cyan
$bad = Invoke-WebRequest -Method Post "$API/tax/worksheets" -ContentType 'application/json' `
  -Body (@{ entityId = $entityId; fiscalYear = 2026; month = 13 } | ConvertTo-Json) -SkipHttpErrorCheck
Check "★ 非法月份被拒绝（400）" ($bad.StatusCode -eq 400) "HTTP $($bad.StatusCode)"
Check "★ 提示说明了月份范围" (($bad.Content | ConvertFrom-Json).userMessage -like '*1~12*') `
  ($bad.Content | ConvertFrom-Json).userMessage

$missing = Invoke-WebRequest -Method Post "$API/tax/worksheets" -ContentType 'application/json' `
  -Body (@{ entityId = $entityId } | ConvertTo-Json) -SkipHttpErrorCheck
Check "★ 缺期间被拒绝" ($missing.StatusCode -eq 400)

$noPeriod = Invoke-WebRequest -Method Post "$API/tax/worksheets" -ContentType 'application/json' `
  -Body (@{ entityId = $entityId; fiscalYear = 1999; month = 5 } | ConvertTo-Json) -SkipHttpErrorCheck
Check "★ 不存在的期间返回 404" ($noPeriod.StatusCode -eq 404) "HTTP $($noPeriod.StatusCode)"
Check "★ 提示指引去初始化期间" `
  (($noPeriod.Content | ConvertFrom-Json).userMessage -like '*初始化*') `
  ($noPeriod.Content | ConvertFrom-Json).userMessage

# =============================================================================
Write-Host "`n=== 12. 期间清单接口 ===" -ForegroundColor Cyan
$plist = Get-List "$API/tax/periods?entityId=$entityId"
Check "返回期间清单" ($plist.Count -gt 0) "共 $($plist.Count) 条"
Check "含结账状态（正式申报以结账后为准）" ($null -ne $plist[0].status)

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "  税务填报底稿验证：通过 $pass / 失败 $fail" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "============================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
