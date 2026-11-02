# 视觉出图 SkillHub · 前端雏形

纯前端演示，不接真实 AI 接口；积分为本地模拟（存于浏览器 localStorage）。

## 运行
```bash
npm install
npm run dev      # 打开终端里提示的地址，如 http://localhost:5173
npm run build    # 产物在 dist/
```

## 页面
首页技能卡 · 技能详情 · 上传与参数（主图+最多3张参考图+风格说明）· 生成进度 · 结果（再生成扣积分）· 积分中心 · 我的任务。
上传页勾选「演示失败流程」可看到失败退回积分。

## 真实出图（Codex 后端）
需要本机已登录的 Codex CLI。开两个终端：
```bash
npm run backend   # http://localhost:8787
npm run dev       # http://localhost:5173
```
上传页提交后会请求 `POST /api/generate`（multipart：skillId, styleNote, size, count, main, reference×3），返回 `{jobId, images:[...]}`，图片在 `backend/out/<jobId>/`。后端没开时自动回退为占位结果。生成约需 1–3 分钟。

## 审美 Skills
`skills/` 收录了开源电商出图 Skill 文档（来源与许可见 `skills/ATTRIBUTION.md`）。后端按 `skills/skill-map.json` 为 product / detail / poster 加载对应规范，并与用户风格说明合并后交给 Codex。

## 在旧电脑上临时当服务器
1. 安装 Node.js 20+（https://nodejs.org，或 Linux：`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs`）。
2. 克隆项目后：`npm i`
3. 安装并登录 Codex：`npm i -g @openai/codex`，再 `codex login`（用 ChatGPT 账号登录；登录信息在 `~/.codex/`，切勿提交到 Git）。
4. 查本机局域网 IP（Windows `ipconfig`，Mac/Linux `ip addr` 或 `ifconfig`），比如 `192.168.1.50`。
5. 启动后端：`npm run backend`（端口 8787）
6. 启动前端（任选）：
   - 开发：`VITE_API=http://192.168.1.50:8787 npm run dev`
   - 预览：`VITE_API=http://192.168.1.50:8787 npm run build && npm run preview`（端口 4173）
   Windows PowerShell 用 `$env:VITE_API="http://192.168.1.50:8787"; npm run dev`。
7. 同一局域网的手机/电脑打开 `http://192.168.1.50:5173`（预览为 4173）。防火墙需放行 5173/4173/8787 端口。
8. 电脑不要休眠；本方案仅用于测试，不建议直接暴露到公网。
