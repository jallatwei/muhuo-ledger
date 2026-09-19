# =============================================================================
#  识别目标自动判定 验证
# =============================================================================
#  解决的问题：用户上传文件时不该由他先想清楚"这是发票还是报表"。
#  系统应该自己看出来；实在看不出来，**再问人**。
#
#  验证的关键点：
#    ① 各类单据都能判对（发票 / 回单 / 流水 / 合同 / 收据 / 报表 / 申报表）
#    ② ★ 容易混淆的组合必须判对：
#         · 企业所得税年报（含"利润总额"）不得被判成利润表
#         · Excel 发票台账不得被当成单张票去识别
#         · 银行流水（常为 Excel 导出）不得被判成报表或回单
#    ③ ★ 判不出来时**不猜**：返回 needsTargetChoice，并给出可选项与原因
#    ④ 人工指定优先于自动判定，且冲突时明确提示
#    ⑤ 每次判定都要给出依据（文件类型 / 标题 / 字段）与结论说明
# =============================================================================

$ErrorActionPreference = 'Stop'
$API = 'http://localhost:3000/api'
$tmp = Join-Path $env:TEMP 'bk-auto-verify'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host "  [PASS] $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  [FAIL] $name  $detail" -ForegroundColor Red }
}

function Upload([string]$path, [string]$entityId, [string]$targetType = '') {
  $boundary = [System.Guid]::NewGuid().ToString('N')
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $fn = [System.IO.Path]::GetFileName($path)
  $LF = "`r`n"
  $head = "--$boundary$LF" +
          "Content-Disposition: form-data; name=`"file`"; filename=`"$fn`"$LF" +
          "Content-Type: application/octet-stream$LF$LF"
  $mid = "$LF--$boundary$LF" +
         "Content-Disposition: form-data; name=`"entityId`"$LF$LF$entityId$LF"
  if ($targetType -ne '') {
    $mid += "--$boundary$LF" +
            "Content-Disposition: form-data; name=`"targetType`"$LF$LF$targetType$LF"
  }
  $mid += "--$boundary--$LF"
  $hb=[System.Text.Encoding]::UTF8.GetBytes($head)
  $mb=[System.Text.Encoding]::UTF8.GetBytes($mid)
  $body = New-Object byte[] ($hb.Length+$bytes.Length+$mb.Length)
  [Array]::Copy($hb,0,$body,0,$hb.Length)
  [Array]::Copy($bytes,0,$body,$hb.Length,$bytes.Length)
  [Array]::Copy($mb,0,$body,$hb.Length+$bytes.Length,$mb.Length)
  $raw = (Invoke-WebRequest -Method Post "$API/ai/recognize" `
    -ContentType "multipart/form-data; boundary=$boundary" -Body $body).Content
  return $raw | ConvertFrom-Json
}

function Make-File([string]$name, [string]$content) {
  $p = Join-Path $tmp $name
  [System.IO.File]::WriteAllText($p, $content, (New-Object System.Text.UTF8Encoding($false)))
  return $p
}

Write-Host "`n=== 0. 准备 ===" -ForegroundColor Cyan
$entityId = (Invoke-RestMethod "$API/entities")[0].id
Write-Host "  主体：$entityId"

# 造各类测试文件
$fInvoice = Make-File 'invoice.txt' @'
增值税专用发票
发票代码 044001900111
发票号码 12345678
购买方名称：演示科技有限公司
纳税人识别号：91110108MA01XXXX1A
销售方名称：某某商贸有限公司
价税合计（小写）¥1130.00
'@

$fSlip = Make-File 'slip.csv' @'
电子回单
付款人：演示科技有限公司
收款人：某某供应商有限公司
交易流水号：20240105000123
金额：1130.00
'@

$fBankStmt = Make-File 'bank.csv' @'
交易明细
交易日期,对方户名,借方发生额,贷方发生额,账户余额
2024-01-05,甲公司,0.00,1130.00,386400.00
2024-01-08,乙公司,500.00,0.00,385900.00
'@

$fContract = Make-File 'contract.csv' @'
采购合同
甲方：演示科技有限公司
乙方：某某商贸有限公司
第一条 标的
本合同自双方签字之日起生效
'@

$fReceipt = Make-File 'receipt.csv' @'
收款收据
今收到 演示科技有限公司 款项 1130.00 元
'@

$fBalance = Make-File 'balance.csv' @'
资产负债表
会小企01表
项目,行次,期末余额,年初余额
货币资金,1,386400.00,298000.00
资产总计,30,1238400.00,1062000.00
负债合计,47,356900.00,321000.00
负债和所有者权益总计,52,1238400.00,1062000.00
'@

$fIncome = Make-File 'income.csv' @'
利润表
会小企02表
项目,行次,本期金额,上期金额
一、营业收入,1,2680000.00,2310000.00
减：营业成本,2,1890000.00,1640000.00
三、利润总额,11,325000.00,254000.00
四、净利润,13,308750.00,241300.00
'@

$fVat = Make-File 'vat.csv' @'
增值税及附加税费申报表（一般纳税人适用）
税款所属期：2024年12月01日至2024年12月31日
行次,项目,一般项目本月数
1,按适用税率计税销售额,412000.00
11,销项税额,53560.00
12,进项税额,38600.00
19,应纳税额,14960.00
'@

$fCit = Make-File 'cit.csv' @'
中华人民共和国企业所得税年度纳税申报表（A类）
行次,项目,本年累计金额
1,营业收入,2680000.00
2,营业成本,1890000.00
3,利润总额,325000.00
10,应纳税所得额,325000.00
12,应纳所得税额,81250.00
'@

$fLedger = Make-File 'ledger.csv' @'
开票日期,发票代码,发票号码,购买方名称,价税合计
2024-01-05,044001900111,12345678,甲公司,1130.00
2024-01-08,044001900111,12345679,乙公司,2260.00
2024-01-12,044001900111,12345680,丙公司,3390.00
'@

# 最小 PNG（无文本层）
$fImage = Join-Path $tmp 'scan.png'
[System.IO.File]::WriteAllBytes($fImage, [byte[]]@(
  0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,
  0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
  0x08,0x06,0x00,0x00,0x00,0x1F,0x15,0xC4,0x89,
  0x00,0x00,0x00,0x0A,0x49,0x44,0x41,0x54,0x78,0x9C,0x63,0x00,0x01,0x00,0x00,0x05,0x00,0x01,
  0x0D,0x0A,0x2D,0xB4,
  0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,0xAE,0x42,0x60,0x82))

# =============================================================================
Write-Host "`n=== 1. 各类单据自动判定 ===" -ForegroundColor Cyan
$cases = @(
  @{ f = $fInvoice;  d = '增值税专用发票'; kind = 'INVOICE';        target = 'INVOICE' },
  @{ f = $fSlip;     d = '银行回单';       kind = 'BANK_SLIP';      target = 'BANK_SLIP' },
  @{ f = $fBankStmt; d = '银行流水';       kind = 'BANK_STATEMENT'; target = 'BANK_STATEMENT' },
  @{ f = $fBalance;  d = '资产负债表';     kind = 'STATEMENT';      target = 'BALANCE_SHEET' },
  @{ f = $fIncome;   d = '利润表';         kind = 'STATEMENT';      target = 'INCOME_STATEMENT' },
  @{ f = $fVat;      d = '增值税申报表';   kind = 'STATEMENT';      target = 'TAX_RETURN' },
  @{ f = $fCit;      d = '所得税年报';     kind = 'STATEMENT';      target = 'TAX_RETURN' }
)
foreach ($c in $cases) {
  $r = Upload $c.f $entityId
  Check "$($c.d) → kind=$($c.kind)" ($r.classification.kind -eq $c.kind) "实际 $($r.classification.kind)"
  Check "$($c.d) → target=$($c.target)" ($r.classification.targetType -eq $c.target) "实际 $($r.classification.targetType)"
  Check "$($c.d) 由系统判定" ($r.classification.chosenBy -eq 'SYSTEM') "实际 $($r.classification.chosenBy)"
  Check "$($c.d) 给出了依据" ($r.classification.evidence.Count -gt 0)
  Check "$($c.d) 给出了结论说明" ($r.classification.reason.Length -gt 5)
}

# =============================================================================
Write-Host "`n=== 2. ★★ 不易凭证：合同与收据不参与记账 ===" -ForegroundColor Cyan
$rc = Upload $fContract $entityId
Check "合同 → CONTRACT" ($rc.classification.kind -eq 'CONTRACT') "实际 $($rc.classification.kind)"
Check "★★ 合同无识别目标（不参与记账）" ($null -eq $rc.classification.targetType) "实际 $($rc.classification.targetType)"
Check "★ 说明里点明不参与记账" ($rc.classification.reason -like '*不参与记账*') $rc.classification.reason

$rr = Upload $fReceipt $entityId
Check "收据 → RECEIPT" ($rr.classification.kind -eq 'RECEIPT') "实际 $($rr.classification.kind)"
Check "★ 收据提示税前扣除风险" ($rr.classification.reason -like '*税前扣除*') $rr.classification.reason

# =============================================================================
Write-Host "`n=== 3. ★★ 易混淆：所得税年报不得判成利润表 ===" -ForegroundColor Cyan
$rcit = Upload $fCit $entityId
Check "★★ 含「利润总额」的所得税年报判为申报表" `
  ($rcit.classification.statementType -like 'TAX_RETURN*') "实际 $($rcit.classification.statementType)"
Check "★★ 明确不是利润表" ($rcit.classification.statementType -ne 'INCOME_STATEMENT')
Check "★ 标签含「企业所得税」" ($rcit.classification.label -like '*企业所得税*') $rcit.classification.label

# =============================================================================
Write-Host "`n=== 4. ★★ 易混淆：Excel 发票台账不得当单张票识别 ===" -ForegroundColor Cyan
$rl = Upload $fLedger $entityId
Check "判为发票类" ($rl.classification.kind -eq 'INVOICE') "实际 $($rl.classification.kind)"
Check "★★ 不给识别目标（台账不能走单张票识别）" ($null -eq $rl.classification.targetType)
Check "★★ 要求人工处理" ($rl.classification.needsConfirmation -eq $true)
Check "★ needsTargetChoice 为真" ($rl.needsTargetChoice -eq $true)
Check "★★ 没有执行识别（preview 为 null）" ($null -eq $rl.preview)
Check "★ 结论里点明是「台账」" ($rl.classification.reason -like '*台账*') $rl.classification.reason
Check "★★ 指引到「历史数据导入」" ($rl.classification.hint -like '*历史数据导入*') $rl.classification.hint

# =============================================================================
Write-Host "`n=== 5. ★★ 银行流水（Excel 导出）不得被判成报表 ===" -ForegroundColor Cyan
$rb = Upload $fBankStmt $entityId
Check "★★ 判为银行流水" ($rb.classification.kind -eq 'BANK_STATEMENT') "实际 $($rb.classification.kind)"
Check "★★ 未判成报表类" ($rb.classification.kind -ne 'STATEMENT')
Check "★ 未判成回单" ($rb.classification.kind -ne 'BANK_SLIP')

# =============================================================================
Write-Host "`n=== 6. ★★ 判不出来时不猜 ===" -ForegroundColor Cyan
$ri = Upload $fImage $entityId
Check "★★ 返回 needsTargetChoice" ($ri.needsTargetChoice -eq $true)
Check "★★ 未执行识别（preview 为 null）" ($null -eq $ri.preview)
Check "★★ 无识别目标" ($null -eq $ri.classification.targetType)
Check "★★ 置信度为 0（没有把握就不装）" ($ri.classification.confidence -eq 0) "实际 $($ri.classification.confidence)"
Check "★ 说明了为什么判不出来" ($ri.classification.reason -like '*无法*判断*') $ri.classification.reason
Check "★ 列出了可选目标" `
  (($ri.classification.hint -like '*发票*') -and ($ri.classification.hint -like '*资产负债表*')) `
  $ri.classification.hint
Check "★ 说明里点明「不猜」的理由" ($ri.explanation -like '*不猜*') $ri.explanation
Check "★ 判定依据仍在（说明了看的是什么）" ($ri.classification.evidence.Count -gt 0)

# 内容完全无关的文件
$fJunk = Make-File 'junk.csv' "姓名,年龄`n张三,30"
$rj = Upload $fJunk $entityId
Check "★ 无关表格 → 也要求人工选" ($rj.needsTargetChoice -eq $true)

# =============================================================================
Write-Host "`n=== 7. ★★ 人工指定优先于自动判定 ===" -ForegroundColor Cyan
$rm = Upload $fImage $entityId 'INVOICE'
Check "★ chosenBy = USER" ($rm.classification.chosenBy -eq 'USER') "实际 $($rm.classification.chosenBy)"
Check "★★ 人工指定后确实执行了识别" ($null -ne $rm.preview)
Check "★ 系统仍报告自己原本判定为「未识别出类型」" `
  ($rm.classification.label -eq '未识别出类型' -or $rm.classification.label -eq '') `
  $rm.classification.label

# 人工选择与系统判定冲突
$rc2 = Upload $fBalance $entityId 'INVOICE'
Check "★★ 冲突被标记出来" ($rc2.classification.conflictsWithUserChoice -eq $true)
Check "★ 冲突时仍以人工选择为准（走了发票管道）" ($rc2.classification.chosenBy -eq 'USER')

# =============================================================================
Write-Host "`n=== 8. ★ 判定依据分级正确 ===" -ForegroundColor Cyan
$rb2 = Upload $fBalance $entityId
$strengths = ($rb2.classification.evidence | ForEach-Object { $_.strength }) -join ','
Check "★ 表格文件给出 FILE_TYPE 依据" ($strengths -like '*FILE_TYPE*') $strengths
Check "★ 给出 TITLE 依据" ($strengths -like '*TITLE*') $strengths
Check "★ 给出 FIELD 依据" ($strengths -like '*FIELD*') $strengths
Check "★ 依据文本非空" `
  (@($rb2.classification.evidence | Where-Object { $_.signal.Length -lt 4 }).Count -eq 0)

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "  识别目标自动判定验证：通过 $pass / 失败 $fail" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "============================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
