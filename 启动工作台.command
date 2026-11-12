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

# 第一次用：在这里粘贴中转站 key，自动写进 .env（只存在这台电脑上）
set_env() { # $1 = 变量名, $2 = 值（写进 .env，已有就替换）
  NAME="$1" VAL="$2" node -e '
    const fs = require("fs");
    const { NAME, VAL } = process.env;
    const line = NAME + "=" + VAL.trim();
    let t = fs.readFileSync(".env", "utf8");
    const re = new RegExp("^#?\\s*" + NAME + "=.*$", "m");
    fs.writeFileSync(".env", re.test(t) ? t.replace(re, () => line) : t.replace(/\n*$/, "\n") + line + "\n");'
}
ask_key() { # $1 = 变量名, $2 = 说明
  grep -qE "^$1=.+" .env && return
  echo
  read -r -s -p "请粘贴【$2】的 key（粘贴后看不到字是正常的），然后按回车：" KEY; echo
  [ -z "$KEY" ] && return
  set_env "$1" "$KEY"
  unset KEY
  echo "已保存。"
}
ask_key IMAGE_API_KEY "生图（GPT image）"
ask_key KIMI_API_KEY "Kimi"

# 第二个生图通道（可选）：只问一次。以后想改，删掉 .env 里 IMAGE_API_SECONDARY_KEY 那一行再启动。
if ! grep -qE "^IMAGE_API_SECONDARY_KEY=" .env; then
  echo
  echo "可以再加一个生图通道（第二个 key），两个通道一起出图。"
  read -r -s -p "请粘贴【第二个生图 key】（不用就直接按回车）：" KEY2; echo
  if [ -n "$KEY2" ]; then
    MAIN_URL=$(grep -E "^IMAGE_API_BASE_URL=" .env | head -1 | cut -d= -f2-)
    read -r -p "第二个 key 的中转站地址（和第一个一样就直接回车，第一个是 ${MAIN_URL}）：" URL2
    set_env IMAGE_API_SECONDARY_BASE_URL "${URL2:-$MAIN_URL}"
    set_env IMAGE_API_SECONDARY_KEY "$KEY2"
    echo "第二个通道已保存。"
  else
    set_env IMAGE_API_SECONDARY_KEY ""
    echo "先不加。"
  fi
  unset KEY2
fi

echo
echo "正在启动，浏览器会自动打开 http://localhost:8787 （关掉这个窗口就停止）"
echo
(sleep 4; open http://localhost:8787) &
node --env-file-if-exists=.env backend/server.js
