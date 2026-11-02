# 出图工作台（视觉 SkillHub）

给商家用的 AI 出图入口：上传原图 → 写几句卖点 → 选风格 → **AI 策划** → 确认文字 → 出图。

## 怎么用

1. **风格库**（可选）：按品类 / 图片类型 / 调性挑一个样子，点“用它做…”；看到好图就“上传好图”，可附提示词，Kimi 会拆成可复用的配方（只在自己工作台可见）
2. **出图**：选场景（商品图 / 详情页 / 海报 / 装修）→ 上传商品图，可加“照这个感觉做”的参考图 → 一句话说明（可不写）→ 选张数
3. **AI 出方案**：Kimi 看图分析，从风格库挑 3 个方向，并改造成专属这件商品的创意方案（概念、色板、道具、光、排版）
4. **选方向 → AI 写分镜**：每张图的画面、排版与文字；改字免费，**确认后才扣积分**
5. **出图**：每张带上商品图、参考图、风格样图和简报；字由模型画进图里，出图后 Kimi 校对，不一致可单张重出或改用“精确排字”
6. 详情页按 3:4 竖版分屏直出，自动拼成 750px 宽长图

## 风格库

- 内置 32 个配方（`shared/styles.js`），按品类、图片类型、调性分类；上传的风格存 SQLite，图片在 `.data/styles/`
- 内置风格的封面样图通过“生成样图”走正常出图流程（扣积分），完成后自动成为封面，之后用这个风格出图时会作为风格参考附上
- 从外部收集的图只做私人参考；要进公共库的风格，用我们自己生成的样图做封面

## Skills 的用法

`skills/runtime/*/SKILL.md` 是四个场景的分镜指南，连同归档 skill 里的光线、材质、构图、品类章节，**只交给 Kimi 阅读**（`backend/planner.js`）。
发给生图模型的是短而具体的简报（`backend/prompts.js`）：附件角色 + 视觉系统 + 这一张的画面 + 逐字文字。

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
- `shared/styles.js` 风格库内置配方与分类
- `backend/styles.js` 风格库存储（上传、拆解、封面）
- `backend/planner.js` 看图出方向、写分镜的提示词与校验
- `backend/text-ai.js` Kimi 客户端（方向、分镜、风格拆解、文字校对），Codex 回退
- `backend/render.js` 精确排字
- `backend/prompts.js` 每张图发给生图模型的简报
- `backend/app.js` 草稿 → 任务 → 校对 → 交付的接口；积分、队列、登录沿用原实现
