# =============================================================================
#  单据导入闭环验证：上传 → 入库 → 识别 → 落发票台账
# =============================================================================
#  这条链路修的是一个具体问题：发票仓库的「去导入单据」点开什么都没有。
#
#  验证的关键点：
#    ① 上传是无损的、幂等的（同一文件不重复入库）
#    ② 识别结果**校验不通过就不落库**（坏数据进台账比不进更危险）
#    ③ 落库后与原件建立关联（凭证册打印要据此带出附件）
#    ④ 同一张票二次识别不重复建票
#    ⑤ 识别失败不丢原件（原件在库里，可随时重试）
# =============================================================================

$ErrorActionPreference = 'Stop'
$API = 'http://localhost:3000/api'
$root = Split-Path -Parent $PSScriptRoot

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host "  [PASS] $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  [FAIL] $name  $detail" -ForegroundColor Red }
}

# ★ `@(Invoke-RestMethod $url)` 会把 JSON 数组当成单个元素包起来，
#   导致 .Count 恒为 1、属性访问变成成员枚举。用 Write-Output -NoEnumerate 才是对的。
function Get-List([string]$url) {
  return @(Write-Output -NoEnumerate (Invoke-RestMethod $url))
}

function Upload-Doc([string]$path, [string]$entityId, [string]$docType) {
  $boundary = [System.Guid]::NewGuid().ToString('N')
  $fileName = [System.IO.Path]::GetFileName($path)
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $LF = "`r`n"
  $head = "--$boundary$LF" +
          "Content-Disposition: form-data; name=`"file`"; filename=`"$fileName`"$LF" +
          "Content-Type: application/pdf$LF$LF"
  $mid = "$LF--$boundary$LF" +
         "Content-Disposition: form-data; name=`"entityId`"$LF$LF$entityId$LF" +
         "--$boundary$LF" +
         "Content-Disposition: form-data; name=`"docType`"$LF$LF$docType$LF" +
         "--$boundary--$LF"
  $hb = [System.Text.Encoding]::UTF8.GetBytes($head)
  $mb = [System.Text.Encoding]::UTF8.GetBytes($mid)
  $body = New-Object byte[] ($hb.Length + $bytes.Length + $mb.Length)
  [Array]::Copy($hb, 0, $body, 0, $hb.Length)
  [Array]::Copy($bytes, 0, $body, $hb.Length, $bytes.Length)
  [Array]::Copy($mb, 0, $body, $hb.Length + $bytes.Length, $mb.Length)
  return Invoke-RestMethod -Method Post "$API/documents/upload" `
    -ContentType "multipart/form-data; boundary=$boundary" -Body $body
}

# 上传一个内容唯一的探针文件（内容不同 → 哈希不同 → 不触发文件级去重）
$script:probeSeq = 0
<#
  构造一个**结构合法**的最小单页 PDF，内容带唯一标记。

  ★ 为什么不能再用 "%PDF probe ..." 这种伪造文本：
    识别链路现在会真的去解析文件 —— pdfjs 取文本层、取不到则用 mupdf 渲染。
    伪造的 PDF 会被正当拒掉（400「这个文件无法作为 PDF 打开」）。
    改造前能过只是因为 mock provider 根本不看文件内容，那是**测不出问题**的假通过。

    这里仍然保证内容唯一（带上序号与随机数），以绕开"同一文件二次上传判重"。
#>
function New-MinimalPdf([string]$path, [string]$marker) {
  $content = "BT /F1 12 Tf 20 60 Td (PROBE $marker) Tj ET"
  $objects = @(
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 150]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    "<</Length $($content.Length)>>`nstream`n$content`nendstream",
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
  )

  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append("%PDF-1.4`n")
  $offsets = @()
  for ($i = 0; $i -lt $objects.Count; $i++) {
    $offsets += $sb.Length
    [void]$sb.Append("$($i + 1) 0 obj`n$($objects[$i])`nendobj`n")
  }
  $xrefPos = $sb.Length
  [void]$sb.Append("xref`n0 $($objects.Count + 1)`n")
  [void]$sb.Append("0000000000 65535 f `n")
  foreach ($o in $offsets) { [void]$sb.Append(('{0:D10} 00000 n ' -f $o) + "`n") }
  [void]$sb.Append("trailer`n<</Size $($objects.Count + 1)/Root 1 0 R>>`nstartxref`n$xrefPos`n%%EOF`n")

  # 全 ASCII，字符下标 == 字节偏移，xref 里的偏移量才对
  [System.IO.File]::WriteAllBytes($path, [System.Text.Encoding]::ASCII.GetBytes($sb.ToString()))
}
function Upload-Probe([string]$entityId, [string]$docType = 'INVOICE_PURCHASE') {
  $script:probeSeq += 1
  $tmp = Join-Path $env:TEMP 'bk-doc-verify'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $f = Join-Path $tmp "probe-$($script:probeSeq)-$(Get-Random).pdf"
  New-MinimalPdf $f "probe-$($script:probeSeq)-$(Get-Random)"
  return Upload-Doc $f $entityId $docType
}
Write-Host "`n=== 0. 准备 ===" -ForegroundColor Cyan
$entityId = (Invoke-RestMethod "$API/entities")[0].id
Write-Host "  主体：$entityId"

# 造两个**结构合法**且内容不同的 PDF（内容不同 → 哈希不同 → 不触发去重）
$tmp = Join-Path $env:TEMP 'bk-doc-verify'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$fake1 = Join-Path $tmp 'invoice-a.pdf'
$fake2 = Join-Path $tmp 'invoice-b.pdf'
New-MinimalPdf $fake1 "invoice-a-$(Get-Date -Format o)"
New-MinimalPdf $fake2 "invoice-b-$(Get-Date -Format o)"

# 清掉上次运行留下的测试发票与单据
$existingInvoices = Get-List "$API/invoices?entityId=$entityId&pageSize=200"
$testNums = @('RECOG-TEST-001', 'RECOG-TEST-002')
foreach ($inv in $existingInvoices.items) {
  if ($testNums -contains $inv.invoiceNumber) {
    # 发票没有删除接口，用 mark-posted 之外的方式不可行，这里只统计不删
  }
}

Write-Host "`n=== 1. 上传入库（无损 + 幂等） ===" -ForegroundColor Cyan
$up1 = Upload-Doc $fake1 $entityId 'INVOICE_PURCHASE'
Check "上传成功并返回 documentId" ($null -ne $up1.documentId)
Check "标记为非重复" ($up1.duplicated -eq $false)

$up1again = Upload-Doc $fake1 $entityId 'INVOICE_PURCHASE'
Check "★ 同一文件二次上传被判为重复" ($up1again.duplicated -eq $true)
Check "★ 重复上传返回同一个 documentId" ($up1again.documentId -eq $up1.documentId) "旧=$($up1.documentId) 新=$($up1again.documentId)"
Check "★ 重复上传给出中文说明" ($up1again.message -like '*已于*入库*') $up1again.message

Write-Host "`n=== 2. 识别 → 校验 → 落库（正常票） ===" -ForegroundColor Cyan
# ★ 用探针文件而不是固定文件：Mock 样例的发票号码是固定的，
#   若用 $up1（同一份文件）跑两遍，第二遍必然命中"已存在"。
#   这里要验证的是"首次识别能落库"，所以每次都用内容唯一的文件。
$probe = Upload-Probe $entityId
$res1 = Invoke-RestMethod -Method Post "$API/documents/$($probe.documentId)/recognize" `
  -ContentType 'application/json' -Body (@{
    entityId = $entityId
    mockCase = 'purchase-office-supplies'
  } | ConvertTo-Json)
Check "识别返回了状态" ($null -ne $res1.status) "status=$($res1.status)"
# 该样例的号码可能已被别的测试写入过，所以接受 SAVED 或 DUPLICATE，
# 关键是"拿到了 invoiceId"与"原件被关联"
Check "★ 票已进台账（SAVED 或已存在）" ($res1.status -eq 'SAVED' -or $res1.status -eq 'DUPLICATE') `
  "status=$($res1.status) msg=$($res1.message)"
Check "★ 返回了 invoiceId" ($null -ne $res1.invoiceId)
Check "返回了抽取到的票面数据" ($null -ne $res1.extracted.invoiceNumber)
Check "返回了下一步指引" ($res1.nextSteps.Count -gt 0)

$inv = Invoke-RestMethod "$API/invoices/$($res1.invoiceId)"
Check "★ 发票台账里能查到" ($null -ne $inv.id)
if ($res1.status -eq 'SAVED') {
  Check "★ 发票关联了原始单据（凭证册打印据此带附件）" ($inv.documentId -eq $probe.documentId) `
    "documentId=$($inv.documentId) 期望=$($probe.documentId)"
} else {
  Check "★ 已存在的票保留原有原件关联" ($null -ne $inv.documentId) "documentId=$($inv.documentId)"
}
Check "★ 发票方向正确（进项）" ($inv.direction -eq 'INPUT') "实际 $($inv.direction)"
Check "★ 价税合计已落库" ($null -ne $inv.amountInclTax)

Write-Host "`n=== 3. ★ 同一份文件二次识别不重复建票 ===" -ForegroundColor Cyan
$res1again = Invoke-RestMethod -Method Post "$API/documents/$($probe.documentId)/recognize" `
  -ContentType 'application/json' -Body (@{
    entityId = $entityId
    mockCase = 'purchase-office-supplies'
  } | ConvertTo-Json)
Check "★ 判为已存在（不重复建票）" ($res1again.status -eq 'DUPLICATE') "status=$($res1again.status)"
Check "★ 返回的是同一个 invoiceId" ($res1again.invoiceId -eq $res1.invoiceId) `
  "旧=$($res1.invoiceId) 新=$($res1again.invoiceId)"
Check "★ 说明里点明了未重复创建" ($res1again.message -like '*未重复创建*') $res1again.message

Write-Host "`n=== 4. ★★ 金额勾稽错的票：拒绝落库 ===" -ForegroundColor Cyan
$up2 = Upload-Doc $fake2 $entityId 'INVOICE_PURCHASE'
Check "第二份文件入库成功（内容不同）" ($up2.duplicated -eq $false)

$resBad = Invoke-RestMethod -Method Post "$API/documents/$($up2.documentId)/recognize" `
  -ContentType 'application/json' -Body (@{
    entityId = $entityId
    mockCase = 'amount-mismatch'
  } | ConvertTo-Json)
Check "★ 金额勾稽错的票被拒绝落库" ($resBad.status -eq 'REJECTED') "status=$($resBad.status)"
Check "★ invoiceId 为空（确实没建票）" ($null -eq $resBad.invoiceId)
Check "★ 校验结论里有 FAIL 项" ($resBad.validation.hasFailure -eq $true)
Check "★ 说明里解释了为什么拒绝" ($resBad.message -like '*未写入发票台账*') $resBad.message
Check "★ 给出了挽救路径（可强制落库）" (($resBad.nextSteps -join ' ') -like '*强制落库*') ($resBad.nextSteps -join ' | ')
Check "识别结果仍然返回（便于人工核对）" ($null -ne $resBad.extracted.amountInclTax)

# 确认台账里真的没有这张票
$afterBad = Invoke-RestMethod "$API/invoices?entityId=$entityId&pageSize=200"
$badNum = "$($resBad.extracted.invoiceNumber)"
$found = @($afterBad.items | Where-Object { $_.invoiceNumber -eq $badNum })
Check "★★ 台账里确实查不到这张被拒的票" ($found.Count -eq 0) "找到 $($found.Count) 条（号码 $badNum）"

Write-Host "`n=== 5. ★ force 能绕过什么、不能绕过什么 ===" -ForegroundColor Cyan
# force 的语义是"人工已核对票面，允许越过识别阶段的校验门"。
# 但**金额勾稽不可绕过** —— 它是数据完整性约束，不是识别质量问题。
# 一张 1000 + 60 ≠ 1090 的票进台账，会污染进项抵扣统计。
$forceBad = Invoke-WebRequest -Method Post "$API/documents/$($up2.documentId)/recognize" `
  -ContentType 'application/json' -Body (@{
    entityId = $entityId; mockCase = 'amount-mismatch'; force = $true
  } | ConvertTo-Json) -SkipHttpErrorCheck
Check "★★ force 也绕不过金额勾稽（返回 400）" ($forceBad.StatusCode -eq 400) "HTTP $($forceBad.StatusCode)"
$fbObj = $forceBad.Content | ConvertFrom-Json
Check "★★ 拒绝理由说清了差额是多少" ($fbObj.userMessage -like '*差异*') $fbObj.userMessage

# ★★ 方向无法判定：购销双方都不是本主体、模型也没给方向 → 必须拒绝，绝不猜
$dirProbe = Upload-Probe $entityId
$forceDir = Invoke-RestMethod -Method Post "$API/documents/$($dirProbe.documentId)/recognize" `
  -ContentType 'application/json' -Body (@{
    entityId = $entityId; mockCase = 'no-direction'
  } | ConvertTo-Json)
Check "★★ 方向无法判定时拒绝落库" ($forceDir.status -eq 'REJECTED') "status=$($forceDir.status)"
Check "★★ 确实没建票" ($null -eq $forceDir.invoiceId)
Check "★★ 拒绝理由说明了猜方向的后果" ($forceDir.message -like '*虚增收入和销项税*') $forceDir.message
Check "★ 给出了可操作的挽救路径" (($forceDir.nextSteps -join ' ') -like '*人工确认*') ($forceDir.nextSteps -join ' | ')
Check "★ 校验码为 D1（方向类）" (@($forceDir.validation.findings | Where-Object { $_.code -eq 'D1' }).Count -eq 1)

# force 也不能让系统去猜方向 —— 方向不是"识别质量问题"，而是"事实缺失"
$forceDir2 = Invoke-RestMethod -Method Post "$API/documents/$($dirProbe.documentId)/recognize" `
  -ContentType 'application/json' -Body (@{
    entityId = $entityId; mockCase = 'no-direction'; force = $true
  } | ConvertTo-Json)
Check "★★ force 也无法让系统猜方向" ($null -eq $forceDir2.invoiceId) "invoiceId=$($forceDir2.invoiceId)"

Write-Host "`n=== 6. ★ 校验不通过不丢原件 ===" -ForegroundColor Cyan
$docs = Get-List "$API/documents?entityId=$entityId&pageSize=200"
$stillThere = $null
foreach ($d in $docs.items) { if ($d.id -eq $up2.documentId) { $stillThere = $d } }
Check "★★ 被拒的文件原件仍在仓库里" ($null -ne $stillThere)
Check "★ 原件可下载" ($null -ne $stillThere.id)
$fileResp = Invoke-WebRequest "$API/documents/$($up2.documentId)/file" -SkipHttpErrorCheck
Check "★ 取原件返回 200" ($fileResp.StatusCode -eq 200) "HTTP $($fileResp.StatusCode)"

Write-Host "`n=== 7. 识别失败不阻断入库 ===" -ForegroundColor Cyan
$up3 = Upload-Doc $fake2 $entityId 'BANK_SLIP'
Check "银行回单类型可入库" ($null -ne $up3.documentId)
$resSlip = Invoke-RestMethod -Method Post "$API/documents/$($up3.documentId)/recognize" `
  -ContentType 'application/json' -Body (@{
    entityId = $entityId
    targetType = 'BANK_SLIP'
  } | ConvertTo-Json)
Check "★ 非发票目标不落发票台账" ($null -eq $resSlip.invoiceId)
Check "★ 状态为待人工复核" ($resSlip.status -eq 'NEEDS_REVIEW') "status=$($resSlip.status)"
Check "★ 说明了这类单据该走哪条流程" ($resSlip.message -like '*不落发票台账*') $resSlip.message

Write-Host "`n=== 8. 错误处理的可用性 ===" -ForegroundColor Cyan
$notFound = Invoke-WebRequest -Method Post "$API/documents/00000000-0000-0000-0000-000000000000/recognize" `
  -ContentType 'application/json' -Body (@{ entityId = $entityId } | ConvertTo-Json) -SkipHttpErrorCheck
$nfObj = $notFound.Content | ConvertFrom-Json
Check "★ 不存在的单据返回 404" ($notFound.StatusCode -eq 404) "HTTP $($notFound.StatusCode)"
Check "★ 错误提示是中文且说明原因" ($nfObj.userMessage -like '*不存在*') $nfObj.userMessage

$noEntity = Invoke-WebRequest -Method Post "$API/documents/$($up1.documentId)/recognize" `
  -ContentType 'application/json' -Body (@{} | ConvertTo-Json) -SkipHttpErrorCheck
Check "★ 缺 entityId 被拒绝" ($noEntity.StatusCode -eq 400) "HTTP $($noEntity.StatusCode)"

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "  单据导入闭环验证：通过 $pass / 失败 $fail" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "============================================`n" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
