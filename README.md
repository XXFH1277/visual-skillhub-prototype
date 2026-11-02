# 视觉出图 SkillHub

一个在本机运行、可通过带访问码的入口分享给可信成员的视觉工作台。
目前是**单个共享工作台**，不是多用户 SaaS；持有访问码的成员共享任务、素材和测试积分。

本轮累计更新见 [更新记录](CHANGELOG.md)。

## 已实现

- 产品图、海报、空间效果图，以及 2–6 模块的详情页。
- 上传图片内容校验、尺寸与文件大小限制，PNG/JPEG/WebP 统一规范化。
- 真实 Codex CLI 生成；失败明确报错，不再返回占位图假装成功。
- SQLite 持久化任务、参考素材关系、积分流水、登录会话与导出清单。
- 单任务串行队列，最多 5 个排队/运行任务；重复提交不会重复扣费。
- 失败、取消或重启中断后退回测试积分；重新生成实际创建新任务。
- 每个任务独立目录，结果只取本任务的明确输出，不扫描共享图片目录。
- 详情页由 AI 生成无字底图，由 sharp 排版确认过的文案；支持免费改文案、下载模块图与长图。
- 受登录保护的原图与结果访问；日志、访问码和数据库不通过静态目录公开。
- 同源 `/api`，桌面与手机布局，无需给访问者配置 localhost 地址。

## 环境与运行

需要 Node.js **24+** 和 npm。使用 Codex 模式时需安装并登录 Codex CLI；仅使用中转 API 时需配置相应环境变量。

```powershell
npm ci
codex login status
# 未登录时在本机运行 codex login
npm run build
npm start
```

打开 http://localhost:8787。第一次启动自动创建随机访问码：

```text
.data/access-code.txt
```

在网页中输入该文件里的访问码。不要把 `.data` 上传到 GitHub。
也可通过 `.env` 中的 `ACCESS_CODE` 设置至少 16 字符的访问码；改变访问码会使旧会话失效。

开发时打开两个终端，分别执行 `npm run backend` 和 `npm run dev`；Vite 将 `/api` 代理到后端。
前端不再使用 `VITE_API`，生产环境由后端直接服务 `dist`。

Windows 后台启动与停止：

```powershell
.\scripts\start.ps1
.\scripts\stop.ps1
```

脚本启动隐藏窗口，记录进程 ID、启动时间与可执行文件路径；停止时核对身份，避免误停其他进程。
停止时会终止本工作台的子进程树；未完成任务下次启动后退回测试积分。
启动多个后端实例共用同一个 `.data` **不受支持**，请只运行一个实例。

## 临时公网

仅在确认愿意通过 Cloudflare 分享这个私人工作台后运行：

```powershell
.\scripts\stop.ps1
.\scripts\start.ps1 -Public -Cloudflared 'D:\服务器\tools\cloudflared.exe'
```

它使用 Quick Tunnel 获得 HTTPS 地址，在启动网站前设置精确的 `PUBLIC_ORIGIN`，启用 Secure 登录 Cookie。
服务仍只监听本机 `127.0.0.1`，不需要开放 Windows 入站端口或路由器端口转发。
脚本打印公网 URL，不打印访问码。公网 URL 另存于 `.data/public-url.txt`。
启动脚本会通过公网检查当前服务器实例，只有检查成功才报告公网地址；仅获得域名不算启动成功。

本机启用 Meta/TUN 代理时，曾出现节点被解析成 `198.18.*` 虚拟地址、隧道 TLS 握手中断的问题。
本次通过指定物理网卡出站地址和独立 HTTPS DNS 查询解决，无需修改系统代理或防火墙：

```powershell
.\scripts\start.ps1 -Public -EdgeBindAddress '192.168.31.36' -ResolveEdgeViaHttps
```

重启前先运行停止脚本；若本机局域网 IP 变化，请更新 `EdgeBindAddress`。
`ResolveEdgeViaHttps` 每次从 Cloudflare DNS 查询当前节点，并传入 cloudflared 的内部 `--edge` 参数。
这是针对此环境的兼容方式；升级 cloudflared 后需重新验证。普通网络优先使用不带这两个参数的标准启动命令。

访问者必须输入访问码才能查看任务或生成图片。请只分享给可信成员，访问码持有者可以消耗本机 Codex 账户的用量。
URL 随隧道重新建立而变化；关机、休眠、停止脚本或网络中断会影响可用性。Quick Tunnel 不承诺稳定服务。
本项目使用短请求与轮询，不依赖 SSE 或持续数分钟的 HTTP 生成连接。

[Cloudflare 官方 Quick Tunnel 文档](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## 配置

### 专用 Skills 与生成计划

四个入口通过 `backend/skill-workflow.js` 显式路由并加载网站专用 Skill：

| 入口 | 实际加载 | 专用流程 |
|---|---|---|
| 商品图 | `skills/runtime/product/SKILL.md` + 电商驱动力、光照、保真参考章节 | 主图 / 细节 / 场景或套图，商品保留项、受众与确认短文案 |
| 详情页 | `skills/runtime/detail/SKILL.md` + 商品分析、画面配方、所选品类章节 | 按已填事实建议 2–6 个模块，用户编辑画面任务与文案，逐模块生底图并排版 |
| 海报 | `skills/runtime/poster/SKILL.md` + 构图参考章节 | 活动 / 品牌 / 促销 / 菜单的文案层级和版式 |
| 装修 | `skills/runtime/interior/SKILL.md`（原创） | 房间类型、改造范围、保留与变更清单、材质、光照；固定现状结构与视角 |

这是项目内显式加载的 Skills，不是安装到全局 Codex 后依赖模型自行发现。
每次创建任务时保存私有 `skill-context.json`，记录完整规则、参考章节、SHA-256 和逐张计划；开始生成前验证快照，缺失或变更会失败，不继续计费请求。
Codex 接收并按 `prompt-N.txt` 的完整规则生成；中转 API 将相同提示词和附件传入 Images 请求。`skill-execution.json` 保存提示词哈希与准备阶段，文件本身不通过网站公开。
任务页和交付清单显示 Skill 版本、来源与原始逐张计划。旧任务没有这些记录，不追补为“已经使用新 Skill”。重新生成创建新任务，按当前 Skill 重新建立快照；原任务不变。
详情页免费改文案只更新排版，不改变原始生成计划或底图；要改变画面需重新生成。
计划由规则和表单编排，未增加独立多模态分析或文本模型调用；图片模型在生成时读取附件。已加载规则不等于图像完全遵循，结构、商品身份与文字仍需人工验收。
4K 提升保持独立的保真指令，不套用创作 Skill 重新设计画面。

### Codex / 中转生图 API 切换

海报模式使用独立的「海报文案与版式」表单：促销 / 活动 / 品牌 / 菜单类型，必填主标题，选填副标题、正文或菜单条目、价格优惠、行动文案、落款时间地址，以及自动 / 上文下图 / 左右分区 / 字体海报版式。
这些字段要求直接出现在海报画面中，风格说明只控制视觉方向。默认竖版 3:4、单张；素材可选，因此也支持纯文字 / 图形海报。
有素材时调用图片编辑接口，无素材时调用 `/v1/images/generations`；Codex 使用同一份海报图文规则。
海报文字由图片模型绘制，结果页保存原文供逐项核对，未实现 OCR 校对或免费改字重排。

首页「生成方式」可保存共享工作台的默认模式；新建任务的右侧也可单独选择。
每个任务保存自己的模式、模型与请求尺寸，切换默认模式不会改变已提交任务。
旧任务仍按 Codex 处理，重新生成默认沿用来源任务模式。没有自动跨服务回退或自动重试收费请求。

在本机 `.env` 设置 `IMAGE_API_BASE_URL`、`IMAGE_API_KEY` 和 `GENERATION_PROVIDER=api`，然后运行
`./scripts/restart-server.ps1` 可重启应用并保留正在运行的临时隧道网址。
密钥仅在后端读取；不要使用 `VITE_` 环境变量，也不要把 `.env` 提交到 GitHub。

当前接入为 `/v1/images/edits`：上传主图与参考图，显式发送 `response_format=b64_json`。
1K / 2K 与 4K 的模型由后端 `IMAGE_API_MODEL_2K` / `IMAGE_API_MODEL_4K` 强制映射，浏览器不能绕过分辨率规则。
本机按中转站更新后的目录配置为 `gpt-image-2.5-sunburst` 和用户确认的 `gpt-image-2.0`（4K 超分路线）。
旧别名 `gpt-image-2.5`、`gpt-image-2-4K` 已从当前模型列表移除；历史任务仍保留当时使用的真实模型名。
新生成的 4K 选项采用 16:9、3840×2160。方形和 3:4 新生成提供 1K / 2K。
分辨率属于请求目标，不保证中转站按该尺寸返回。API 成图保留实际像素；若不匹配，结果页及交付清单会明确提示。
详情页仍按 750px 宽排版，额外保留可下载的 API 原始底图。

结果图下面的「提升至 4K」会将**当前结果图**作为输入，固定调用已配置的 2.0 4K 模型，创建独立任务。
原图与来源导出版本保留；单张提升消耗 10 个本站测试积分，失败或取消退回。
提升请求使用 `size=auto` 保留原图比例，并在提示词中指定 4K 目标（16:9 为 3840×2160，其余按长边 4096 计算）。
这是生成式清晰度提升，模型仍可能改变商品细节；返回结果必须按真实尺寸与外观检查。
本站退款不等于中转站退款，请以中转站账单为准。

最新实测：`gpt-image-2.5-sunburst` 水瓶参考图成功，耗时约 174 秒，请求与实际尺寸均为 **2048×2048**。
随后以该图调用 `gpt-image-2.0` 提升至 4K，约 145 秒后发生连接或响应处理失败，**尚未得到真实 4K 结果**；2K 原图未改变。
初始旧别名 `gpt-image-2.5` 曾在约 32 秒返回 1254×1254，旧 `gpt-image-2-4K` 曾返回 502；模型目录更新后旧别名返回 404。
新模型最初返回了适配器未接受的格式；显式请求 `response_format=b64_json` 后完成了上述真实 2K 验证。
网站保留实测历史、实际尺寸和失败退款记录，未将失败或软件放大图片冒充 4K。
异常响应保存在任务目录 `api-response-*.json`（如有），网络/处理错误的无密钥诊断保存在 `api-failure.json`，均不通过网站提供下载。
多模态 Kimi 密钥暂未接入：本次生图编辑接口直接接收参考图，未额外调用多模态分析。

[兼容图片编辑协议](https://developers.openai.com/api/reference/resources/images/methods/edit)
与 [尺寸参数说明](https://developers.openai.com/api/docs/guides/image-prompting) 用于协议参考；中转站别名及实际行为以实测为准。

可复制 `.env.example` 为 `.env`：

| 变量 | 用途 |
|---|---|
| `PORT` | `npm start` 端口，默认 8787；后台脚本默认使用 8787 |
| `ACCESS_CODE` | 私人共享工作台访问码；未设置时自动创建文件 |
| `PUBLIC_ORIGIN` | 精确 HTTPS 来源，例如 `https://example.trycloudflare.com` |
| `CODEX_BIN` | 可选的 Codex 原生可执行文件或 `codex.js` 完整路径；不接受 `.cmd` 外壳 |
| `GENERATION_TIMEOUT_MS` | 每任务超时，默认 900000 毫秒 |
| `GENERATION_PROVIDER` | 未保存默认模式时使用 `codex` 或 `api` |
| `IMAGE_API_BASE_URL` | 图片 API 的 HTTPS 根地址，可带 `/v1` |
| `IMAGE_API_KEY` | 后端生图密钥，浏览器不可见 |
| `IMAGE_API_MODEL_2K` | 1K/2K 使用的 2.5 模型 ID；本机为 `gpt-image-2.5-sunburst` |
| `IMAGE_API_MODEL_4K` | 新生成 4K 和清晰度提升使用的模型 ID；本机为 `gpt-image-2.0` |

CLI 安装与登录检测不保证该账户实际可用的生图能力；以一次真实生成结果为准。
如果 CLI 启动失败，检查 `.data/server.stderr.log`；任务执行日志位于 `.data/jobs/<id>/codex.log`。
Windows 通常自动从 PATH 查找 `codex.exe` 或 npm 安装的 `codex.js`。
没有复制、读取或转发 Codex 认证 token 的应用代码。

## 数据、预算与备份

- `.data/workspace.sqlite`：任务、积分、会话与结果元数据。
- `.data/jobs/<UUID>/`：该任务的规范化输入、执行日志、明确生成结果。
- `exports-<UUID>/`：不可变导出版本，包含图片及 `manifest.json`。
- `manifest.json` 包含任务来源、尺寸、文件 SHA-256 和待人工检查事项。
- 初始 500 测试积分，仅用于本工作台试用预算，没有支付或充值接口。
- 管理员可以在本机运行 `npm run credits -- 500` 补充测试积分。
- 停止服务后备份整个 `.data`。图片没有自动清理，长时间使用请关注磁盘空间。

测试积分退款不代表撤销实际模型请求或返还 Codex 账户用量。
图片可读性、数量和尺寸由程序检查；商品一致性、文案真实性及平台适用性需要人工确认。
当前详情页布局固定为 750px 宽、每模块 1050px 高，不自动宣称适配所有平台上架要求。

## 验证

```powershell
npm test
npm run build
```

自动化测试覆盖失败退款、重新生成、幂等提交、串行队列、取消、服务重启恢复、私有文件访问、上传校验和详情页重排。
测试通过注入生成器替身生成测试图片，不消耗真实 AI 用量。生产启动按任务所选模式使用真实 Codex 或中转 API，没有静默演示模式。

本轮另完成一次本机 Codex 真实生成验收，任务名称为「系统验收 · 蓝色概念水瓶」。这是虚构商品测试素材。

## 参考项目

[借鉴决策与边界](docs/reference-decisions.md) 记录了从 GPT Image Canvas、SellerPilot、E-commerce Detail Page Generator、gpt-image2-ecommerce 和迅排设计借鉴的内容。
运行时使用 `skills/runtime/` 下的四份专用 Skill 和按场景选定的参考章节，来源见 [ATTRIBUTION](skills/ATTRIBUTION.md)。
