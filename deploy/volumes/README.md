# 运行时数据卷

本目录用于**本地裸机运行**（不用 Docker）时存放运行时数据。
使用 Docker 时数据存放在命名卷里，与本目录无关。

```
deploy/volumes/
├── attachments/     原始单据文件（发票图片、PDF、回单）—— 含敏感数据，禁止入库
├── backups/         pg_dump 备份文件
└── logs/            应用日志
```

`.gitignore` 已排除本目录下的所有内容，只保留本说明与 `.gitkeep`。

## 备份

```bash
# 数据库备份（在宿主机执行）
docker compose -f docker/dev/docker-compose.yml exec -T postgres \
  pg_dump -U bookkeeper -d bookkeeper_dev --format=custom \
  > deploy/volumes/backups/bookkeeper_$(date +%Y%m%d_%H%M%S).dump

# 恢复
docker compose -f docker/dev/docker-compose.yml exec -T postgres \
  pg_restore -U bookkeeper -d bookkeeper_dev --clean --if-exists \
  < deploy/volumes/backups/xxx.dump
```

> ⚠️ **备份必须同时包含数据库和 `attachments` 卷**。
> 只备份数据库会导致凭证册打印不出附件——账有了，票没了。
