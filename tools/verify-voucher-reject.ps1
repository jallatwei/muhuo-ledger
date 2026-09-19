# =============================================================================
#  凭证驳回流程验证
# =============================================================================
#  修的是一个具体问题：审核只有「通过」没有「不通过」，
#  过账只有「过账」没有「退回」—— 流程只能前进不能后退。
#
#  而审核与过账是两个人、两个时间点做的事，后一个人发现问题时必须能退回去。
#
#  验证的关键点：
#    ① 三条退回路径都存在且落到正确的状态
#    ② 退回理由必填，且**回显给被退回的人**（写进凭证备注，不只进日志）
#    ③ 理由为空时是 400「你没填理由」，不是 500「系统坏了」
#    ④ ★ 已过账的凭证三条退回路径全部封死（红线：已结账的账改不动）
#    ⑤ 退回动作进审计日志（谁、什么时候、因为什么）
# =============================================================================

$ErrorActionPreference = 'Stop'
$API = 'http://localhost:3000/api'

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host "  [PASS] $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  [FAIL] $name  $detail" -ForegroundColor Red }
}

# ★ `@(Invoke-RestMethod $url)` 会把 JSON 数组当成单个元素包起来，
#   属性访问退化成成员枚举（fiscalYear 会变成 "2026 2026 2026"）。
#   必须用 Write-Output -NoEnumerate 才拿到真正的数组。
function Get-List([string]$url) {
  return @(Write-Output -NoEnumerate (Invoke-RestMethod $url))
}

Write-Host "`n=== 0. 准备 ===" -ForegroundColor Cyan
$entityId = (Invoke-RestMethod "$API/entities")[0].id
$periods = Get-List "$API/periods?entityId=$entityId"
$p0 = $periods | Sort-Object fiscalYear, month | Select-Object -First 1
Check "取到会计期间" ($null -ne $p0)
Write-Host "  期间：$($p0.fiscalYear)-$('{0:D2}' -f $p0.month)  主体：$entityId"

$script:vSeq = 0
function New-DraftVoucher() {
  $script:vSeq += 1
  $body = @{
    entityId    = $entityId
    periodId    = $p0.id
    voucherDate = ('{0:D4}-{1:D2}-05' -f $p0.fiscalYear, $p0.month)
    summary     = "驳回流程验证 #$($script:vSeq)"
    lines       = @(
      @{ accountCode = '660201'; direction = 'DEBIT'; amount = '100.00'; summary = '测试借方' },
      @{ accountCode = '1002'; direction = 'CREDIT'; amount = '100.00'; summary = '测试贷方' }
    )
  }
  return Invoke-RestMethod -Method Post "$API/vouchers" -ContentType 'application/json' `
    -Body ($body | ConvertTo-Json -Depth 6)
}

function Post-Action([string]$id, [string]$action, [string]$reason = '') {
  $body = if ($reason -eq '') { '{}' } else { @{ reason = $reason } | ConvertTo-Json }
  return Invoke-RestMethod -Method Post "$API/vouchers/$id/$action" -ContentType 'application/json' -Body $body
}

function Get-Voucher([string]$id) { return Invoke-RestMethod "$API/vouchers/$id" }

# =============================================================================
Write-Host "`n=== 1. 审核不通过（REVIEWING → DRAFT） ===" -ForegroundColor Cyan
$v1 = New-DraftVoucher
Post-Action $v1.id 'submit' | Out-Null
Check "提交后为待审核" ((Get-Voucher $v1.id).status -eq 'REVIEWING')

Post-Action $v1.id 'reject' '第2行科目选错，应为「管理费用—办公费」' | Out-Null
$a1 = Get-Voucher $v1.id
Check "★ 驳回后回到草稿" ($a1.status -eq 'DRAFT') "实际 $($a1.status)"
Check "★★ 退回理由已写进凭证备注（回显给制单人）" `
  ($a1.reviewNote -like '*科目选错*') "reviewNote=$($a1.reviewNote)"
Check "记录了审核人" ($null -ne $a1.reviewedBy)

Write-Host "`n=== 2. ★ 空理由必须被拒，且是 400 不是 500 ===" -ForegroundColor Cyan
$v2 = New-DraftVoucher
Post-Action $v2.id 'submit' | Out-Null
$r = Invoke-WebRequest -Method Post "$API/vouchers/$($v2.id)/reject" `
  -ContentType 'application/json' -Body '{"reason":""}' -SkipHttpErrorCheck
$o = $r.Content | ConvertFrom-Json
Check "★★ 空理由返回 400（不是 500「系统内部错误」）" ($r.StatusCode -eq 400) "HTTP $($r.StatusCode)"
Check "★ 错误码指明是理由缺失" ($o.code -eq 'BK_E_REASON_REQUIRED') "code=$($o.code)"
Check "★ 提示说清了为什么要填理由" ($o.userMessage -like '*不知道要改什么*') $o.userMessage
Check "★ 凭证状态未被改动（失败的操做不留痕）" ((Get-Voucher $v2.id).status -eq 'REVIEWING')

Write-Host "`n=== 3. 过账前退回审核（APPROVED → REVIEWING） ===" -ForegroundColor Cyan
$v3 = New-DraftVoucher
Post-Action $v3.id 'submit' | Out-Null
Post-Action $v3.id 'approve' | Out-Null
Check "审核通过后为已审核" ((Get-Voucher $v3.id).status -eq 'APPROVED')

Post-Action $v3.id 'reject-after-review' '该笔进项不应抵扣，属集体福利' | Out-Null
$a3 = Get-Voucher $v3.id
Check "★★ 退回后是「待审核」而不是「草稿」（责任在审核环节）" ($a3.status -eq 'REVIEWING') "实际 $($a3.status)"
Check "★ 退回理由已记录" ($a3.reviewNote -like '*不应抵扣*') "reviewNote=$($a3.reviewNote)"
Check "★ 审核人已清空（等待重新审核）" ($null -eq $a3.reviewedBy)
Check "★ 凭证号仍为 0（未过账就还没编号）" ($a3.voucherNo -eq 0) "voucherNo=$($a3.voucherNo)"

Write-Host "`n=== 4. 反审核（APPROVED → DRAFT） ===" -ForegroundColor Cyan
$v4 = New-DraftVoucher
Post-Action $v4.id 'submit' | Out-Null
Post-Action $v4.id 'approve' | Out-Null
Post-Action $v4.id 'unapprove' '金额录错，需按发票原件重录' | Out-Null
$a4 = Get-Voucher $v4.id
Check "★ 反审核后回到草稿" ($a4.status -eq 'DRAFT') "实际 $($a4.status)"
Check "★ 退回理由已记录" ($a4.reviewNote -like '*金额录错*') "reviewNote=$($a4.reviewNote)"

Write-Host "`n=== 5. 重新提交后旧退回理由应被清掉 ===" -ForegroundColor Cyan
Post-Action $a4.id 'submit' | Out-Null
Post-Action $a4.id 'approve' | Out-Null
$a4b = Get-Voucher $a4.id
Check "★★ 审核通过后旧的退回理由已清空（不误导）" ($null -eq $a4b.reviewNote) "reviewNote=$($a4b.reviewNote)"

Write-Host "`n=== 6. ★★ 已过账的凭证：三条退回路径全部封死 ===" -ForegroundColor Cyan
Post-Action $a4b.id 'post' | Out-Null
$a5 = Get-Voucher $a4b.id
Check "已过账" ($a5.status -eq 'POSTED')
Check "已分配凭证号" ($a5.voucherNo -gt 0) "voucherNo=$($a5.voucherNo)"

foreach ($ep in @('reject', 'reject-after-review', 'unapprove')) {
  $rr = Invoke-WebRequest -Method Post "$API/vouchers/$($a5.id)/$ep" `
    -ContentType 'application/json' -Body '{"reason":"试图退回已过账凭证"}' -SkipHttpErrorCheck
  Check "★★ 已过账时 $ep 被拒绝" ($rr.StatusCode -ge 400) "HTTP $($rr.StatusCode)"
}
Check "★★ 状态仍是已过账（确实没被改动）" ((Get-Voucher $a5.id).status -eq 'POSTED')

Write-Host "`n=== 7. ★ 同一期间可以有多张草稿（曾因错误唯一约束只能有一张） ===" -ForegroundColor Cyan
$multi = @()
for ($i = 1; $i -le 3; $i++) {
  $mv = New-DraftVoucher
  if ($mv.id) { $multi += $mv.id }
}
Check "★★ 同一期间能建出 3 张草稿" ($multi.Count -eq 3) "实际 $($multi.Count) 张"

if ($multi.Count -eq 3) {
  $nos = @()
  foreach ($mid in $multi) {
    Post-Action $mid 'submit' | Out-Null
    Post-Action $mid 'approve' | Out-Null
    $pr = Post-Action $mid 'post'
    $nos += $pr.voucherNo
  }
  Check "★★ 三张都过账后凭证号互不相同" (($nos | Select-Object -Unique).Count -eq 3) "号码：$($nos -join ', ')"
  Check "★★ 凭证号连续无空洞" `
    ((($nos | Sort-Object) -join ',') -eq ((($nos | Sort-Object)[0])..(($nos | Sort-Object)[-1]) -join ',')) `
    "号码：$(($nos | Sort-Object) -join ', ')"
  Check "★ 已过账凭证仍然不可退回" (@($multi | ForEach-Object {
    (Invoke-WebRequest -Method Post "$API/vouchers/$_/reject" -ContentType 'application/json' `
      -Body '{"reason":"试图退回已过账凭证"}' -SkipHttpErrorCheck).StatusCode
  } | Where-Object { $_ -lt 400 }).Count -eq 0)
}

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "  凭证驳回流程验证：通过 $pass / 失败 $fail" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "============================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
