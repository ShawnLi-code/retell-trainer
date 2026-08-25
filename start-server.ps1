# 复述训练场：静默启动脚本（计划任务 / 开机自启用）
# 已运行则不重复启动
if (Get-NetTCPConnection -LocalPort 3025 -State Listen -ErrorAction SilentlyContinue) { exit }
Set-Location $PSScriptRoot
node --env-file-if-exists=.env server.js
