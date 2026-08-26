#!/usr/bin/env bash
# 复述训练场 · GitHub Actions 自动部署脚本（由 Actions 通过 SSH 调用）
set -e

cd /home/Shawn/project/retell-trainer

echo "== git pull =="
git pull --ff-only origin main

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
