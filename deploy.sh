#!/usr/bin/env bash
# 复述训练场 · 自动部署脚本（GitHub Webhook / Actions 调用）
set -e

cd /home/Shawn/project/retell-trainer

echo "== git pull（github 直连不稳定，重试最多 4 次）=="
pull_ok=0
for i in 1 2 3 4; do
  if git pull --ff-only origin main; then pull_ok=1; break; fi
  echo "  拉取失败（第 ${i} 次），3 秒后重试…"
  sleep 3
done
if [ "$pull_ok" != "1" ]; then
  echo "== git pull 连续失败，中止本次部署（服务保持运行）=="
  exit 1
fi

# 依赖文件有变更才重新安装
if git diff --quiet HEAD~1 HEAD -- package.json package-lock.json; then
  echo "== 依赖无变化，跳过 npm install =="
else
  echo "== npm install =="
  npm install --no-audit --no-fund --loglevel=error
fi

echo "== restart 服务 =="
systemctl restart retell-trainer
sleep 2
systemctl is-active retell-trainer

echo "== 完成 =="
git log --oneline -1
