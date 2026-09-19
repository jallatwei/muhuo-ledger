<#
.SYNOPSIS
  从 deploy/env/.env.dev 生成本地 apps/api/.env，供宿主机直接运行 Prisma 命令使用。

.DESCRIPTION
  容器内的 API 通过 compose 注入环境变量，不需要 .env 文件。
  但在宿主机上执行 prisma migrate / prisma studio / seed 时，
  需要把 DATABASE_URL 的主机名从容器内的 postgres 改成 localhost:5433。

  本脚本只做这一件事：读模板 → 改写主机名 → 写 apps/api/.env。
  生成的 .env 已在 .gitignore 中，不会入库。
#>
[CmdletBinding()]
param(
  [string]$SourceEnv = 'deploy/env/.env.dev',
  [string]$TargetEnv = 'apps/api/.env'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  if (-not (Test-Path $SourceEnv)) {
    if (Test-Path 'deploy/env/.env.dev.example') {
      Write-Host "[i] 未找到 $SourceEnv，正在从模板创建..." -ForegroundColor Yellow
      New-Item -ItemType Directory -Force -Path (Split-Path $SourceEnv) | Out-Null
      Copy-Item 'deploy/env/.env.dev.example' $SourceEnv
    } else {
      throw "找不到 $SourceEnv，也找不到模板 deploy/env/.env.dev.example"
    }
  }

  $lines = Get-Content $SourceEnv -Encoding UTF8
  $out = New-Object System.Collections.Generic.List[string]

  foreach ($line in $lines) {
    if ($line -match '^\s*DATABASE_URL\s*=\s*(.+)$') {
      $url = $Matches[1].Trim()
      # 容器内主机名 postgres:5432  ->  宿主机 localhost:5433
      $hostPort = '5433'
      foreach ($l in $lines) {
        if ($l -match '^\s*POSTGRES_HOST_PORT\s*=\s*(\d+)') { $hostPort = $Matches[1] }
      }
      $url = $url -replace '@postgres:5432', "@localhost:$hostPort"
      $out.Add("DATABASE_URL=$url")
      continue
    }
    $out.Add($line)
  }

  $out | Set-Content -Path $TargetEnv -Encoding UTF8
  Write-Host "[OK] 已生成 $TargetEnv" -ForegroundColor Green
  $dbLine = $out | Where-Object { $_ -match '^DATABASE_URL=' }
  Write-Host "     $dbLine" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "接下来（需先启动 Docker Desktop 与数据库容器）：" -ForegroundColor Cyan
  Write-Host "  docker compose -f docker/dev/docker-compose.yml --env-file $SourceEnv up -d postgres"
  Write-Host "  pnpm --filter @bookkeeper/api prisma:migrate"
  Write-Host "  pnpm --filter @bookkeeper/api seed"
}
finally {
  Pop-Location
}
