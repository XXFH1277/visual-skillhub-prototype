import {
  CREATION_FIELDS,
  MODULE_ROLES,
  suggestModules,
} from "../shared/creation.js";
import { IMAGE_SIZES, upscaleSize } from "../shared/generation.js";
import {
  POSTER_FIELDS,
  POSTER_KINDS,
  POSTER_LAYOUTS,
} from "../shared/poster.js";
const app = document.querySelector("#app");
const nav = document.querySelector("#nav");
let workspace,
  view = 0,
  cleanup = () => {};
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (value) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
const statusName = {
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败 · 已退款",
  cancelled: "已取消 · 已退款",
};
const active = (job) => ["queued", "running"].includes(job.status);
const names = {
  upscale: "4K 清晰度提升",
  product: "电商产品图",
  detail: "详情页长图",
  poster: "海报 / 菜单",
  interior: "装修效果图",
};
const byId = (id) => document.getElementById(id);
const apiModels = () => {
  const mapping = workspace.providers.find(
    (p) => p.mode === "api",
  ).modelsByResolution;
  return { model2k: mapping["2K"], model4k: mapping["4K"] };
};
const providerLabel = (mode) =>
  mode === "api" ? "中转生图 API" : "本机 Codex";
const providerOptions = (selected) =>
  workspace.providers
    .map(
      (p) =>
        `<option value="${p.mode}" ${selected === p.mode ? "selected" : ""}>${escape(p.label)}${p.ready ? "" : "（未就绪）"}</option>`,
    )
    .join("");

async function api(route, options = {}) {
  let response;
  try {
    response = await fetch("/api" + route, {
      ...options,
      headers: { "X-Requested-With": "SkillHub", ...options.headers },
    });
  } catch {
    throw new Error(
      "连接中断，请检查网络。已提交的任务会继续处理，可到「我的任务」查看。",
    );
  }
  const data = await response
    .json()
    .catch(() => ({ error: "服务器返回了无法读取的响应" }));
  if (!response.ok) {
    const error = new Error(data.error || "请求失败");
    error.status = response.status;
    throw error;
  }
  return data;
}
function json(body) {
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
function notice(message, isError = false) {
  const box = document.createElement("div");
  box.className = "toast" + (isError ? " error" : "");
  box.textContent = message;
  box.setAttribute("role", "status");
  document.body.append(box);
  setTimeout(() => box.remove(), 5000);
}
async function action(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
  }
}
function header() {
  nav.innerHTML = workspace
    ? `<a href="#/">工作台</a><a href="#/tasks">我的任务</a><a class="balance" href="#/credits">${workspace.account.balance} 测试积分</a><button class="text-button" id="logout">退出</button>`
    : "";
  byId("logout")?.addEventListener("click", () =>
    action(byId("logout"), async () => {
      await api("/logout", { method: "POST" });
      workspace = null;
      location.hash = "#/";
      render();
    }),
  );
}
async function refreshAccount() {
  workspace = await api("/workspace");
  header();
}
function login() {
  nav.innerHTML = "";
  app.innerHTML = `<section class="login"><span class="eyebrow">PRIVATE CREATIVE WORKSPACE</span><h1>让产品，<br>成为画面的主角。</h1><p class="muted">登录你的视觉工作台，制作产品图与详情页。</p><form id="login-form" class="panel"><label for="access-code">工作台访问码</label><input id="access-code" type="password" autocomplete="current-password" required placeholder="输入管理员提供的访问码"><button class="button wide">进入工作台 <span>→</span></button><p id="login-error" class="error-text" role="alert"></p><small>持有同一访问码的成员共享任务、素材和测试积分。</small></form></section>`;
  byId("login-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      await api("/login", {
        method: "POST",
        ...json({ code: byId("access-code").value }),
      });
      await refreshAccount();
      render();
    } catch (error) {
      byId("login-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}
function home() {
  const cards = [
    [
      "product",
      "01",
      "产品主图",
      "从一张产品照片出发，制作白底图、场景图与橱窗图。",
      "保留商品特征 · 1–3 张",
    ],
    [
      "detail",
      "02",
      "详情页长图",
      "分模块生成底图，准确排版文案，交付长图与独立切片。",
      "模块文案可编辑 · 2–6 模块",
    ],
    [
      "poster",
      "03",
      "海报 / 菜单",
      "为活动与门店制作主视觉，探索品牌的新表达。",
      "参考图与品牌配色",
    ],
    [
      "interior",
      "04",
      "装修效果图",
      "上传空间照片，在已有空间上探索材质与风格。",
      "适合视觉概念探索",
    ],
  ];
  app.innerHTML = `<section class="hero"><div><span class="eyebrow">VISUAL SKILLHUB / STUDIO</span><h1>好产品，<br>值得被看见<span class="accent">。</span></h1><p>从产品原图到可交付的视觉素材。<br>让每次创作有记录，让每张结果可回看。</p><a class="button" href="#/upload/product">开始制作 <span>↗</span></a></div><div class="hero-art" aria-hidden="true"><div class="art-label">YOUR PRODUCT<br>YOUR STORY</div><div class="art-circle"></div><div class="art-frame">素材 → 风格 → 成图</div><span class="art-caption">创作，从一张照片开始</span></div></section>
${!workspace.provider.ready ? `<div class="notice warning"><strong>生成服务暂未就绪</strong><p>${escape(workspace.provider.message)}</p><button class="text-button" id="check-provider">重新检查</button></div>` : ""}
<section class="panel provider-panel"><div><h2>生成方式</h2><p class="muted">默认使用 ${escape(workspace.provider.label)}。新建任务时也可以单独选择；已提交的任务保持原模式。</p></div><div class="row"><label>默认生成方式<select id="default-provider">${providerOptions(workspace.provider.mode)}</select></label><button class="button secondary" id="save-provider">保存默认方式</button><button class="text-button" id="refresh-provider">检查连接</button></div></section>
<div class="section-title"><h2>选择你的创作方式</h2><span class="muted">四种场景，一个工作台</span></div><div class="skill-grid">${cards.map(([id, n, title, desc, tag]) => `<a class="skill-card" href="#/upload/${id}"><span class="card-index">${n} / ${id.toUpperCase()}</span><h3>${title}<span>↗</span></h3><p>${desc}</p><div class="card-foot"><small>${tag}</small><b>${workspace.skills[id].cost} 积分 / ${id === "detail" ? "模块" : "张"}</b></div></a>`).join("")}</div>`;
  byId("save-provider").onclick = () =>
    action(byId("save-provider"), async () => {
      await api("/provider", {
        method: "POST",
        ...json({ mode: byId("default-provider").value }),
      });
      await refreshAccount();
      home();
      notice("默认生成方式已保存");
    });
  byId("refresh-provider").onclick = () =>
    action(byId("refresh-provider"), async () => {
      const status = await api("/provider/check", {
        method: "POST",
        ...json({ mode: byId("default-provider").value }),
      });
      await refreshAccount();
      home();
      notice(status.message, !status.ready);
    });
  byId("check-provider")?.addEventListener("click", () =>
    action(byId("check-provider"), async () => {
      await api("/provider/check", { method: "POST" });
      await refreshAccount();
      home();
    }),
  );
}
function moduleFields(list, copyOnly = false) {
  return list
    .map(
      (m, i) =>
        `<fieldset class="module"><legend>模块 ${i + 1}</legend>${
          copyOnly
            ? ""
            : `<label>画面任务<select data-role>${Object.entries(MODULE_ROLES)
                .map(
                  ([k, v]) =>
                    `<option value="${k}" ${(m.role || (i ? "detail" : "hero")) === k ? "selected" : ""}>${v}</option>`,
                )
                .join(
                  "",
                )}</select></label><label>画面说明<textarea data-visual maxlength="300" rows="2" placeholder="描述这一模块要呈现的画面">${escape(m.visual || "")}</textarea></label>`
        }<label>标题<input data-title maxlength="28" value="${escape(m.title)}" required></label><label>正文 / 已确认卖点<textarea data-body maxlength="100" rows="2">${escape(m.body)}</textarea></label></fieldset>`,
    )
    .join("");
}
function readModules(container) {
  return [...container.querySelectorAll(".module")].map((el) => ({
    role: el.querySelector("[data-role]")?.value,
    visual: el.querySelector("[data-visual]")?.value,
    title: el.querySelector("[data-title]").value,
    body: el.querySelector("[data-body]").value,
  }));
}
function creativeForm(skillId) {
  const fields = CREATION_FIELDS[skillId];
  if (!fields) return "";
  const title = {
    product: "商品图用途与身份",
    detail: "详情页策划",
    interior: "空间与改造范围",
  }[skillId];
  return `<section class="panel"><h2><span class="step">2</span> ${title}</h2>${skillId === "interior" ? '<p class="muted">以现状照片为准，保留建筑结构、门窗和透视。保留项优先于改动项，风格参考不会替换原户型。</p>' : '<p class="muted">按用途规划每张画面，套图保持商品身份和视觉风格一致。</p>'}${fields
    .map(
      (f) =>
        `<label>${f.label}${f.required ? ' <span class="required">必填</span>' : ""}${
          f.options
            ? `<select data-creative="${f.key}">${Object.entries(f.options)
                .map(([v, label]) => `<option value="${v}">${label}</option>`)
                .join("")}</select>`
            : `<textarea data-creative="${f.key}" maxlength="${f.max}" rows="2" ${f.required ? "required" : ""} placeholder="${f.placeholder || ""}"></textarea>`
        }</label>`,
    )
    .join(
      "",
    )}${skillId === "interior" ? "<small>用于装修风格探索；效果图不提供实测尺寸或施工结论。</small>" : ""}</section>`;
}
function readCreative(form) {
  return Object.fromEntries(
    [...form.querySelectorAll("[data-creative]")].map((el) => [
      el.dataset.creative,
      el.value,
    ]),
  );
}
function workflowDetails(workflow) {
  if (!workflow) return "";
  return `<details class="panel"><summary>本次 Skills 与逐张计划 · ${escape(workflow.name)}</summary><p>版本 ${escape(workflow.version)} · 快照 ${escape(workflow.sha256.slice(0, 12))}</p><p class="muted">规则在任务创建时固定，生成时由所选模式加载。计划已建立不等于图片已完成或视觉审核通过。</p><h3>逐张计划</h3>${workflow.frames.map((f) => `<p><strong>${f.index}. ${escape(f.title)}</strong></p><p class="prewrap">${escape(f.direction)}</p>`).join("")}<h3>创作设定</h3>${Object.entries(
    workflow.creative,
  )
    .map(([k, v]) => `<p>${escape(k)}：${escape(v)}</p>`)
    .join(
      "",
    )}<h3>默认与待核对</h3>${[...workflow.assumptions, ...workflow.review].map((v) => `<p>${escape(v)}</p>`).join("")}<h3>实际加载的文件 / 章节</h3>${workflow.sources.map((s) => `<p><code>${escape(s.file)}</code>${s.section ? ` · ${escape(s.section)}` : ""}</p>`).join("")}</details>`;
}
function posterForm() {
  const options = (values) =>
    Object.entries(values)
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join("");
  return `<section class="panel"><h2><span class="step">2</span> 海报文案与版式</h2><p class="muted">下面的文字会直接出现在海报画面中。留空的内容不展示，价格和日期请填写真实信息。</p><div class="two"><label>海报类型<select data-poster="kind">${options(POSTER_KINDS)}</select></label><label>版式方向<select data-poster="layout">${options(POSTER_LAYOUTS)}</select></label></div>${POSTER_FIELDS.map((f) => `<label>${f.label}${f.required ? ' <span class="required">必填</span>' : ""}${f.multiline ? `<textarea data-poster="${f.key}" maxlength="${f.max}" rows="${f.key === "body" ? 5 : 2}" placeholder="${f.placeholder}"></textarea>` : `<input data-poster="${f.key}" maxlength="${f.max}" ${f.required ? "required" : ""} placeholder="${f.placeholder}">`}</label>`).join("")}<small>图片模型负责文字与画面融合；生成后请核对汉字、金额、日期和联系方式。</small></section>`;
}
function posterCopy(poster) {
  return `<details class="panel source-details"><summary>核对海报文案</summary><p>${escape(POSTER_KINDS[poster.kind])} · ${escape(POSTER_LAYOUTS[poster.layout])}</p>${POSTER_FIELDS.filter(
    (f) => poster[f.key],
  )
    .map(
      (f) =>
        `<h3>${f.label}</h3><p class="prewrap">${escape(poster[f.key])}</p>`,
    )
    .join(
      "",
    )}<small>这些是提交的原文，请与成图逐项核对；目前未自动校对图片中的文字。</small></details>`;
}
function polishStyleNote(note, skillId) {
  const original = note.trim().replace(/[。，,.；;\s]+$/, "");
  if (!original) throw new Error("请先写一句风格说明，再点润色");
  const directions = {
    product: [
      "商品主体完整、构图清晰",
      "光线与阴影自然，突出真实材质细节",
      "保留原图中的商品外观、颜色、Logo 和标签",
      "不添加未经确认的卖点或文字",
    ],
    detail: [
      "围绕已确认的模块主题组织画面",
      "各模块保持商品外观、配色与光线一致",
      "构图清晰、留白得当，适合手机浏览",
      "只生成无字底图，标题和卖点由后续排版呈现",
    ],
    poster: [
      "主视觉突出，构图与信息层次清晰",
      "统一品牌配色，留白得当",
      "仅使用已确认的标题与文案，不虚构活动价格或优惠",
      "保持商品或品牌标识准确",
    ],
    interior: [
      "保留原空间的主要结构与透视关系",
      "材质表现真实，光照与阴影自然",
      "软装、色彩与整体风格协调",
      "不添加未经确认的尺寸或施工承诺",
    ],
  }[skillId];
  const result =
    [original, ...directions.filter((part) => !original.includes(part))].join(
      "；",
    ) + "。";
  if (result.length > 1000)
    throw new Error("润色后超过 1000 字，请先精简风格说明；原文未修改");
  return result;
}
function upload(skillId) {
  if (!names[skillId] || skillId === "upscale") {
    location.hash = "#/";
    return;
  }
  const detail = skillId === "detail",
    poster = skillId === "poster",
    interior = skillId === "interior",
    cost = workspace.skills[skillId].cost;
  app.innerHTML = `<a class="back" href="#/">← 创作方式</a><div class="page-title"><span class="eyebrow">NEW CREATION</span><h1>${names[skillId]}</h1><p class="muted">${poster ? "先确认海报要传达的信息，再选择文字层级、版式和主视觉。" : "先提供真实素材，再定义这次创作的方向。"}</p></div>
<form id="create-form" class="creation-layout"><div class="stack"><section class="panel"><h2><span class="step">1</span> ${poster ? "主题与素材" : interior ? "现状空间" : "素材与商品"}</h2><div class="two"><label>${poster ? "海报项目名称" : interior ? "空间项目名称" : "商品 / 项目名称"}<input name="productName" required maxlength="60" placeholder="${poster ? "例如：秋日咖啡节宣传海报" : interior ? "例如：客厅软装改造" : "例如：陶瓷咖啡杯"}"></label><label>目标平台<select name="platform"><option>通用 / 内部预览</option><option>淘宝 / 天猫</option><option>京东</option><option>Shopify</option><option>Amazon</option><option>其他</option></select></label></div><label class="upload-zone">${poster ? "主视觉素材（选填）" : interior ? '现状空间照片 <span class="required">必填</span>' : '产品主图 <span class="required">必填</span>'}<span class="muted">选择清晰的 PNG、JPEG 或 WebP</span><input name="main" id="main-file" type="file" accept="image/png,image/jpeg,image/webp" ${poster ? "" : "required"}></label>${poster ? "<small>可上传产品、门店或品牌主视觉；不上传也可制作纯文字 / 图形海报。</small>" : ""}<div id="main-preview" class="preview-grid"></div><label>风格参考图 <small>最多 3 张，仅用于风格参考</small><input name="reference" id="reference-files" type="file" accept="image/png,image/jpeg,image/webp" multiple></label><div id="reference-preview" class="preview-grid"></div><small>单个文件不超过 10MB。请使用你有权使用的素材。</small><label>${poster ? "补充说明（不作为海报可见文案）" : interior ? "现状说明与已知条件" : "已确认的商品卖点"}<textarea name="facts" maxlength="1200" rows="3" placeholder="${poster ? "例如：只使用已有品牌配色；不要出现未经确认的活动承诺。" : interior ? "例如：朝南窗、原有中央空调；尺寸仅填写已实测的信息。" : "填写实际材质、尺寸或功能；不确定的内容请留空。"}"></textarea></label></section>
${poster ? posterForm() : creativeForm(skillId)}
<section class="panel"><h2><span class="step">3</span> 视觉方向</h2><label>风格说明<textarea name="styleNote" maxlength="1000" rows="3" placeholder="${poster ? "例如：复古海报风，大标题配暖色块，文字层级醒目。" : interior ? "例如：温暖原木风，米色布艺；保持原窗的自然采光。" : "例如：暖白背景，自然侧光，突出釉面的细腻质感。"}"></textarea></label><div class="polish-actions"><button type="button" class="button secondary" id="polish-note">✨ 一键润色</button><button type="button" class="text-button" id="undo-polish" hidden>撤销润色</button><small>按场景整理描述，不消耗积分。</small></div><div id="polish-preview" class="polish-preview" hidden><label>润色预览<textarea id="polished-note" maxlength="1000" rows="6"></textarea></label><p class="muted">原文暂未修改。可编辑预览后再应用。</p><div class="row"><button type="button" class="button" id="apply-polish">应用润色</button><button type="button" class="text-button" id="cancel-polish">取消</button></div></div><div class="two"><label>${interior ? "配色参考（以材质说明为准）" : "品牌主色"}<input name="brandColor" type="color" value="#5755d9"></label>${detail ? '<p class="muted">底图按 1:1 生成，模块统一排版，长图宽度 750px。</p>' : '<label>画幅<select name="size"><option value="1:1">1:1 方形</option><option value="3:4">3:4 竖版</option><option value="16:9">16:9 横版</option></select></label>'}</div></section>
${
  detail
    ? `<section class="panel"><h2><span class="step">4</span> 模块计划与文案</h2><p class="muted">这些文字将由程序准确排版，不让图片模型猜字。生成后仍可免费修改文案。</p><button type="button" class="button secondary" id="suggest-modules">按已填资料规划模块</button><p class="muted">建议只整理已确认卖点，不自动编写事实。会替换下方模块，请检查后再提交。</p><div id="modules">${moduleFields(
        [
          { title: "商品展示", body: "" },
          { title: "产品细节", body: "" },
        ],
      )}</div><div class="row"><button type="button" class="button secondary" id="add-module">＋ 添加模块</button><button type="button" class="text-button" id="remove-module">移除最后一项</button></div></section>`
    : ""
}</div>
<aside class="panel order-summary"><span class="eyebrow">CREATION SUMMARY</span><h2>本次创作</h2><p>将加载${names[skillId]}专用 Skill，按逐张计划生成。</p>${poster ? "<p>交付：含标题、文案与主视觉的完整海报。</p>" : ""}<label>生成方式<select id="provider-mode" name="providerMode">${providerOptions(workspace.provider.mode)}</select></label><div id="api-settings"><label>生图模型<select name="imageModel" id="image-model"><option value="${escape(apiModels().model2k)}">GPT Image 2.5</option><option value="${escape(apiModels().model4k)}" ${detail ? "disabled" : ""}>GPT Image 2.0 4K（16:9）</option></select></label><label>请求分辨率<select name="resolution" id="resolution"></select></label><small>4K 需选择 16:9 画幅。中转站可能返回不同尺寸；结果页显示真实像素，不自动放大。</small></div><p id="provider-hint" class="muted"></p>${detail ? "<p>交付：模块图 + 长图 + 文件清单</p>" : '<label>生成张数<select name="count" id="count"><option>1</option><option selected>2</option><option>3</option></select></label>'}<div class="price"><b id="estimate"></b><span>测试积分</span></div><p class="muted">可用 ${workspace.account.balance} 积分<br>提交时预扣，失败或取消自动退回。测试积分不代表中转站实际费用；上游计费以账单为准。</p><label class="checkbox"><input type="checkbox" required>${interior ? "我已确认空间条件与改造范围" : "我已确认商品资料与文案准确"}</label><button class="button wide" id="submit-job" ${workspace.provider.ready ? "" : "disabled"}>提交生成 <span>→</span></button><p class="error-text" id="form-error" role="alert"></p><small>任务提交后可以离开页面，稍后在「我的任务」查看。</small></aside></form>`;
  const form = byId("create-form"),
    container = byId("modules");
  if (poster) {
    form.elements.size.value = "3:4";
    byId("count").value = "1";
    form.elements.platform.innerHTML = [
      "通用 / 内部预览",
      "朋友圈 / 社交媒体",
      "门店海报",
      "活动宣传",
      "菜单 / 价目表",
      "电商活动页",
    ]
      .map((label) => `<option>${label}</option>`)
      .join("");
    form.elements.platform.closest("label").firstChild.textContent = "投放场景";
  }
  if (interior) {
    form.elements.size.value = "16:9";
    byId("count").value = "1";
    form.elements.platform.innerHTML = [
      "自住空间风格探索",
      "商业空间概念",
      "方案沟通展示",
    ]
      .map((label) => `<option>${label}</option>`)
      .join("");
    form.elements.platform.closest("label").firstChild.textContent = "方案用途";
    form.elements.brandColor.closest("label").hidden = true;
  }
  const copyMode = form.querySelector('[data-creative="textMode"]');
  if (copyMode) {
    const copy = form.querySelector('[data-creative="copy"]');
    const syncCopy = () => {
      copy.disabled = copyMode.value === "none";
      copy.required = !copy.disabled;
      copy.closest("label").hidden = copy.disabled;
    };
    copyMode.addEventListener("change", syncCopy);
    syncCopy();
  }
  const note = form.elements.styleNote;
  let previousNote = null,
    appliedNote = null,
    previewSource = null;
  byId("polish-note").onclick = () => {
    try {
      const polished = polishStyleNote(note.value, skillId);
      previewSource = note.value;
      byId("polished-note").value = polished;
      byId("polish-preview").hidden = false;
      byId("polished-note").focus();
    } catch (error) {
      notice(error.message, true);
      note.focus();
    }
  };
  byId("cancel-polish").onclick = () => {
    byId("polish-preview").hidden = true;
    note.focus();
  };
  byId("apply-polish").onclick = () => {
    const value = byId("polished-note").value.trim();
    if (!value || value.length > 1000)
      return notice("润色内容不能为空或超过 1000 字", true);
    if (note.value !== previewSource)
      return notice("原文已修改，请重新点击一键润色后再应用", true);
    previousNote = note.value;
    appliedNote = value;
    note.value = value;
    note.dispatchEvent(new Event("input", { bubbles: true }));
    byId("polish-preview").hidden = true;
    byId("undo-polish").hidden = false;
    note.focus();
    notice("已应用润色，可继续编辑或撤销");
  };
  byId("undo-polish").onclick = () => {
    if (note.value !== appliedNote)
      return notice("应用后你已继续编辑，为保留这些修改，请手动调整", true);
    note.value = previousNote;
    note.dispatchEvent(new Event("input", { bubbles: true }));
    byId("undo-polish").hidden = true;
    byId("polish-preview").hidden = true;
    note.focus();
    notice("已恢复润色前的原文");
  };
  const syncProvider = (event) => {
    const mode = byId("provider-mode").value;
    const isApi = mode === "api";
    const provider = workspace.providers.find((p) => p.mode === mode);
    byId("api-settings").hidden = !isApi;
    byId("image-model").disabled = !isApi;
    byId("resolution").disabled = !isApi;
    const sizeSelect = form.elements.size;
    let selected = byId("resolution").value || "2K";
    if (event?.target === byId("resolution"))
      byId("image-model").value =
        selected === "4K" ? apiModels().model4k : apiModels().model2k;
    if (
      event?.target === byId("image-model") &&
      byId("image-model").value === apiModels().model2k
    )
      selected = "2K";
    if (
      sizeSelect &&
      event?.target === sizeSelect &&
      sizeSelect.value !== "16:9" &&
      byId("image-model").value === apiModels().model4k
    ) {
      byId("image-model").value = apiModels().model2k;
      selected = "2K";
    }
    const model = byId("image-model").value;
    if (isApi && model === apiModels().model4k && sizeSelect)
      sizeSelect.value = "16:9";
    const aspect = detail ? "1:1" : sizeSelect.value;
    const sizes = IMAGE_SIZES[aspect];
    if (!sizes[selected]) selected = "2K";
    if (model === apiModels().model4k) selected = "4K";
    byId("resolution").innerHTML = Object.entries(sizes)
      .map(
        ([tier, pixels]) =>
          `<option value="${tier}" ${selected === tier ? "selected" : ""}>${tier} · ${pixels.replace("x", " × ")}</option>`,
      )
      .join("");
    byId("provider-hint").textContent = !provider.ready
      ? provider.message
      : isApi
        ? "上传素材、专用 Skill 与创作说明将发送到已配置的中转站。"
        : "使用本机 Codex 登录状态；输出尺寸由生成结果决定。";
    byId("submit-job").disabled = !provider.ready;
  };
  byId("provider-mode").onchange = syncProvider;
  byId("image-model").onchange = syncProvider;
  byId("resolution").onchange = syncProvider;
  form.elements.size?.addEventListener("change", syncProvider);
  syncProvider();
  const estimate = () =>
    (byId("estimate").textContent =
      cost *
      (detail ? container.children.length : Number(byId("count").value)));
  estimate();
  byId("suggest-modules")?.addEventListener("click", () => {
    try {
      const suggested = suggestModules(
        form.elements.facts.value,
        readCreative(form).scene,
      );
      container.innerHTML = moduleFields(suggested);
      container.dispatchEvent(new Event("input", { bubbles: true }));
      estimate();
      notice("已按现有资料规划模块，请检查文案与画面任务后再提交");
    } catch (error) {
      notice(error.message, true);
    }
  });
  byId("count")?.addEventListener("change", estimate);
  byId("add-module")?.addEventListener("click", () => {
    if (container.children.length >= 6) return;
    container.insertAdjacentHTML(
      "beforeend",
      moduleFields([{ title: "", body: "" }]).replace(
        "模块 1",
        `模块 ${container.children.length + 1}`,
      ),
    );
    estimate();
  });
  byId("remove-module")?.addEventListener("click", () => {
    if (container.children.length > 2) container.lastElementChild.remove();
    estimate();
  });
  const urls = [];
  for (const [inputId, previewId, max] of [
    ["main-file", "main-preview", 1],
    ["reference-files", "reference-preview", 3],
  ]) {
    byId(inputId).onchange = () => {
      const input = byId(inputId);
      input.setCustomValidity(
        input.files.length > max
          ? `最多选择 ${max} 张`
          : [...input.files].some((f) => f.size > 10 * 1024 * 1024)
            ? "文件不能超过 10MB"
            : "",
      );
      input.reportValidity();
      byId(previewId).innerHTML = [...input.files]
        .slice(0, max)
        .map((f) => {
          const url = URL.createObjectURL(f);
          urls.push(url);
          return `<img src="${url}" alt="已上传的素材预览">`;
        })
        .join("");
    };
  }
  cleanup = () => urls.forEach((url) => URL.revokeObjectURL(url));
  let submissionKey = crypto.randomUUID();
  form.addEventListener("input", () => {
    submissionKey = crypto.randomUUID();
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = byId("submit-job");
    button.disabled = true;
    byId("form-error").textContent = "";
    try {
      const data = new FormData(form);
      data.set("skillId", skillId);
      if (!byId("reference-files").files.length) data.delete("reference");
      if (poster && !byId("main-file").files.length) data.delete("main");
      if (poster)
        data.set(
          "poster",
          JSON.stringify(
            Object.fromEntries(
              [...form.querySelectorAll("[data-poster]")].map((el) => [
                el.dataset.poster,
                el.value,
              ]),
            ),
          ),
        );
      if (!poster) data.set("creative", JSON.stringify(readCreative(form)));
      if (detail) data.set("modules", JSON.stringify(readModules(container)));
      const job = await api("/jobs", {
        method: "POST",
        headers: { "Idempotency-Key": submissionKey },
        body: data,
      });
      await refreshAccount();
      location.hash = "#/job/" + job.id;
    } catch (error) {
      byId("form-error").textContent = error.message;
      button.disabled = false;
    }
  };
}
function taskCard(job) {
  return `<a class="task-row" href="#/job/${job.id}"><div class="task-mark">${job.params.skillId === "detail" ? "▤" : "▧"}</div><div><strong>${escape(job.params.productName)}</strong><p class="muted">${names[job.params.skillId]} · ${date(job.createdAt)}</p></div><span class="status ${job.status}">${statusName[job.status]}</span><span class="task-arrow">↗</span></a>`;
}
function taskList(jobs) {
  app.innerHTML = `<div class="page-title"><span class="eyebrow">YOUR CREATIONS</span><h1>我的任务</h1><p class="muted">素材、参数与结果保存在工作台，刷新后仍可继续查看。</p></div><div class="panel">${jobs.length ? jobs.map(taskCard).join("") : '<div class="empty"><h2>第一份作品，从这里开始</h2><p class="muted">你提交的任务都会出现在这里。</p><a class="button" href="#/upload/product">制作产品图 →</a></div>'}</div>`;
}
function jobView(job) {
  const retryKey = crypto.randomUUID();
  const upscaleButton = (asset) => {
    const [width, height] = upscaleSize(asset.width, asset.height)
      .split("x")
      .map(Number);
    if (asset.width >= width && asset.height >= height)
      return "<small>已达到 4K 目标尺寸</small>";
    const ready = workspace.providers
      .find((p) => p.mode === "api")
      ?.models.includes(apiModels().model4k);
    return `<button class="button secondary upscale-button" data-asset="${escape(asset.name)}" ${ready ? "" : "disabled"}>提升至 4K · ${workspace.skills.upscale.cost} 积分 ↗</button>`;
  };
  const file = (name) =>
    `/api/jobs/${job.id}/files/${encodeURIComponent(name)}?v=${encodeURIComponent(job.updatedAt)}`;
  app.innerHTML = `<a class="back" href="#/tasks">← 我的任务</a><div class="page-title"><span class="eyebrow">${escape(job.id.slice(0, 8).toUpperCase())}</span><h1>${escape(job.params.productName)}</h1><p class="muted">${names[job.params.skillId]} · ${escape(job.params.platform)} · ${date(job.createdAt)}</p></div><div class="notice ${job.status === "failed" ? "warning" : ""}"><div class="row spread"><strong class="status ${job.status}">${statusName[job.status]}</strong><span>${active(job) ? "预扣" : "本次"} ${job.cost} 测试积分</span></div>${active(job) ? `<p>${escape(job.phase)}。图片生成可能需要几分钟，可以离开页面稍后查看。</p><div class="activity-bar" aria-label="任务正在处理"></div>` : job.error ? `<p>${escape(job.error)}</p>` : "<p>图片已生成并完成文件检查，请查看商品细节后再使用。</p>"}</div>
${
  job.manifest?.warnings?.length
    ? `<div class="notice warning"><strong>实际分辨率提示</strong>${job.manifest.warnings.map((w) => `<p>${escape(w)}</p>`).join("")}</div>`
    : ""
}
${
  job.manifest
    ? `<div class="result-grid">${job.manifest.assets
        .filter((a) => ["image", "module"].includes(a.role))
        .map(
          (a, i) =>
            `<article class="panel result"><a href="${file(a.name)}" target="_blank" rel="noopener"><img src="${file(a.name)}" alt="生成结果 ${i + 1}"></a><div class="row spread"><span>${a.role === "module" ? "模块" : "图片"} ${i + 1} <small>${a.width} × ${a.height}</small></span><a class="text-button" href="${file(a.name)}&download=1">下载原图 ↓</a></div>${a.role === "image" ? upscaleButton(a) : ""}</article>`,
        )
        .join("")}</div><div class="row">${job.manifest.assets
        .filter((a) => a.role === "long-preview")
        .map(
          (a) =>
            `<a class="button" href="${file(a.name)}&download=1">下载详情页长图 ↓</a>`,
        )
        .join("")}${job.manifest.assets
        .filter((a) => a.role === "original")
        .map(
          (a, i) =>
            `<div class="stack"><a class="button secondary" href="${file(a.name)}&download=1">下载底图 ${i + 1} · ${a.width}×${a.height}</a>${upscaleButton(a)}</div>`,
        )
        .join(
          "",
        )}<a class="button secondary" href="${file("manifest.json")}&download=1">下载交付清单</a></div><p class="muted">提升至 4K 会将当前结果图交给 2.0 4K 模型，创建独立任务并保留原图。模型可能改变细节或返回较小尺寸，请核对实际结果。失败退回本站积分，中转站费用以账单为准。</p>`
    : ""
}
<div class="row">${active(job) ? '<button id="cancel-job" class="button secondary">取消任务并退回积分</button>' : `<button id="retry-job" class="button">${job.status === "succeeded" ? "再生成" : "重新生成"} · ${job.cost} 积分 ↗</button>`}<a class="button secondary" href="#/upload/${job.params.skillId === "upscale" ? "product" : job.params.skillId}">制作新任务</a>${job.sourceId ? `<a class="text-button" href="#/job/${job.sourceId}">查看来源任务</a>` : ""}</div>
${job.status === "succeeded" && job.params.skillId === "detail" ? `<details class="panel edit-copy"><summary>修改模块文案 · 免费重新排版</summary><form id="copy-form"><div id="copy-modules">${moduleFields(job.params.modules, true)}</div><button class="button">保存文案并重新导出</button></form></details>` : ""}
${workflowDetails(job.params.workflow)}
${job.params.poster ? posterCopy(job.params.poster) : ""}
<details class="panel source-details"><summary>查看素材与创作参数</summary><div class="two">${job.params.inputs.length ? `<img class="source-image" src="/api/jobs/${job.id}/input" alt="上传素材">` : '<p class="muted">此海报未上传素材，由主题与文案生成。</p>'}<div><h3>生成方式</h3><p>${providerLabel(job.params.providerMode)}${job.params.imageModel ? ` · ${escape(job.params.imageModel)} · 请求 ${escape(job.params.requestedSize)}` : ""}</p><h3>风格说明</h3><p class="prewrap">${escape(job.params.styleNote || "未填写")}</p><h3>${job.params.skillId === "interior" ? "现状条件" : "已确认资料"}</h3><p class="prewrap">${escape(job.params.facts || "未填写")}</p><small>任务编号 ${escape(job.id)}</small></div></div></details>`;
  byId("retry-job")?.addEventListener("click", () =>
    action(byId("retry-job"), async () => {
      const next = await api(`/jobs/${job.id}/retry`, {
        method: "POST",
        headers: { "Idempotency-Key": retryKey },
      });
      await refreshAccount();
      location.hash = "#/job/" + next.id;
    }),
  );
  for (const button of app.querySelectorAll(".upscale-button")) {
    const key = crypto.randomUUID();
    button.onclick = () =>
      action(button, async () => {
        const next = await api(`/jobs/${job.id}/upscale`, {
          method: "POST",
          headers: {
            "Idempotency-Key": key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ asset: button.dataset.asset }),
        });
        await refreshAccount();
        location.hash = "#/job/" + next.id;
      });
  }
  byId("cancel-job")?.addEventListener("click", () =>
    action(byId("cancel-job"), async () => {
      await api(`/jobs/${job.id}/cancel`, { method: "POST" });
      await refreshAccount();
      render();
    }),
  );
  byId("copy-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    action(event.currentTarget.querySelector("button"), async () => {
      await api(`/jobs/${job.id}/copy`, {
        method: "POST",
        ...json({ modules: readModules(byId("copy-modules")) }),
      });
      notice("文案已更新，图片已重新导出");
      render();
    });
  });
}
function credits() {
  app.innerHTML = `<div class="page-title"><span class="eyebrow">WORKSPACE CREDITS</span><h1>测试积分</h1><p class="muted">用于控制工作台的试用预算，尚未接入支付。</p></div><section class="panel"><div class="price"><b>${workspace.account.balance}</b><span>可用积分</span></div><p>提交任务时预扣；生成成功后结算，失败或取消后退回。修改详情页文字不扣积分。</p></section><h2>最近流水</h2><div class="panel ledger">${workspace.account.ledger.length ? workspace.account.ledger.map((l) => `<div class="ledger-row"><div><strong>${l.kind === "reserve" ? "任务预扣" : l.kind === "refund" ? "失败 / 取消退回" : "管理员补充"}</strong><p class="muted">${date(l.createdAt)} ${l.jobId ? `· <a href="#/job/${l.jobId}">${escape(l.jobId.slice(0, 8))}</a>` : ""}</p></div><b class="${l.amount > 0 ? "positive" : ""}">${l.amount > 0 ? "+" : ""}${l.amount}</b></div>`).join("") : '<p class="muted">还没有积分流水，初始赠送 500 测试积分。</p>'}</div>`;
}
async function render() {
  cleanup();
  cleanup = () => {};
  const token = ++view;
  const [route, id] = location.hash.replace(/^#\/?/, "").split("/");
  try {
    if (!workspace) await refreshAccount();
    if (token !== view) return;
    if (route === "tasks") {
      const data = await api("/jobs");
      if (token !== view) return;
      taskList(data.jobs);
      if (data.jobs.some(active)) {
        const timer = setTimeout(render, 4000);
        cleanup = () => clearTimeout(timer);
      }
    } else if (route === "job" && id) {
      const job = await api("/jobs/" + encodeURIComponent(id));
      if (token !== view) return;
      jobView(job);
      if (active(job)) {
        const timer = setTimeout(render, 2500);
        cleanup = () => clearTimeout(timer);
      } else await refreshAccount();
    } else if (route === "upload") upload(id);
    else if (route === "credits") {
      await refreshAccount();
      if (token === view) credits();
    } else home();
  } catch (error) {
    if (token !== view) return;
    if (error.status === 401) {
      workspace = null;
      login();
    } else
      app.innerHTML = `<section class="panel empty"><h1>暂时无法打开</h1><p>${escape(error.message)}</p><button class="button" id="reload">重试</button></section>`;
    byId("reload")?.addEventListener("click", render);
  }
}
addEventListener("hashchange", () => {
  window.scrollTo(0, 0);
  render();
});
render();
