# =============================================================================
#  识别录入验证：报表 / 申报表（含真实 Excel / CSV 文件上传）
# =============================================================================
#  验证的不是"模型看不看得懂"，而是这几条硬规则：
#    ① 报表文件能被正确读进来（Excel 逐单元格、CSV 带引号转义）
#    ② 报表不平衡时系统**只报告、不修正**
#    ③ 报表只建档，绝不产生凭证
#    ④ 同一份报表重复上传是覆盖而不是新增
#    ⑤ 发票路径的校验依然工作
# =============================================================================

$ErrorActionPreference = 'Stop'
$API = 'http://localhost:3000/api'

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

Write-Host "`n=== 0. 准备 ===" -ForegroundColor Cyan
$entities = Invoke-RestMethod "$API/entities"
$entityId = $entities[0].id
Check "取到主体" ($null -ne $entityId) "entityId=$entityId"
Write-Host "  主体：$($entities[0].name)  ($entityId)"

# ★ 本脚本刻意使用 2024-11-30（另一个套件 verify-statement-flow 用 2024-12-31）：
#   报表档案的唯一键是「主体+类型+报表日期」，两套脚本撞同一天会互相覆盖，
#   导致"标记为新建"这类断言变成假失败。各套件用自己的日期，才能独立重复运行。
#
# 先清掉本脚本可能留下的旧档案，保证断言可重复
$existing = Invoke-RestMethod "$API/history/statements?entityId=$entityId"
foreach ($row in $existing) {
  if ($row.reconNote -like '*verify-recognition*') {
    Invoke-RestMethod -Method Delete "$API/history/statements/$($row.id)?entityId=$entityId" | Out-Null
  }
}
$existingFilings = Invoke-RestMethod "$API/history/filings?entityId=$entityId"
foreach ($row in $existingFilings) {
  if ($row.reconNote -like '*verify-recognition*') {
    Invoke-RestMethod -Method Delete "$API/history/filings/$($row.id)?entityId=$entityId" | Out-Null
  }
}
Write-Host "  已清理旧测试档案"

# ── 生成测试用 Excel 报表（平衡的资产负债表）─────────────────────────────
$tmp = Join-Path $env:TEMP 'bk-verify'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$bsCsv = Join-Path $tmp 'balance-sheet.csv'
$vatCsv = Join-Path $tmp 'vat-return.txt'
$badCsv = Join-Path $tmp 'balance-sheet-unbalanced.csv'

# ★ 故意使用带引号、带逗号的科目名，验证 CSV 引号转义
@'
资产负债表
会小企01表
编制单位：测试科技有限公司,2024年12月31日,单位：元
项目,行次,期末余额,年初余额
货币资金,1,386400.00,298000.00
应收账款,4,"215,000.00",186000.00
存货,9,420000.00,365000.00
流动资产合计,15,1021400.00,849000.00
固定资产原价,20,280000.00,260000.00
减：累计折旧,21,63000.00,47000.00
固定资产账面价值,22,217000.00,213000.00
资产总计,30,1238400.00,1062000.00
应付账款,33,168900.00,142000.00
应交税费,36,52000.00,41000.00
应付职工薪酬,37,86000.00,78000.00
流动负债合计,41,306900.00,261000.00
长期借款,43,50000.00,60000.00
负债合计,47,356900.00,321000.00
实收资本,48,500000.00,500000.00
未分配利润,51,381500.00,241000.00
所有者权益合计,52,881500.00,741000.00
负债和所有者权益总计,53,1238400.00,1062000.00
'@ | Set-Content -Path $bsCsv -Encoding UTF8

# ★ 故意不平衡：负债+权益侧少 120000
@'
资产负债表
项目,行次,期末余额,年初余额
货币资金,1,298000.00,265000.00
存货,9,365000.00,330000.00
资产总计,30,1062000.00,985000.00
负债合计,47,321000.00,298000.00
所有者权益合计,52,621000.00,567000.00
负债和所有者权益总计,53,942000.00,865000.00
'@ | Set-Content -Path $badCsv -Encoding UTF8

# 制表符分隔的申报表导出（税局系统常见格式）
$vatLines = @(
  "增值税纳税申报表（一般纳税人适用）",
  "税款所属期`t2024-12-01`t至`t2024-12-31",
  "行次`t项目`t一般项目本月数",
  "1`t按适用税率计税销售额`t412000.00",
  "11`t销项税额`t53560.00",
  "12`t进项税额`t38600.00",
  "13`t上期留抵税额`t0.00",
  "17`t应抵扣税额合计`t38600.00",
  "18`t实际抵扣税额`t38600.00",
  "19`t应纳税额`t14960.00",
  "20`t期末留抵税额`t0.00",
  "24`t应纳税额合计`t14960.00",
  "25`t期初未缴税额`t0.00",
  "27`t本期已缴税额`t0.00",
  "32`t期末未缴税额`t14960.00",
  "34`t本期应补(退)税额`t14960.00"
)
$vatLines | Set-Content -Path $vatCsv -Encoding UTF8

Write-Host "  已生成 3 个测试文件：$tmp"

# ── multipart 上传辅助 ────────────────────────────────────────────────────
function Upload-File([string]$path, [string]$targetType, [string]$entityId, [string]$mockCase = '') {
  $boundary = [System.Guid]::NewGuid().ToString('N')
  $fileName = [System.IO.Path]::GetFileName($path)
  $bytes = [System.IO.File]::ReadAllBytes($path)

  $LF = "`r`n"
  $head = "--$boundary$LF" +
          "Content-Disposition: form-data; name=`"file`"; filename=`"$fileName`"$LF" +
          "Content-Type: application/octet-stream$LF$LF"
  $mid = "$LF--$boundary$LF" +
         "Content-Disposition: form-data; name=`"entityId`"$LF$LF$entityId$LF" +
         "--$boundary$LF" +
         "Content-Disposition: form-data; name=`"targetType`"$LF$LF$targetType$LF"
  if ($mockCase -ne '') {
    $mid += "--$boundary$LF" +
            "Content-Disposition: form-data; name=`"mockCase`"$LF$LF$mockCase$LF"
  }
  $mid += "--$boundary--$LF"

  $headBytes = [System.Text.Encoding]::UTF8.GetBytes($head)
  $midBytes = [System.Text.Encoding]::UTF8.GetBytes($mid)
  $body = New-Object byte[] ($headBytes.Length + $bytes.Length + $midBytes.Length)
  [Array]::Copy($headBytes, 0, $body, 0, $headBytes.Length)
  [Array]::Copy($bytes, 0, $body, $headBytes.Length, $bytes.Length)
  [Array]::Copy($midBytes, 0, $body, $headBytes.Length + $bytes.Length, $midBytes.Length)

  return Invoke-RestMethod -Method Post "$API/ai/recognize" `
    -ContentType "multipart/form-data; boundary=$boundary" -Body $body
}

# =============================================================================
Write-Host "`n=== 1. 识别目标清单 ===" -ForegroundColor Cyan
$targets = Invoke-RestMethod "$API/ai/targets"
Check "返回 6 类识别目标" ($targets.targets.Count -eq 6) "实际 $($targets.targets.Count)"
Check "含资产负债表" (($targets.targets | Where-Object { $_.value -eq 'BALANCE_SHEET' }).Count -eq 1)
Check "含纳税申报表" (($targets.targets | Where-Object { $_.value -eq 'TAX_RETURN' }).Count -eq 1)
Check "报表类目标被标为 group=报表" `
  ((($targets.targets | Where-Object { $_.value -in @('BALANCE_SHEET','INCOME_STATEMENT','TAX_RETURN') }) |
    Where-Object { $_.group -ne '报表' }).Count -eq 0)

# =============================================================================
Write-Host "`n=== 2. 上传 CSV 资产负债表 → 应识别为表格且精确读取 ===" -ForegroundColor Cyan
$r1 = Upload-File $bsCsv 'BALANCE_SHEET' $entityId
Check "文件被判为表格（SHEET）" ($r1.ingested.kind -eq 'SHEET') "实际 $($r1.ingested.kind)"
Check "读取到文本层（>100 字）" ($r1.ingested.textChars -gt 100) "实际 $($r1.ingested.textChars)"
Check "文本层保留了原表内容" ($r1.ingested.textPreview -like '*资产负债表*')
Check "★ CSV 引号转义正确：带引号的 215,000.00 完整落在一个单元格里" `
  ($r1.ingested.textPreview -like '*应收账款 | 4 | 215,000.00 | 186000.00*') `
  '（若引号解析错了，会被拆成 "215 与 000.00" 两列）'

# =============================================================================
Write-Host "`n=== 3. 上传制表符分隔的增值税申报表 ===" -ForegroundColor Cyan
# ★ Mock 模式按内容哈希挑样例，所以要显式指定 —— 否则断言随文件内容漂移。
#   真实模型模式下 mockCase 会被当成普通文本忽略，不影响生产行为。
$r2 = Upload-File $vatCsv 'TAX_RETURN' $entityId 'vat-return-main'
Check "文件被判为表格" ($r2.ingested.kind -eq 'SHEET') "实际 $($r2.ingested.kind)"
Check "★ 识别到制表符分隔符（不再傻看首行）" (($r2.ingested.notes -join ' ') -like '*制表符*') ($r2.ingested.notes -join ' | ')
Check "抽取到销项税额" ($null -ne $r2.preview.data.line11OutputTax) "data=$($r2.preview.data | ConvertTo-Json -Compress)"
Check "报表类 routing 为空（不产生凭证）" ($null -eq $r2.routing)

# =============================================================================
Write-Host "`n=== 4. ★ 不平衡报表：只报告、不修正 ===" -ForegroundColor Cyan
Write-Host '  （文件读取走真实解析；抽取结果在 Mock 模式下由 mockCase 指定）'
$r3 = Upload-File $badCsv 'BALANCE_SHEET' $entityId 'balance-sheet-unbalanced'
$v3 = $r3.validation
Check "校验结论存在" ($null -ne $v3)
Check "★ 判定为不平衡" ($v3.balanced -eq $false) "balanced=$($v3.balanced)"
Check "★ 差额为 120000（未被抹平）" ($v3.balanceDifference -eq '120000') "实际 $($v3.balanceDifference)"
$balFinding = $v3.findings | Where-Object { $_.code -like 'P*' -and $_.level -eq 'FAIL' }
Check "存在平衡类 FAIL 结论" ($null -ne $balFinding)
Check "结论里说明了差额" (($v3.findings | Where-Object { $_.message -like '*120000*' }).Count -gt 0)

# =============================================================================
Write-Host "`n=== 5. 建档：平衡的资产负债表 ===" -ForegroundColor Cyan
$save1 = Invoke-RestMethod -Method Post "$API/history/statements" -ContentType 'application/json' -Body (@{
  entityId = $entityId
  statementType = 'BALANCE_SHEET'
  periodEnd = '2024-11-30'
  items = @(
    @{ lineNo='1';  label='货币资金';   endBalance='386400.00';  beginBalance='298000.00' },
    @{ lineNo='4';  label='应收账款';   endBalance='215000.00';  beginBalance='186000.00' },
    @{ lineNo='9';  label='存货';       endBalance='420000.00';  beginBalance='365000.00' },
    @{ lineNo='30'; label='资产总计';   endBalance='1238400.00'; beginBalance='1062000.00' },
    @{ lineNo='47'; label='负债合计';   endBalance='356900.00';  beginBalance='321000.00' },
    @{ lineNo='52'; label='所有者权益合计'; endBalance='881500.00'; beginBalance='741000.00' }
  )
  totals = @{ totalAssets='1238400.00'; totalLiabilities='356900.00'; totalEquity='881500.00' }
  isBalanced = $true
  reconNote = 'verify-recognition 平衡样例'
} | ConvertTo-Json -Depth 6)
Check "建档成功" ($save1.kind -eq 'FINANCIAL_STATEMENT') "kind=$($save1.kind)"
Check "标记为新建" ($save1.created -eq $true)
Check "期间标签正确" ($save1.periodLabel -eq '2024-11-30') "实际 $($save1.periodLabel)"
Check "无告警" ($save1.warnings.Count -eq 0) ($save1.warnings -join ' | ')
$bsId = $save1.id

Write-Host "`n=== 6. ★ 幂等：同一份报表重复上传是覆盖不是新增 ===" -ForegroundColor Cyan
$save2 = Invoke-RestMethod -Method Post "$API/history/statements" -ContentType 'application/json' -Body (@{
  entityId = $entityId
  statementType = 'BALANCE_SHEET'
  periodEnd = '2024-11-30'
  items = @(@{ lineNo='30'; label='资产总计'; endBalance='1238400.00'; beginBalance='1062000.00' })
  totals = @{ totalAssets='1238400.00' }
  isBalanced = $true
  reconNote = 'verify-recognition 覆盖样例'
} | ConvertTo-Json -Depth 6)
Check "★ 判定为覆盖而非新增" ($save2.created -eq $false)
Check "★ 返回同一个档案 id" ($save2.id -eq $bsId) "旧=$bsId 新=$save2.id"

# ★ 两处坑，都踩过：
#   ① Invoke-RestMethod 会把 ISO 日期反序列化成 DateTime（显示成 2024/12/31），
#      必须显式格式化回 yyyy-MM-dd 再比较，否则断言假失败；
#   ② 用 Where-Object 时 $_ 会被绑成 Object[]（作用域细节），
#      显式 foreach 反而更清楚、也不会出这种意外。
$allBs = Invoke-RestMethod "$API/history/statements?entityId=$entityId&statementType=BALANCE_SHEET"
$listBs = @()
foreach ($row in @($allBs)) {
  if (([datetime]$row.statementDate).ToString('yyyy-MM-dd') -eq '2024-11-30') { $listBs += $row }
}
Check "★ 库里只有一条该日期的档案" ($listBs.Count -eq 1) "实际 $($listBs.Count) 条"

Write-Host "`n=== 7. ★ 不平衡报表建档：必须带告警 ===" -ForegroundColor Cyan
$save3 = Invoke-RestMethod -Method Post "$API/history/statements" -ContentType 'application/json' -Body (@{
  entityId = $entityId
  statementType = 'BALANCE_SHEET'
  periodEnd = '2023-12-31'
  items = @(@{ lineNo='30'; label='资产总计'; endBalance='1062000.00'; beginBalance='985000.00' })
  totals = @{ totalAssets='1062000.00'; totalLiabilities='321000.00'; totalEquity='621000.00' }
  isBalanced = $false
  balanceDifference = '120000.00'
  reconNote = 'verify-recognition 原表确实不平'
} | ConvertTo-Json -Depth 6)
Check "★ 不平衡报表也建档（不阻断，改为留痕）" ($save3.kind -eq 'FINANCIAL_STATEMENT')
Check "★ 返回了不平衡告警" ($save3.warnings.Count -gt 0)
Check "★ 告警中说明了不做平衡修正" (($save3.warnings -join ' ') -like '*不做平衡修正*')

$detail3 = Invoke-RestMethod "$API/history/statements/$($save3.id)/detail?entityId=$entityId"
Check "★ 差额原样存档（未被抹平）" ($detail3.balanceDifference -eq '120000.00') "实际 $($detail3.balanceDifference)"
Check "★ isBalanced=false 已落库" ($detail3.isBalanced -eq $false)

Write-Host "`n=== 8. 申报表建档 ===" -ForegroundColor Cyan
$save4 = Invoke-RestMethod -Method Post "$API/history/statements" -ContentType 'application/json' -Body (@{
  entityId = $entityId
  statementType = 'TAX_RETURN'
  periodEnd = '2024-12'
  filingType = 'VAT_MONTHLY'
  items = @()
  rawRow = @{
    periodStart='2024-12-01'; periodEnd='2024-12-31'
    line1SalesTaxable='412000.00'; line11OutputTax='53560.00'; line12InputTax='38600.00'
    line13CreditBroughtForward='0.00'; line24TaxPayableTotal='14960.00'
    line27TaxPaidThisPeriod='0.00'; line32ClosingUnpaid='14960.00'
    surtaxTotal='897.60'
  }
  reconNote = 'verify-recognition 增值税月报'
} | ConvertTo-Json -Depth 6)
Check "申报记录建档成功" ($save4.kind -eq 'TAX_RETURN') "kind=$($save4.kind)"
Check "所属期标签正确" ($save4.periodLabel -eq '2024-12') "实际 $($save4.periodLabel)"

$filings = Invoke-RestMethod "$API/history/filings?entityId=$entityId"
$vat = $filings | Where-Object { $_.periodLabel -eq '2024-12' -and $_.filingType -eq 'VAT_MONTHLY' }
Check "申报记录可查" ($null -ne $vat)
Check "★ 销售额落库正确" ("$($vat.salesExclTax)" -like '412000*') "实际 $($vat.salesExclTax)"
Check "★ 销项税额落库正确" ("$($vat.outputTax)" -like '53560*') "实际 $($vat.outputTax)"
Check "★ 附加税费落库正确" ("$($vat.surtax)" -like '897.6*') "实际 $($vat.surtax)"

Write-Host "`n=== 9. 申报期间格式校验 ===" -ForegroundColor Cyan
$badPeriod = $null
Invoke-WebRequest -Method Post "$API/history/statements" -ContentType 'application/json' -Body (@{
  entityId = $entityId; statementType = 'TAX_RETURN'; periodEnd = '上个月'
  items = @(); rawRow = @{}
} | ConvertTo-Json -Depth 4) -SkipHttpErrorCheck | ForEach-Object { $badPeriod = $_.Content }
$badObj = $null
try { $badObj = $badPeriod | ConvertFrom-Json } catch { }
Check "★ 无法解析的期间被拒绝" ($null -ne $badObj)
Check "★ 错误提示说明该用什么格式" ("$($badObj.userMessage)" -like '*2024-12*') "实际 $($badObj.userMessage)"

$missingPeriod = $null
try {
  Invoke-WebRequest -Method Post "$API/history/statements" -ContentType 'application/json' -Body (@{
    entityId = $entityId; statementType = 'BALANCE_SHEET'; items = @()
  } | ConvertTo-Json -Depth 4) -SkipHttpErrorCheck | ForEach-Object { $missingPeriod = $_.Content }
} catch { $missingPeriod = $_.Exception.Message }
$missingObj = $null
try { $missingObj = $missingPeriod | ConvertFrom-Json } catch { }
Check "★ 缺期间被拒绝" ($null -ne $missingObj)
Check "★ 错误码为 BAD_REQUEST" ($missingObj.code -eq 'BAD_REQUEST') "实际 $($missingObj.code)"
Check "★ 提示说明期间为何必需" ("$($missingObj.userMessage)" -like '*归不到年份*') "实际 $($missingObj.userMessage)"

Write-Host "`n=== 10. 发票识别链路未被破坏 ===" -ForegroundColor Cyan
$inv = Invoke-RestMethod -Method Post "$API/ai/extract?entityId=$entityId&targetType=INVOICE&case=purchase-office-supplies"
Check "发票识别返回抽取值" ($null -ne $inv.preview.data.invoiceNumber)
Check "发票方向为进项" ($inv.preview.data.direction -eq 'INPUT') "实际 $($inv.preview.data.direction)"
Check "发票有路由决策" ($null -ne $inv.routing)

$bsSample = Invoke-RestMethod -Method Post "$API/ai/extract?entityId=$entityId&targetType=BALANCE_SHEET&case=balance-sheet-balanced"
Check "报表样例可抽取" ($null -ne $bsSample.preview.data.items)
Check "★ 报表样例 routing 为空" ($null -eq $bsSample.routing)
Check "★ 平衡样例判定为平衡" ($bsSample.validation.balanced -eq $true) "balanced=$($bsSample.validation.balanced)"

$bsBad = Invoke-RestMethod -Method Post "$API/ai/extract?entityId=$entityId&targetType=BALANCE_SHEET&case=balance-sheet-unbalanced"
Check "★ 不平衡样例被正确识别" ($bsBad.validation.balanced -eq $false) "balanced=$($bsBad.validation.balanced)"
Check "★ 不平衡样例差额为 120000" ($bsBad.validation.balanceDifference -eq '120000') "实际 $($bsBad.validation.balanceDifference)"

$cit = Invoke-RestMethod -Method Post "$API/ai/extract?entityId=$entityId&targetType=TAX_RETURN&case=vat-return-main"
Check "申报表样例可抽取" ($null -ne $cit.preview.data.line24TaxPayableTotal)

Write-Host "`n=== 10.5 ★ 增值税与企业所得税的字段绝不混写 ===" -ForegroundColor Cyan
$vatS = Invoke-RestMethod -Method Post "$API/ai/extract?entityId=$entityId&targetType=TAX_RETURN&case=vat-return-main"
$citS = Invoke-RestMethod -Method Post "$API/ai/extract?entityId=$entityId&targetType=TAX_RETURN&case=cit-return-annual"
Check "★ 增值税样例返回增值税行次" ($vatS.preview.data.line11OutputTax -eq '53560.00') "实际 $($vatS.preview.data.line11OutputTax)"
Check "★ 增值税样例不含所得税行次" ($null -eq $vatS.preview.data.line3ProfitTotal -or "$($vatS.preview.data.line3ProfitTotal)" -eq '')
Check "★ 所得税样例返回所得税行次" ($citS.preview.data.line3ProfitTotal -eq '325000.00') "实际 $($citS.preview.data.line3ProfitTotal)"
Check "★ 所得税样例不含增值税行次" ($null -eq $citS.preview.data.line11OutputTax -or "$($citS.preview.data.line11OutputTax)" -eq '')

# 落库：企业所得税记录绝不能带增值税字段
# （年报用年度所属期「2023」，与月报的「2024-12」天然不冲突）
$citPeriod = '2023'
Invoke-RestMethod -Method Post "$API/history/statements" -ContentType 'application/json' -Body (@{
  entityId = $entityId
  statementType = 'TAX_RETURN'
  periodEnd = $citPeriod
  filingType = 'CIT_ANNUAL'
  items = @()
  rawRow = $citS.preview.data
  reconNote = 'verify-recognition 企业所得税年报'
} | ConvertTo-Json -Depth 8) | Out-Null

# ★ 必须同时按 filingType 过滤：只按 periodLabel 会把 "2023-12" 的月报也算进来
#   （字符串前缀 "2023" 匹配上了），于是断言读到的是增值税那条记录。
$allFilings = Get-List "$API/history/filings?entityId=$entityId"
$f = $null
foreach ($row in $allFilings) {
  if ($row.periodLabel -eq $citPeriod -and $row.filingType -eq 'CIT_ANNUAL') { $f = $row; break }
}
Check "企业所得税记录已建档" ($null -ne $f) "期间=$citPeriod 类型=CIT_ANNUAL"
Check "★ 所得税记录的销售额为空（未混入增值税字段）" ($null -eq $f.salesExclTax) "实际 $($f.salesExclTax)"
Check "★ 所得税记录的销项税额为空" ($null -eq $f.outputTax) "实际 $($f.outputTax)"
Check "★ 所得税记录的利润总额正确" ("$($f.citProfitBefore)" -like '325000*') "实际 $($f.citProfitBefore)"
Check "★ 所得税记录的应纳所得税额正确" ("$($f.citTaxPayable)" -like '16250*') "实际 $($f.citTaxPayable)"
Check "★ 所得税记录的 taxPayable 也写入了（申报口径）" ("$($f.taxPayable)" -like '16250*') "实际 $($f.taxPayable)"

Write-Host "`n=== 11. ★ 报表绝不产生凭证 ===" -ForegroundColor Cyan
$vouchers = Invoke-RestMethod "$API/vouchers?entityId=$entityId&pageSize=200"
$fromStatement = @($vouchers.items | Where-Object { $_.sourceType -in @('BALANCE_SHEET','TAX_RETURN','FINANCIAL_STATEMENT') })
Check "★ 没有任何凭证来源于报表" ($fromStatement.Count -eq 0) "发现 $($fromStatement.Count) 张"

Write-Host "`n=== 12. 删除档案 ===" -ForegroundColor Cyan
$del = Invoke-RestMethod -Method Delete "$API/history/statements/$($save3.id)?entityId=$entityId"
Check "删除成功" ($del.deleted -eq $true)
$after = Invoke-RestMethod "$API/history/statements?entityId=$entityId" |
  Where-Object { $_.id -eq $save3.id }
Check "★ 删除后确实查不到" ($null -eq $after)

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "  识别录入验证：通过 $pass / 失败 $fail" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "============================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
