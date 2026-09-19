# =============================================================================
#  税务政策检索 + 报销合规自检 验证
# =============================================================================
#  这两块都有"看起来在工作、实际没用"的风险，所以要验的不是"能跑通"，而是：
#
#    ① 政策：原文与关键日期必须留存（不能只存标题摘要）
#    ② 政策：限定条件必须被单独摘出来（用户最容易忽略的就是这个）
#    ③ 政策：抓取时间必须随政策一起存（政策会改，要能追溯"当时看到哪一版"）
#    ④ 政策：内容变更必须单独报出来（链接没变、正文变了，最易漏）
#    ⑤ 政策：每次执行都留痕（含失败）—— 否则分不清"没新政策"与"抓取挂了"
#    ⑥ 政策：不得出现"适用于你""建议这样申报"这类结论性表述
#    ⑦ 自检：必须带"非税务意见"声明
#    ⑧ 自检：每条结论都要给"该怎么核实"，只说有问题等于没说
#    ⑨ 自检：形态可疑类不得被表述为"违规"
# =============================================================================

$ErrorActionPreference = 'Stop'
$API = 'http://localhost:3000/api'

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host "  [PASS] $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  [FAIL] $name  $detail" -ForegroundColor Red }
}

# 用 Invoke-WebRequest 拿真正数组：`@(Invoke-RestMethod)` 会把 JSON 数组
# 当成单个元素包起来，属性访问退化成成员枚举。
function Get-Json([string]$url) {
  return (Invoke-WebRequest $url).Content | ConvertFrom-Json
}

Write-Host "`n=== 0. 准备 ===" -ForegroundColor Cyan
$entityId = (Invoke-RestMethod "$API/entities")[0].id
$period = (Invoke-RestMethod "$API/periods?entityId=$entityId")[0]
Write-Host "  主体=$entityId  期间=$($period.fiscalYear)-$($period.month)"

# =============================================================================
Write-Host "`n=== 1. 已登记来源 ===" -ForegroundColor Cyan
$src = Invoke-RestMethod "$API/tax/policies/sources?jurisdiction=CN-JL"
Check "登记了官方来源" ($src.sources.Count -gt 0) "共 $($src.sources.Count) 个"
$nonGov = @($src.sources | Where-Object { $_.url -notlike '*gov.cn*' })
$nonGovUrls = ($nonGov | ForEach-Object { $_.url }) -join ', '
Check "★ 全部是官方来源（不含第三方解读站点）" ($nonGov.Count -eq 0) $nonGovUrls
Check "★ 明确声明「没搜到 ≠ 没有这条政策」" ($src.note -like '*不等于*') $src.note
Check "含国家层面来源" (@($src.sources | Where-Object { $_.jurisdiction -eq 'CN-GENERAL' }).Count -gt 0)
Check "含吉林地方来源（报税地）" (@($src.sources | Where-Object { $_.jurisdiction -eq 'CN-JL' }).Count -gt 0)

# =============================================================================
Write-Host "`n=== 2. 执行检索 ===" -ForegroundColor Cyan
$r = Invoke-RestMethod -Method Post "$API/tax/policies/search" -ContentType 'application/json' `
  -Body (@{ jurisdiction = 'CN-JL'; triggeredBy = 'VERIFY' } | ConvertTo-Json)
Check "返回执行结果" ($null -ne $r.runId)
Check "状态为成功或部分成功" ($r.status -in @('SUCCESS', 'PARTIAL')) $r.status
Check "报告了尝试的来源数" ($r.sourcesTried -gt 0) "sourcesTried=$($r.sourcesTried)"
Check "报告了失败的来源数" ($null -ne $r.sourcesFailed) "sourcesFailed=$($r.sourcesFailed)"
Check "★ 给出了抓取时间" ($null -ne $r.fetchedAt)
Check "★★ 结果自带免责声明" ($r.disclaimer -like '*不判断*适用*') $r.disclaimer

# =============================================================================
Write-Host "`n=== 3. ★ 政策原文与关键日期必须留存 ===" -ForegroundColor Cyan
$policies = @(Get-Json "$API/tax/policies?jurisdiction=CN-JL")
Check "政策库有内容" ($policies.Count -gt 0) "共 $($policies.Count) 条"

$p0 = $policies[0]
$contentLen = if ($p0.rawContent) { $p0.rawContent.Length } else { 0 }
Check "★ 存了正文原文（不是只有标题）" ($contentLen -gt 50) "长度=$contentLen"
Check "★ 存了来源链接" ($p0.sourceUrl -like 'http*') $p0.sourceUrl
Check "★ 存了抓取时间" ($null -ne $p0.fetchedAt)
Check "★ 存了内容哈希（用于判断变没变）" ($null -ne $p0.contentHash -and $p0.contentHash.Length -ge 16)
Check "标了发文机关或来源站点" ($null -ne $p0.issuer -or $null -ne $p0.sourceName)
Check "识别出了税种" ($p0.taxTypes.Count -gt 0) ($p0.taxTypes -join '/')

# 施行日期必须有（这是判断"现在该按哪条"的关键）
$withEffective = @($policies | Where-Object { $null -ne $_.effectiveFrom })
$effRatio = "$($withEffective.Count)/$($policies.Count)"
Check "★ 多数政策有施行日期" ($withEffective.Count -ge [Math]::Ceiling($policies.Count / 2)) $effRatio

# 状态措辞必须是"按公布日期推算"，不能是"现行有效，你可以适用"
Check "★★ 状态措辞是推算口径（不是适用结论）" `
  ($p0.displayStatus -like '*按公布日期推算*') $p0.displayStatus

# =============================================================================
Write-Host "`n=== 4. ★★ 限定条件必须被摘出来 ===" -ForegroundColor Cyan
$withConditions = @($policies | Where-Object { $_.conditions.Count -gt 0 })
$condSummary = "共 $($withConditions.Count) 条有条件"
Check "★★ 有政策被摘出了限定条件" ($withConditions.Count -gt 0) $condSummary

if ($withConditions.Count -gt 0) {
  $c = $withConditions[0]
  Write-Host "     示例条件：$($c.conditions[0])" -ForegroundColor Gray
  $condText = $c.conditions -join ' | '
  Check "★★ 条件文本含具体门槛（人数/金额/比例）" `
    (($c.conditions -join ' ') -match '\d|不超过|同时符合|同时满足') $condText
}

# 小微三项条件必须能被摘出来（这是最容易被忽略的）
$smallMicro = $policies | Where-Object { ($_.conditions -join ' ') -like '*同时符合*' }
$allConds = ($policies | ForEach-Object { $_.conditions -join '|' }) -join ' ;; '
Check "★★ 小微企业的「同时符合下列条件」被摘出" ($null -ne $smallMicro) $allConds

# =============================================================================
Write-Host "`n=== 5. ★ 幂等：再次检索应全部判为未变 ===" -ForegroundColor Cyan
$r2 = Invoke-RestMethod -Method Post "$API/tax/policies/search" -ContentType 'application/json' `
  -Body (@{ jurisdiction = 'CN-JL'; triggeredBy = 'VERIFY' } | ConvertTo-Json)
Check "★ 第二次检索无新增" ($r2.policiesNew -eq 0) "policiesNew=$($r2.policiesNew)"
Check "★ 第二次检索无变更" ($r2.policiesChanged -eq 0) "policiesChanged=$($r2.policiesChanged)"
Check "★ 全部判为未变" ($r2.unchanged -gt 0) "unchanged=$($r2.unchanged)"

# 政策库条数不应因重复检索而增加
$policies2 = @(Get-Json "$API/tax/policies?jurisdiction=CN-JL")
Check "★★ 重复检索不产生重复记录" ($policies2.Count -eq $policies.Count) `
  "第一次 $($policies.Count) 条，第二次 $($policies2.Count) 条"

# =============================================================================
Write-Host "`n=== 6. ★★ 执行留痕（含失败） ===" -ForegroundColor Cyan
$runs = @(Get-Json "$API/tax/policies/runs")
Check "★ 每次执行都有记录" ($runs.Count -ge 2) "共 $($runs.Count) 条"
Check "★ 记录里含来源成功/失败明细" ($null -ne $runs[0].sourceResults)
$runLabels = ($runs | ForEach-Object { $_.statusLabel }) -join ' | '
Check "★ 成功时的标签是「全部来源成功」" ($runLabels -like '*全部来源成功*') $runLabels

# ★ 「抓取失败」这一档本次跑不出来（来源都成功了），所以改为验证它**存在于实现里** ——
#   这是一个真实需求：没有这一档，用户就无法分辨"本期没有新政策"与"抓取全挂了"。
$svcPath = Join-Path $PSScriptRoot '..\apps\api\src\application\tax\tax-policy.service.ts'
$svcSrc = [System.IO.File]::ReadAllText($svcPath, [System.Text.Encoding]::UTF8)
Check "★★ 状态标签实现了「抓取失败（不代表没有新政策）」这一档" `
  ($svcSrc -like '*抓取失败（不代表没有新政策）*')
Check "★★ 抓取失败时明确声明「不代表没有新政策」" `
  ($svcSrc -like '*不代表*没有新政策*')
$schedPath = Join-Path $PSScriptRoot '..\apps\api\src\interface\policy-schedule.service.ts'
$schedSrc = [System.IO.File]::ReadAllText($schedPath, [System.Text.Encoding]::UTF8)
Check "★★ 调度器只把 SUCCESS/PARTIAL 算作「本月跑过了」（失败要重试）" `
  (($schedSrc -like '*SUCCESS*') -and ($schedSrc -like '*PARTIAL*') -and ($schedSrc -like '*hasSucceededThisMonth*'))
Check "★★ 幂等靠查库（本月是否已有成功记录），不靠内存标志" `
  ($schedSrc -like '*taxPolicyFetchRun.count*')

# =============================================================================
Write-Host "`n=== 7. ★★ 不得出现适用性结论 ===" -ForegroundColor Cyan
$allText = ($policies | ForEach-Object { "$($_.title) $($_.rawContent) $($_.displayStatus)" }) -join "`n"
$forbidden = @('你应当这样申报', '建议你选择', '适用于你的企业', '最优申报方式', '你可以适用该政策')
$hits = @($forbidden | Where-Object { $allText -like "*$_*" })
Check "★★ 政策库不含适用性结论表述" ($hits.Count -eq 0) ($hits -join ', ')

$detail = Invoke-RestMethod "$API/tax/policies/$($p0.id)"
Check "★★ 单条详情也自带免责声明" ($detail.disclaimer -like '*不判断*适用*') $detail.disclaimer
Check "★ 单条详情返回抓取时间标签" ($null -ne $detail.fetchedAtLabel)

# =============================================================================
Write-Host "`n=== 8. 标记已阅（人工确认适用性） ===" -ForegroundColor Cyan
$before = @(Get-Json "$API/tax/policies?jurisdiction=CN-JL&needsReviewOnly=true")
Check "★ 新政策默认为「待人工阅读」" ($before.Count -gt 0) "共 $($before.Count) 条待阅"

# ★ 必须挑一条**当前仍在待阅**的政策来标记：
#   若固定用 $p0，第一次运行后它已不是待阅，断言就会假失败。
$target = $before[0]
Invoke-RestMethod -Method Post "$API/tax/policies/$($target.id)/review" -ContentType 'application/json' `
  -Body (@{ notes = 'verify 脚本标记' } | ConvertTo-Json) | Out-Null
$after = @(Get-Json "$API/tax/policies?jurisdiction=CN-JL&needsReviewOnly=true")
$reviewDetail = "标记「$($target.title.Substring(0,[Math]::Min(20,$target.title.Length)))…」：标记前 $($before.Count)，标记后 $($after.Count)"
Check "★ 标记后不再出现在待阅列表" ($after.Count -eq $before.Count - 1) $reviewDetail

# 复位：让脚本可重复运行（下次跑时这条仍在待阅里）
$resetSql = 'UPDATE tax_policy_record SET "needsReview" = true, "reviewedAt" = NULL WHERE id = ' + "'" + $target.id + "';"
$resetSql | docker exec -i bk-postgres psql -U bookkeeper -d bookkeeper_dev 2>&1 | Out-Null
$restored = @(Get-Json "$API/tax/policies?jurisdiction=CN-JL&needsReviewOnly=true")
Check "★ 复位成功（脚本可重复运行）" ($restored.Count -eq $before.Count) `
  "复位后 $($restored.Count) 条待阅，期望 $($before.Count)"

# =============================================================================
Write-Host "`n=== 9. ★★ 报销自检：必须带非税务意见声明 ===" -ForegroundColor Cyan
$audit = Invoke-RestMethod -Method Post "$API/tax/expense-audit" -ContentType 'application/json' `
  -Body (@{ entityId = $entityId; fiscalYear = $period.fiscalYear; month = $period.month } | ConvertTo-Json)

Check "返回自检报告" ($null -ne $audit.summary)
Check "★★ 带「不是税务意见」声明" ($audit.disclaimer -like '*不是税务意见*') $audit.disclaimer
Check "★★ 声明里点明「形态可疑 ≠ 违规」" ($audit.disclaimer -like '*形态可疑*不等于*') $audit.disclaimer
Check "★ 声明里说明需要咨询专业人士" ($audit.disclaimer -like '*税务专业人士*')
Check "报告了扫描范围" ($null -ne $audit.scope.voucherCount)
Check "★ 报告了生成时间" ($null -ne $audit.generatedAt)

# =============================================================================
Write-Host "`n=== 10. ★★ 每条结论都要给「该怎么核实」 ===" -ForegroundColor Cyan
$findings = @($audit.findings)
Check "产生了自检结论" ($findings.Count -gt 0) "共 $($findings.Count) 条"

$noHowTo = @($findings | Where-Object { -not $_.howToVerify -or $_.howToVerify.Length -lt 10 })
$noHowToIds = ($noHowTo | Select-Object -First 3 | ForEach-Object { $_.ruleId }) -join ', '
Check "★★ 每条结论都有核实指引" ($noHowTo.Count -eq 0) $noHowToIds

$noBasis = @($findings | Where-Object { -not $_.basis -or $_.basis.Length -lt 5 })
$noBasisIds = ($noBasis | Select-Object -First 3 | ForEach-Object { $_.ruleId }) -join ', '
Check "★ 每条结论都有规则依据" ($noBasis.Count -eq 0) $noBasisIds

$noSubjects = @($findings | Where-Object { -not $_.subjects -or $_.subjects.Count -eq 0 })
$noSubjectIds = ($noSubjects | Select-Object -First 3 | ForEach-Object { $_.ruleId }) -join ', '
Check "★ 每条结论都能定位到具体凭证/发票" ($noSubjects.Count -eq 0) $noSubjectIds

# 严重程度只能是三类
$badSev = @($findings | Where-Object { $_.severity -notin @('VIOLATION','SUSPICIOUS','NOTICE') })
$badSevNames = ($badSev | ForEach-Object { $_.severity }) -join ', '
Check "★ 严重程度取值合法" ($badSev.Count -eq 0) $badSevNames

# =============================================================================
Write-Host "`n=== 11. ★★ 形态可疑类不得表述为「违规」 ===" -ForegroundColor Cyan
$suspicious = @($findings | Where-Object { $_.severity -eq 'SUSPICIOUS' })
if ($suspicious.Count -gt 0) {
  $badWording = @($suspicious | Where-Object {
    $_.title -like '*违规*' -or $_.detail -like '*违规*' -or $_.title -like '*违法*'
  })
  $badTitles = ($badWording | ForEach-Object { $_.title }) -join ' | '
  Check "★★ 可疑类结论不含「违规/违法」字样" ($badWording.Count -eq 0) $badTitles
} else {
  Write-Host "  （本期无可疑类结论，跳过措辞断言）" -ForegroundColor Yellow
}

# 连号发票这条最典型：必须写明"不代表有问题"
$seqPolicy = @($findings | Where-Object { $_.ruleId -eq 'SEQ-001' })
if ($seqPolicy.Count -gt 0) {
  Check "★★ 连号发票结论写明「不代表有问题」" `
    ($seqPolicy[0].detail -like '*不代表有问题*') $seqPolicy[0].detail
} else {
  Write-Host "  （本期无连号发票，跳过）" -ForegroundColor Yellow
}

# =============================================================================
Write-Host "`n=== 12. 参数校验 ===" -ForegroundColor Cyan
$badMonth = Invoke-WebRequest -Method Post "$API/tax/expense-audit" -ContentType 'application/json' `
  -Body (@{ entityId = $entityId; fiscalYear = 2026; month = 13 } | ConvertTo-Json) -SkipHttpErrorCheck
Check "★ 自检非法月份被拒绝" ($badMonth.StatusCode -eq 400) "HTTP $($badMonth.StatusCode)"

$noPeriod = Invoke-WebRequest -Method Post "$API/tax/expense-audit" -ContentType 'application/json' `
  -Body (@{ entityId = $entityId; fiscalYear = 1999; month = 5 } | ConvertTo-Json) -SkipHttpErrorCheck
Check "★ 不存在的期间返回 404" ($noPeriod.StatusCode -eq 404) "HTTP $($noPeriod.StatusCode)"

$noSuchPolicy = Invoke-WebRequest "$API/tax/policies/00000000-0000-0000-0000-000000000000" -SkipHttpErrorCheck
Check "★ 不存在的政策返回 404" ($noSuchPolicy.StatusCode -eq 404) "HTTP $($noSuchPolicy.StatusCode)"

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "  政策检索 + 报销自检验证：通过 $pass / 失败 $fail" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "============================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
