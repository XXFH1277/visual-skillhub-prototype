# 借鉴决策与实现边界

本轮参考了以下 GitHub 项目的 README、数据模型与相关实现，采用适合单机私人工作台的设计；没有整库移植或调用它们的私有认证端点。

| 参考项目 | 具体借鉴 | 本项目落地 | 暂不采用 |
|---|---|---|---|
| [GPT Image Canvas](https://github.com/mrslimslim/gpt-image-canvas) | generationRecords / generationOutputs / referenceAssets 的持久化关系，明确记录生成状态 | SQLite 任务、输入清单、结果清单、历史回看、重生成来源 | 无限画布、OAuth token 桥接、云备份和复杂 DAG |
| [SellerPilot](https://github.com/ninemouth/sellerpilot-product-image-industrial) | run_id、运行状态、产物 lineage，商品身份和套图风格一致性 | UUID 独立任务目录、sourceId、文件 SHA-256、串行队列、禁止全局图片目录兜底 | 多平台研究系统、多 provider 自动路由、大量审计阶段 |
| [E-commerce Detail Page Generator](https://github.com/Gayaya999/ecommerce-detail-page-generator) | AI 生成无字底图 + 代码准确排版；独立模块 + 长图 + manifest；文案来源约束 | sharp 排版 2–6 个模块、750px 长图、免费改文案、不可变导出版本 | 原 Python 全套脚本、动态平台规则验证、6–10 模块的强制要求 |
| [gpt-image2-ecommerce](https://github.com/buluslan/gpt-image2-ecommerce) | 商品保留项、参考图角色、套图光影/品牌色一致性 | 商品 Skill 加载驱动力、光照与保真章节；海报 Skill 加载构图章节 | 第三方模型路由、额外角度图与自动重生 |
| [迅排设计](https://github.com/palxiao/poster-design) | 将文字和素材分开编辑、成图后继续修改的产品交互 | 详情页模块文案可编辑并重新导出 | 完整拖拽编辑器和源码集成；当前主分支为 AGPL-3.0 |

## 工作台执行规则

运行时由 `backend/skill-workflow.js` 路由到 `skills/runtime/{product,detail,poster,interior}/SKILL.md`，加载全文及服务端白名单内的第三方参考章节。
任务提交时固定 Skill 内容、来源哈希和逐张计划；生成时验证快照并生成 `prompt-N.txt`，Codex 与中转 API 共用这些完整提示词。
第三方文件保留原文和许可（见 `skills/ATTRIBUTION.md`），仅装载适用章节，不执行原仓库脚本或额外工具链。装修为原创专用 Skill，不加载电商参考。
旧 `skills/workspace-guide.md` 已被专用 Skill 替代，不再参与新生成。
原 `skills/skill-map.json` 只描述旧原型的文档分组，不再决定运行流程。
这避免了旧详情页规则中“不得虚构卖点”和“允许模拟好评”的冲突；`1click-ecom-detailpage` 仍仅作为归档参考，不自动执行。

## 当前边界

- 私人共享工作台：同一访问码下的成员看到同一批任务和积分；不是多租户 SaaS。
- 测试积分不是货币，未接支付。生成计费仍以实际 Codex 账户使用量为准。
- 自动检查覆盖图片可解码、输出数量、尺寸、文件归属；商品外观和文案仍需人工审核。
- 平台字段用于表达创作目标，当前不承诺自动满足各平台最新上架规范。
- 详情页文案由用户输入并确认，AI 仅生成视觉底图。模块布局目前固定，不是自由画布。
- 取消/超时会尝试终止本机 Codex 进程树，但无法承诺撤销已发往服务端的生图请求或其用量。
- CLI 使用正常 workspace-write 沙箱；不会关闭审批或读取/转发认证 token。
- 图片和历史保存在 `.data`，没有自动清理；停止服务后备份整个目录。大规模使用前需增加配额和保留策略。

## 验证

`npm test` 使用测试专用的生成器替身验证状态、真实图片导出和 HTTP 接口，避免持续消耗 AI 额度。
真实 Codex 调用需单独进行一次受控验收；CLI 安装与登录检查不等于生图能力保证。
