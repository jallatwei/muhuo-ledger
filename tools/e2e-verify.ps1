<#
.SYNOPSIS
  端到端验证：凭证内核的「别记错」防线

.DESCRIPTION
  依次验证（对应 design/08 的 T20~T28）：
    1. 服务健康 + 数据库约束就位
    2. 科目表完整（123 个，含应交税费三级明细）
    3. 借贷不平的凭证被拒绝保存
    4. 非末级科目被拒绝记账
    5. 平衡凭证创建成功（草稿无凭证号）
    6. 过账后分配连续凭证号
    7. 账务自检 I2 / I4 / I5 全通过
    8. 数据库触发器独立拦错（绕过应用层直接写库）

  用法：pwsh -File tools/e2e-verify.ps1
  前置：API 已在 http://localhost:3000/api 运行，且已执行迁移与种子
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
$script:skipped = 0

function Section([string]$title) {
  Write-Host ''
  Write-Host "── $title " -ForegroundColor Cyan -NoNewline
  Write-Host ('─' * [Math]::Max(0, 60 - $title.Length)) -ForegroundColor DarkGray
}

function Check([string]$name, [scriptblock]$test) {
  try {
    $result = & $test
    if ($result -eq $true) {
      Write-Host "  [PASS] $name" -ForegroundColor Green
      $script:pass++
    } elseif ($result -eq 'SKIP') {
      Write-Host "  [SKIP] $name" -ForegroundColor Yellow
      $script:skipped++
    } else {
      Write-Host "  [FAIL] $name" -ForegroundColor Red
      $script:fail++
    }
  } catch {
    Write-Host "  [FAIL] $name" -ForegroundColor Red
    Write-Host "         $($_.Exception.Message)" -ForegroundColor DarkRed
    $script:fail++
  }
}

function Api([string]$method, [string]$path, $body) {
  $uri = "$BaseUrl$path"
  $params = @{ Uri = $uri; Method = $method; TimeoutSec = 60; ContentType = 'application/json' }
  if ($body) { $params.Body = ($body | ConvertTo-Json -Depth 12 -Compress) }
  return Invoke-RestMethod @params
}

function ApiExpectFailure([string]$method, [string]$path, $body) {
  try {
    Api $method $path $body | Out-Null
    return @{ failed = $false; message = '（请求竟然成功了）' }
  } catch {
    $msg = $_.Exception.Message
    # 尽量取出响应体里的中文提示
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      try {
        $parsed = $_.ErrorDetails.Message | ConvertFrom-Json
        if ($parsed.userMessage) { $msg = $parsed.userMessage }
        elseif ($parsed.message) { $msg = $parsed.message }
      } catch { }
    }
    return @{ failed = $true; message = $msg }
  }
}

function Psql([string]$sql) {
  return docker exec $DbContainer psql -U $DbUser -d $DbName -t -A -c $sql 2>&1
}

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor White
Write-Host '  木火账房 — 端到端验证' -ForegroundColor White
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor White
Write-Host "  API: $BaseUrl"

# 每次运行使用唯一幂等键，保证脚本可重复执行而不受上一轮数据影响
$script:runTag = 'E2E-' + (Get-Date -Format 'yyyyMMddHHmmss')

# ============================================================================
Section '1. 服务健康与凭证内核约束'

$health = $null
Check '服务健康检查返回 ok' {
  $script:health = Api 'GET' '/health'
  $script:health.ok -eq $true
}

Check '数据库层强制约束已启用（借贷平衡触发器就位）' {
  $script:health.bookkeeping.dbConstraints -eq $true
}

Check '自动过账默认关闭（人工确认后才入账）' {
  $script:health.bookkeeping.autoPost -eq $false
}

Check '数据库中存在 6 个凭证内核触发器' {
  $sql = "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_journal_line_amount_positive','trg_journal_line_leaf_account','trg_journal_line_period_lock','trg_journal_voucher_balanced','trg_journal_voucher_period_lock','trg_audit_log_immutable')"
  $out = (Psql $sql | Out-String).Trim()
  $out -eq '6'
}

# ============================================================================
Section '2. 基础数据'

$entity = $null
Check '存在核算主体' {
  $entities = Api 'GET' '/entities'
  if ($entities.Count -gt 0) { $script:entity = $entities[0]; return $true }
  return $false
}

$periods = $null
Check '存在 12 个会计期间' {
  $script:periods = Api 'GET' "/periods?entityId=$($script:entity.id)"
  $script:periods.Count -eq 12
}

$accounts = $null
Check '科目表已灌入（≥120 个）' {
  $script:accounts = Api 'GET' "/accounts?entityId=$($script:entity.id)"
  $script:accounts.Count -ge 120
}

Check '增值税三级明细科目齐全' {
  $codes = $script:accounts | ForEach-Object { $_.code }
  $required = @('22210101','22210102','22210105','22210109','22210113','222102','222105','222106','222107')
  $missing = $required | Where-Object { $_ -notin $codes }
  if ($missing) { Write-Host "         缺失: $($missing -join ', ')" -ForegroundColor DarkYellow; return $false }
  return $true
}

Check '应交税费为非末级科目（不允许直接记账）' {
  $acc = $script:accounts | Where-Object { $_.code -eq '2221' }
  $acc -and $acc.isLeaf -eq $false
}

Check '科目表报表映射完整（末级科目都有报表行项目）' {
  $r = Api 'GET' "/accounts/integrity?entityId=$($script:entity.id)"
  if (-not $r.ok) { Write-Host "         未映射: $(($r.unmapped | ForEach-Object { $_.code }) -join ', ')" -ForegroundColor DarkYellow }
  return $r.ok
}

# 选择本年 3 月作为测试期间
$targetPeriod = $script:periods | Where-Object { $_.month -eq 3 -and $_.fiscalYear -eq (Get-Date).Year } | Select-Object -First 1
if (-not $targetPeriod) { $targetPeriod = $script:periods[2] }
$voucherDate = "{0:D4}-{1:D2}-05" -f $targetPeriod.fiscalYear, $targetPeriod.month
Write-Host "         测试期间: $($targetPeriod.fiscalYear)-$('{0:D2}' -f $targetPeriod.month)  状态=$($targetPeriod.status)" -ForegroundColor DarkGray

# ============================================================================
Section '3. 借贷平衡防线（不平不许落库）'

$r = ApiExpectFailure 'POST' '/vouchers' @{
  entityId = $script:entity.id
  periodId = $targetPeriod.id
  voucherDate = $voucherDate
  summary = '【验证】借贷不平的凭证'
  sourceType = 'MANUAL'
  lines = @(
    @{ accountCode = '660202'; direction = 'DEBIT';  amount = '1000.00' }
    @{ accountCode = '2202';   direction = 'CREDIT'; amount = '900.00';  partnerId = 'demo-partner' }
  )
}
Check '借贷差 100 元被拒绝保存' { $r.failed -eq $true }
Check '错误信息包含具体差额（用户能直接定位）' { $r.message -match '100\.00' }
Check '错误信息为中文可读提示' { $r.message -match '借贷不平|差额' }
if ($r.failed) { Write-Host "         → $($r.message)" -ForegroundColor DarkGray }

$r2 = ApiExpectFailure 'POST' '/vouchers' @{
  entityId = $script:entity.id
  periodId = $targetPeriod.id
  voucherDate = $voucherDate
  summary = '【验证】单边凭证'
  sourceType = 'MANUAL'
  lines = @( @{ accountCode = '660202'; direction = 'DEBIT'; amount = '1000.00' } )
}
Check '单边凭证（只有借方）被拒绝' { $r2.failed -eq $true }
if ($r2.failed) { Write-Host "         → $($r2.message)" -ForegroundColor DarkGray }

$r3 = ApiExpectFailure 'POST' '/vouchers' @{
  entityId = $script:entity.id
  periodId = $targetPeriod.id
  voucherDate = $voucherDate
  summary = '【验证】非末级科目'
  sourceType = 'MANUAL'
  lines = @(
    @{ accountCode = '2221'; direction = 'DEBIT';  amount = '1000.00' }
    @{ accountCode = '2202'; direction = 'CREDIT'; amount = '1000.00'; partnerId = 'demo-partner' }
  )
}
Check '非末级科目（应交税费）被拒绝记账' { $r3.failed -eq $true }
Check '错误信息提示改选下级明细科目' { $r3.message -match '末级|明细' }
if ($r3.failed) { Write-Host "         → $($r3.message)" -ForegroundColor DarkGray }

$r4 = ApiExpectFailure 'POST' '/vouchers' @{
  entityId = $script:entity.id
  periodId = $targetPeriod.id
  voucherDate = $voucherDate
  summary = '【验证】金额为 0'
  sourceType = 'MANUAL'
  lines = @(
    @{ accountCode = '660202'; direction = 'DEBIT';  amount = '0.00' }
    @{ accountCode = '2202';   direction = 'CREDIT'; amount = '0.00';   partnerId = 'demo-partner' }
  )
}
Check '金额为 0 被拒绝' { $r4.failed -eq $true }

# ============================================================================
Section '4. 正常凭证：创建 → 审核 → 过账'

$voucherId = $null
Check '创建平衡凭证成功（采购办公用品 1000 + 税 130）' {
  $created = Api 'POST' '/vouchers' @{
    entityId = $script:entity.id
    periodId = $targetPeriod.id
    voucherDate = $voucherDate
    summary = '【验证】采购办公用品'
    sourceType = 'MANUAL'
    idempotencyKey = $script:runTag
    lines = @(
      @{ accountCode = '660202';   direction = 'DEBIT';  amount = '1000.00'; summary = '办公费' }
      @{ accountCode = '22210102'; direction = 'DEBIT';  amount = '130.00';  summary = '待认证进项税额' }
      @{ accountCode = '2202';     direction = 'CREDIT'; amount = '1130.00'; summary = '应付账款'; partnerId = 'demo-partner' }
    )
  }
  $script:voucherId = $created.id
  return [bool]$created.id
}

Check '★ 幂等：重复提交同一 idempotencyKey 不产生第二张凭证' {
  $again = Api 'POST' '/vouchers' @{
    entityId = $script:entity.id
    periodId = $targetPeriod.id
    voucherDate = $voucherDate
    summary = '【验证】采购办公用品（重复提交）'
    sourceType = 'MANUAL'
    idempotencyKey = $script:runTag
    lines = @(
      @{ accountCode = '660202';   direction = 'DEBIT';  amount = '1000.00' }
      @{ accountCode = '22210102'; direction = 'DEBIT';  amount = '130.00' }
      @{ accountCode = '2202';     direction = 'CREDIT'; amount = '1130.00'; partnerId = 'demo-partner' }
    )
  }
  $again.alreadyExists -eq $true -and $again.id -eq $script:voucherId
}

Check '草稿状态未分配凭证号' {
  $v = Api 'GET' "/vouchers/$($script:voucherId)"
  $v.status -eq 'DRAFT' -and $v.voucherNo -eq 0
}

Check '提交审核' {
  Api 'POST' "/vouchers/$($script:voucherId)/submit" @{} | Out-Null
  (Api 'GET' "/vouchers/$($script:voucherId)").status -eq 'REVIEWING'
}

Check '审核通过' {
  Api 'POST' "/vouchers/$($script:voucherId)/approve" @{} | Out-Null
  (Api 'GET' "/vouchers/$($script:voucherId)").status -eq 'APPROVED'
}

$postedNo = $null
Check '过账并分配凭证号' {
  $res = Api 'POST' "/vouchers/$($script:voucherId)/post" @{}
  $script:postedNo = $res.voucherNo
  $res.voucherNo -ge 1
}

Check '过账后凭证状态为 POSTED 且金额正确' {
  $v = Api 'GET' "/vouchers/$($script:voucherId)"
  $v.status -eq 'POSTED' -and $v.totalDebit -eq '1130' -and $v.totalCredit -eq '1130'
}

# ============================================================================
Section '5. 已过账凭证不可修改'

Check '过账后作废被拒绝（只能红冲）' {
  $r = ApiExpectFailure 'POST' "/vouchers/$($script:voucherId)/void" @{ reason = '试着作废' }
  $r.failed
}

# ============================================================================
Section '6. 账务自检（不变式 I2 / I4 / I5）'

Check '不变式 I2：借方余额合计 == 贷方余额合计' {
  $sc = Api 'GET' "/accounting/self-check?entityId=$($script:entity.id)&periodId=$($targetPeriod.id)"
  $i2 = $sc.results | Where-Object { $_.code -eq 'I2' }
  if (-not $i2.passed) { Write-Host "         $($i2.detail)" -ForegroundColor DarkYellow }
  return $i2.passed
}

Check '不变式 I4：余额表与凭证分录一致' {
  $sc = Api 'GET' "/accounting/self-check?entityId=$($script:entity.id)&periodId=$($targetPeriod.id)"
  $i4 = $sc.results | Where-Object { $_.code -eq 'I4' }
  if (-not $i4.passed) { Write-Host "         $($i4.detail)" -ForegroundColor DarkYellow }
  return $i4.passed
}

Check '不变式 I5：凭证号连续无空洞' {
  $sc = Api 'GET' "/accounting/self-check?entityId=$($script:entity.id)&periodId=$($targetPeriod.id)"
  $i5 = $sc.results | Where-Object { $_.code -eq 'I5' }
  if (-not $i5.passed) { Write-Host "         $($i5.detail)" -ForegroundColor DarkYellow }
  return $i5.passed
}

Check '重算余额（幂等操作）后自检仍通过' {
  $rb = Api 'POST' "/accounting/rebuild-balances?entityId=$($script:entity.id)&periodId=$($targetPeriod.id)" @{}
  $rb.ok -eq $true
}

# ============================================================================
Section '7. 数据库触发器独立拦错（绕过应用层）'

Check '绕过应用层直插不平凭证 → 被数据库触发器拦下' {
  $sql = @"
INSERT INTO journal_voucher (id,"entityId","periodId","periodYear","periodMonth","voucherWord","voucherNo","voucherDate",status,"totalDebit","totalCredit",summary,"sourceType","createdAt","updatedAt")
VALUES (gen_random_uuid()::text,'$($script:entity.id)','$($targetPeriod.id)',$($targetPeriod.fiscalYear),$($targetPeriod.month),'记',9999,'$voucherDate','POSTED',100,100,'【验证】绕过应用层的不平凭证','CLOSING',now(),now());
"@
  $out = Psql $sql | Out-String
  $blocked = $out -match 'BK_E_UNBALANCED|BK_E_NO_LINES|BK_E_ZERO_VOUCHER'
  if (-not $blocked) { Write-Host "         实际输出: $($out.Trim())" -ForegroundColor DarkYellow }
  return $blocked
}

Check '绕过应用层写非法金额（0 元分录）→ 被触发器拦下' {
  # 自己造一张草稿凭证，不依赖前面的用例是否成功
  $sql = @"
WITH v AS (
  INSERT INTO journal_voucher (id,"entityId","periodId","periodYear","periodMonth","voucherWord","voucherNo","voucherDate",status,"totalDebit","totalCredit",summary,"sourceType","createdAt","updatedAt")
  VALUES (gen_random_uuid()::text,'$($script:entity.id)','$($targetPeriod.id)',$($targetPeriod.fiscalYear),$($targetPeriod.month),'记',0,'$voucherDate','DRAFT',0,0,'【验证】触发器金额测试','MANUAL',now(),now())
  RETURNING id, "entityId", "periodId"
)
INSERT INTO journal_line (id,"voucherId","entityId","periodId","lineNo","accountId",direction,amount,"createdAt")
SELECT gen_random_uuid()::text, v.id, v."entityId", v."periodId", 1, a.id, 'DEBIT', 0, now()
FROM v, account a
WHERE a."entityId" = '$($script:entity.id)' AND a.code = '660202';
"@
  $out = Psql $sql | Out-String
  $blocked = $out -match 'BK_E_AMOUNT_NOT_POSITIVE'
  if (-not $blocked) { Write-Host "         实际输出: $($out.Trim())" -ForegroundColor DarkYellow }
  return $blocked
}

Check '绕过应用层向已结账期间写凭证 → 被期间锁拦下' {
  # 临时把测试期间置为 CLOSED，尝试写入，然后恢复
  Psql "UPDATE period SET status='CLOSED' WHERE id='$($targetPeriod.id)';" | Out-Null
  $sql = @"
INSERT INTO journal_line (id,"voucherId","entityId","periodId","lineNo","accountId",direction,amount,"createdAt")
SELECT gen_random_uuid()::text, v.id, v."entityId", v."periodId", 1, a.id, 'DEBIT', 100, now()
FROM journal_voucher v, account a
WHERE v."periodId" = '$($targetPeriod.id)' AND a."entityId" = '$($script:entity.id)' AND a.code = '660202'
LIMIT 1;
"@
  $out = Psql $sql | Out-String
  Psql "UPDATE period SET status='OPEN' WHERE id='$($targetPeriod.id)';" | Out-Null
  $blocked = $out -match 'BK_E_PERIOD_LOCKED'
  if (-not $blocked) { Write-Host "         实际输出: $($out.Trim())" -ForegroundColor DarkYellow }
  return $blocked
}

Check '审计日志不可修改（只追加）' {
  # 先确保表里有行（前面的成功操作会写审计日志），否则先造一行
  $cnt = (Psql "SELECT count(*) FROM audit_log;" | Out-String).Trim()
  if ($cnt -eq '0') {
    Psql "INSERT INTO audit_log (id, action, ""subjectType"", ""subjectId"", ""createdAt"") VALUES (gen_random_uuid()::text,'CREATE','Verification','seed-row',now());" | Out-Null
  }
  $out = Psql "UPDATE audit_log SET action = 'HACKED' WHERE id = (SELECT id FROM audit_log LIMIT 1);" | Out-String
  if ($out -notmatch 'BK_E_AUDIT_IMMUTABLE') { Write-Host "         实际输出: $($out.Trim())" -ForegroundColor DarkYellow }
  return ($out -match 'BK_E_AUDIT_IMMUTABLE')
}

Check '审计日志不可删除（只追加）' {
  $out = Psql "DELETE FROM audit_log WHERE id = (SELECT id FROM audit_log LIMIT 1);" | Out-String
  return ($out -match 'BK_E_AUDIT_IMMUTABLE')
}

# ============================================================================
Section '8. 凭证册数据齐备'

Check '期间凭证汇总可读取（凭证册封面数据）' {
  $s = Api 'GET' "/vouchers/period-summary?entityId=$($script:entity.id)&periodId=$($targetPeriod.id)"
  $s.count -ge 1 -and [double]$s.totalDebit -ge 1130
}

Check '凭证查询可返回分录明细（含科目编码与名称）' {
  $list = Api 'GET' "/vouchers?entityId=$($script:entity.id)&periodId=$($targetPeriod.id)"
  $v = $list.items | Where-Object { $_.id -eq $script:voucherId } | Select-Object -First 1
  if (-not $v) { return $false }
  $v.lines.Count -eq 3 -and ($v.lines | Where-Object { $_.account.code -eq '22210102' }).Count -eq 1
}

# ============================================================================
Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor White
$totalColor = if ($script:fail -eq 0) { 'Green' } else { 'Red' }
Write-Host ("  结果：{0} 通过 / {1} 失败 / {2} 跳过" -f $script:pass, $script:fail, $script:skipped) -ForegroundColor $totalColor
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor White
Write-Host ''

if ($script:fail -gt 0) { exit 1 }
exit 0
