#!/bin/bash
# 出图工作台 · Mac 启动：在“访达”里双击这个文件。
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 22.13 或更高版本（推荐 24 LTS）：https://nodejs.org/zh-cn"
  read -r -p "按回车关闭" _; exit 1
fi
ver=$(node -p 'process.versions.node.split(".").map(Number).reduce((a,b,i)=>i<2?a*1000+b:a)')
if [ "$ver" -lt 22013 ]; then
  echo "当前 Node.js 版本太低（需要 22.13 或更高，推荐 24 LTS）：https://nodejs.org/zh-cn"
  read -r -p "按回车关闭" _; exit 1
fi

# 依赖有变化（更新代码后）才重新安装
if [ ! -d node_modules/sharp ] || ! cmp -s package-lock.json node_modules/.skillhub-lock; then
  echo "正在安装/更新依赖，大约 1-3 分钟……"
  npm ci || { read -r -p "安装失败，按回车关闭" _; exit 1; }
  cp package-lock.json node_modules/.skillhub-lock
fi
npm run build || { read -r -p "构建失败，按回车关闭" _; exit 1; }
[ -f .env ] || cp .env.example .env

echo
echo "正在启动，浏览器会自动打开 http://localhost:8787 （关掉这个窗口就停止）"
echo
(sleep 4; open http://localhost:8787) &
node --env-file-if-exists=.env backend/server.js
