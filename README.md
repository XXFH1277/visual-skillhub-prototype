# 出图工作台（视觉 SkillHub）

给商家用的 AI 出图入口：上传原图 → 写几句卖点 → 选风格 → **AI 策划** → 确认文字 → 出图。

## 怎么用

1. 选场景：商品图 / 详情页 / 海报 / 装修效果
2. 上传原图（海报可不传），可加 1–3 张风格参考图
3. 随便写文案或卖点，选风格标签
4. 点 **AI 策划**：Kimi 看原图、润色文案，给每张图规划画面、文字和位置，页面上实时预览版式
5. 改字、换位置、选“AI 画字”或“精确排字”——这些都免费；点 **确认出图** 才扣积分
6. 出图后 Kimi 自动校对图里的字，不一致会标出来，可单张重出或改用精确排字

## 文字怎么保证准确

| 方式 | 适合 | 原理 |
|---|---|---|
| AI 画字 | 主标题、短卖点 | 把确认后的文字用真实字体排成**版式稿**，作为附件和原图一起发给 GPT 生图，让它照着字形写；出图后再由 Kimi 校对 |
| 精确排字 | 价格、日期、地址、菜单、长句 | 让 GPT 出一张留白的图，程序把字排上去，一字不差，之后改字免费 |
| 详情页 | 每屏 | 标题可选 AI 画字或精确排字；说明文字始终由程序排在图下，可免费改 |

## Skills 的用法

`skills/runtime/*/SKILL.md` 是四个场景的策划指南，连同归档 skill 里的光线、材质、构图、品类打法章节，**只交给 Kimi 阅读**（见 `backend/planner.js`）。
Kimi 据此写出每张图的具体画面描述；发给生图模型的是一段短而具体的生产简报（`backend/prompts.js`），不再塞方法论原文。

## 运行（Windows）

需要 Node.js 22.13+（推荐 24 LTS）。

1. 复制 `.env.example` 为 `.env`，填 `IMAGE_API_KEY`（中转站）和 `KIMI_API_KEY`
2. 双击 **启动工作台.bat**：第一次会自动安装依赖并构建，然后打开 http://localhost:8787
3. 窗口里会显示访问码（也保存在 `.data\access-code.txt`）

命令行方式：`npm ci && npm run build && npm start`；开发时 `npm run backend` + `npm run dev`；测试 `npm test`。

没配 Kimi 时：有本机 Codex 就用 Codex 临时策划，否则按原文生成基础方案，可手动修改。

## 配置

| 变量 | 说明 |
|---|---|
| `IMAGE_API_BASE_URL` / `IMAGE_API_KEY` | 中转站地址与密钥 |
| `IMAGE_API_MODEL_2K` / `IMAGE_API_MODEL_4K` | 出图模型 / 4K 提升模型 |
| `GENERATION_PROVIDER` | `api`（中转站）或 `codex`（本机 Codex） |
| `KIMI_API_BASE_URL` / `KIMI_API_KEY` / `KIMI_MODEL` | Kimi，需支持看图的模型，如 `kimi-k3` |
| `PORT` / `ACCESS_CODE` / `PUBLIC_ORIGIN` | 端口 / 访问码 / 公网地址（Cloudflare 隧道，见 `scripts/start.ps1 -Public`） |

## 目录

- `src/` 前端（单页，无框架）
- `shared/scenes.js` 场景、版式、文字类型（前后端共用）
- `backend/planner.js` 策划提示词、方案校验与基础方案
- `backend/text-ai.js` Kimi 客户端（策划 + 文字校对），Codex 回退
- `backend/render.js` 版式稿、精确排字、详情页说明栏
- `backend/prompts.js` 每张图发给生图模型的简报
- `backend/app.js` 草稿 → 任务 → 校对 → 交付的接口；积分、队列、登录沿用原实现
