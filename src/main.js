import { SCENES, SIZE_NAMES, LAYOUTS, TEXT_MODES, TEXT_ROLES, MAX_TEXTS } from "../shared/scenes.js";
import { IMAGE_SIZES, upscaleSize } from "../shared/generation.js";

const app = document.querySelector("#app");
const nav = document.querySelector("#nav");
let workspace = null;
let view = 0;
let cleanup = () => {};

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const date = (v) => new Date(v).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const active = (job) => ["queued", "running"].includes(job.status);
const STATUS = { queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败 · 已退积分", cancelled: "已取消 · 已退积分" };
const SCENE_NAME = (id) => (id === "upscale" ? "4K 提升" : SCENES[id]?.name || id);
const MODE_SHORT = { ai: "AI 画字", overlay: "精确排字", none: "不加字" };
const ASPECT = { "1:1": "ar-1-1", "3:4": "ar-3-4", "16:9": "ar-16-9" };

async function api(route, options = {}) {
  let response;
  try {
    response = await fetch("/api" + route, { ...options, headers: { "X-Requested-With": "SkillHub", ...options.headers } });
  } catch {
    throw new Error("网络连接中断，请检查网络后重试");
  }
  const data = await response.json().catch(() => ({ error: "服务器返回了无法读取的响应" }));
  if (!response.ok) {
    const error = new Error(data.error || "请求失败");
    error.status = response.status;
    throw error;
  }
  return data;
}
const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
function toast(message, error = false) {
  const box = document.createElement("div");
  box.className = "toast" + (error ? " error" : "");
  box.textContent = message;
  box.setAttribute("role", "status");
  document.body.append(box);
  setTimeout(() => box.remove(), 4500);
}
async function busy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}
function header() {
  const route = location.hash.replace(/^#\/?/, "").split("/")[0];
  nav.innerHTML = workspace
    ? `<a href="#/" class="${!route || route === "new" ? "on" : ""}">出图</a><a href="#/tasks" class="${route === "tasks" || route === "job" ? "on" : ""}">我的作品</a><a class="balance ${route === "credits" ? "on" : ""}" href="#/credits">${workspace.account.balance} 积分</a><button class="link" id="logout">退出</button>`
    : "";
  $("#logout")?.addEventListener("click", () =>
    busy($("#logout"), async () => {
      await api("/logout", { method: "POST" });
      workspace = null;
      location.hash = "#/";
      render();
    }),
  );
}
async function refresh() {
  workspace = await api("/workspace");
  header();
}

/* ---------------- login ---------------- */
function login() {
  nav.innerHTML = "";
  app.innerHTML = `<section class="login card"><h1>出图工作台</h1><p class="muted">上传商品图，写几句卖点，AI 帮你策划和出图。</p><form id="login-form"><label>访问码<input id="code" type="password" autocomplete="current-password" required placeholder="输入管理员给你的访问码"></label><button class="btn primary wide">进入</button><p class="err" id="login-error" role="alert"></p></form></section>`;
  $("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.currentTarget.querySelector("button");
    b.disabled = true;
    try {
      await api("/login", json({ code: $("#code").value }));
      await refresh();
      render();
    } catch (error) {
      $("#login-error").textContent = error.message;
    } finally {
      b.disabled = false;
    }
  };
}

/* ---------------- create: state ---------------- */
const state = {
  scene: "product",
  main: null,
  refs: [],
  copy: "",
  tags: [],
  note: "",
  count: SCENES.product.defaultCount,
  size: SCENES.product.defaultSize,
  providerMode: null,
  resolution: "2K",
  draft: null,
  frames: null,
  filesDirty: true,
  stale: false,
  urls: { main: null, refs: [] },
};
function setScene(id) {
  if (state.scene === id) return;
  state.scene = id;
  state.count = SCENES[id].defaultCount;
  state.size = SCENES[id].defaultSize;
  state.tags = [];
  invalidate(false);
}
function invalidate(files) {
  if (files) state.filesDirty = true;
  if (state.draft) state.stale = true;
}
const mainUrl = () => state.urls.main || (state.draft?.hasMainImage ? `/api/drafts/${state.draft.id}/input/0` : null);

/* ---------------- create: inputs ---------------- */
function createPage(sceneParam) {
  if (sceneParam && SCENES[sceneParam]) setScene(sceneParam);
  const s = SCENES[state.scene];
  state.providerMode ||= workspace.provider.mode;
  app.innerHTML = `
  <div class="create">
    <div class="scenes" role="tablist">${Object.entries(SCENES)
      .map(([id, sc]) => `<button role="tab" class="scene ${id === state.scene ? "on" : ""}" data-scene="${id}"><b>${sc.name}</b><small>${sc.tagline}</small></button>`)
      .join("")}</div>
    <section class="card step">
      <h2><span class="n">1</span>上传图片</h2>
      <div class="uploads">
        <label class="drop ${state.main ? "has" : ""}" id="drop-main">
          <input type="file" id="main-file" accept="image/png,image/jpeg,image/webp" hidden>
          ${state.urls.main ? `<img src="${state.urls.main}" alt="已选择的${s.mainLabel}">` : `<span class="plus">＋</span>`}
          <span class="drop-label">${s.mainLabel}${s.mainRequired ? ' <em>必传</em>' : ""}</span>
          ${state.main ? `<span class="swap">点击更换</span>` : `<small>点击或拖入 · JPG / PNG / WebP · ≤10MB</small>`}
        </label>
        <div class="refs">
          <span class="refs-title">风格参考图 <small>可选，最多 3 张</small></span>
          <div class="ref-row">${state.urls.refs
            .map((u, i) => `<div class="ref"><img src="${u}" alt="参考图 ${i + 1}"><button class="x" data-remove-ref="${i}" aria-label="移除参考图">×</button></div>`)
            .join("")}${state.refs.length < 3 ? `<label class="ref add"><input type="file" id="ref-file" accept="image/png,image/jpeg,image/webp" multiple hidden>＋</label>` : ""}</div>
          <small class="muted">喜欢哪种感觉就传哪张，AI 只借鉴风格，不会照搬里面的东西。</small>
        </div>
      </div>
    </section>
    <section class="card step">
      <h2><span class="n">2</span>${s.copyLabel}</h2>
      <textarea id="copy" rows="5" maxlength="1500" placeholder="${esc(s.copyPlaceholder)}">${esc(state.copy)}</textarea>
      <small class="muted">不用写得很好，AI 会看着你的图帮你润色；但只会用你写到的事实，不会编参数和价格。</small>
    </section>
    <section class="card step">
      <h2><span class="n">3</span>想要的风格</h2>
      <div class="chips">${s.styles.map((t) => `<button class="chip ${state.tags.includes(t) ? "on" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}</div>
      <input id="note" maxlength="300" value="${esc(state.note)}" placeholder="其他要求（可选），例如：背景用浅木色，整体偏暖">
    </section>
    <section class="card step">
      <h2><span class="n">4</span>出几${s.unit}</h2>
      <div class="row wrap">
        <div class="pills">${s.counts.map((c) => `<button class="pill ${c === state.count ? "on" : ""}" data-count="${c}">${c} ${s.unit}</button>`).join("")}</div>
        ${s.sizes.length > 1 ? `<div class="pills">${s.sizes.map((z) => `<button class="pill ${z === state.size ? "on" : ""}" data-size="${z}">${SIZE_NAMES[z]}</button>`).join("")}</div>` : `<span class="muted">每屏方图，自动拼成 750px 宽长图</span>`}
      </div>
      <details class="advanced"><summary>高级设置</summary>
        <div class="row wrap">
          <label>出图通道<select id="provider">${workspace.providers.map((p) => `<option value="${p.mode}" ${p.mode === state.providerMode ? "selected" : ""}>${esc(p.label)}${p.ready ? "" : "（未就绪）"}</option>`).join("")}</select></label>
          <label id="res-wrap">清晰度<select id="resolution"></select></label>
        </div>
        <p class="muted" id="provider-hint"></p>
        <p class="muted">文案策划：${esc(workspace.textAI.label)}${workspace.textAI.ready ? "" : " —— 目前只能按你的原文生成基础方案"}</p>
      </details>
    </section>
    <div id="plan"></div>
    <div class="actionbar"><div class="actionbar-in"><span id="action-note" class="muted"></span><button class="btn primary" id="action"></button></div></div>
  </div>`;
  bindInputs();
  renderPlan();
}

function bindInputs() {
  $$(".scene").forEach((b) => (b.onclick = () => (location.hash = "#/new/" + b.dataset.scene)));
  const takeMain = (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast("图片不能超过 10MB", true);
    if (state.urls.main) URL.revokeObjectURL(state.urls.main);
    state.main = file;
    state.urls.main = URL.createObjectURL(file);
    invalidate(true);
    createPage();
  };
  $("#main-file").onchange = (e) => takeMain(e.target.files[0]);
  const drop = $("#drop-main");
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add("over");
  };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault();
    takeMain(e.dataTransfer.files[0]);
  };
  $("#ref-file")?.addEventListener("change", (e) => {
    for (const file of [...e.target.files].slice(0, 3 - state.refs.length)) {
      if (file.size > 10 * 1024 * 1024) {
        toast("图片不能超过 10MB", true);
        continue;
      }
      state.refs.push(file);
      state.urls.refs.push(URL.createObjectURL(file));
    }
    invalidate(true);
    createPage();
  });
  $$("[data-remove-ref]").forEach(
    (b) =>
      (b.onclick = () => {
        const i = Number(b.dataset.removeRef);
        URL.revokeObjectURL(state.urls.refs[i]);
        state.refs.splice(i, 1);
        state.urls.refs.splice(i, 1);
        invalidate(true);
        createPage();
      }),
  );
  $("#copy").oninput = (e) => {
    state.copy = e.target.value;
    invalidate(false);
    updateAction();
  };
  $("#note").oninput = (e) => {
    state.note = e.target.value;
    invalidate(false);
    updateAction();
  };
  $$("[data-tag]").forEach(
    (b) =>
      (b.onclick = () => {
        const t = b.dataset.tag;
        if (state.tags.includes(t)) state.tags = state.tags.filter((x) => x !== t);
        else if (state.tags.length >= 3) return toast("最多选 3 个风格");
        else state.tags.push(t);
        b.classList.toggle("on");
        invalidate(false);
        updateAction();
      }),
  );
  $$("[data-count]").forEach((b) => (b.onclick = () => ((state.count = Number(b.dataset.count)), invalidate(false), createPage())));
  $$("[data-size]").forEach((b) => (b.onclick = () => ((state.size = b.dataset.size), invalidate(false), createPage())));
  $("#provider").onchange = (e) => ((state.providerMode = e.target.value), syncProvider());
  $("#resolution").onchange = (e) => (state.resolution = e.target.value);
  syncProvider();
}
function syncProvider() {
  const p = workspace.providers.find((x) => x.mode === state.providerMode) || workspace.provider;
  const api = p.mode === "api";
  $("#res-wrap").hidden = !api;
  const sizes = IMAGE_SIZES[state.scene === "detail" ? "1:1" : state.size];
  if (!sizes[state.resolution]) state.resolution = "2K";
  $("#resolution").innerHTML = Object.entries(sizes)
    .map(([tier, px]) => `<option value="${tier}" ${tier === state.resolution ? "selected" : ""}>${tier} · ${px.replace("x", "×")}</option>`)
    .join("");
  $("#provider-hint").textContent = p.ready ? (api ? "使用中转站 GPT 生图" : "使用本机 Codex 临时出图") : p.message || "未就绪";
  updateAction();
}

/* ---------------- create: planning ---------------- */
function updateAction() {
  const b = $("#action");
  if (!b) return;
  const note = $("#action-note");
  const s = SCENES[state.scene];
  const d = state.draft;
  if (d?.status === "planning") {
    b.textContent = "AI 策划中…";
    b.disabled = true;
    note.textContent = "Kimi 正在看图、润色文案、排版式，通常 20–60 秒";
    return;
  }
  b.disabled = false;
  if (!d || d.status !== "ready" || state.stale || state.filesDirty) {
    b.textContent = d ? "按新内容重新策划 →" : "AI 策划 →";
    note.textContent = d && d.status === "ready" ? "你改了上面的内容，重新策划后再出图" : "先让 AI 出方案，确认文字后才扣积分";
    b.onclick = () => startPlan();
    return;
  }
  const cost = workspace.skills[state.scene].cost * state.frames.length;
  b.textContent = `确认出图 · ${cost} 积分`;
  note.textContent = `余额 ${workspace.account.balance} 积分 · 失败或取消自动退回`;
  b.onclick = () => submitJob(b);
  if (cost > workspace.account.balance) {
    b.disabled = true;
    note.textContent = "积分不足，请联系管理员充值";
  }
  void s;
}
async function startPlan() {
  const s = SCENES[state.scene];
  if (s.mainRequired && !state.main && !(state.draft?.hasMainImage && !state.filesDirty))
    return toast(`请先上传${s.mainLabel}`, true);
  const fields = { copy: state.copy, styleNote: state.note, styleTags: state.tags, count: state.count, size: state.size };
  try {
    let d;
    if (state.draft && !state.filesDirty && state.draft.input.skillId === state.scene) {
      d = await api(`/drafts/${state.draft.id}/replan`, json(fields));
    } else {
      const form = new FormData();
      form.set("skillId", state.scene);
      for (const [k, v] of Object.entries(fields)) form.set(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
      if (state.main) form.append("main", state.main);
      for (const r of state.refs) form.append("reference", r);
      d = await api("/drafts", { method: "POST", body: form });
      state.filesDirty = false;
    }
    state.draft = d;
    state.stale = false;
    renderPlan();
    $("#plan")?.scrollIntoView({ behavior: "smooth", block: "center" });
    pollDraft();
  } catch (error) {
    toast(error.message, true);
  }
}
function pollDraft() {
  const id = state.draft?.id;
  const tick = async () => {
    if (state.draft?.id !== id || state.draft.status !== "planning") return;
    try {
      state.draft = await api("/drafts/" + id);
    } catch (error) {
      state.draft = { ...state.draft, status: "failed", error: error.message };
    }
    const here = location.hash.startsWith("#/new") || location.hash === "" || location.hash === "#/";
    if (state.draft.status === "ready") {
      state.frames = structuredClone(state.draft.plan.frames);
      if (state.draft.warning) toast(state.draft.warning, true);
    }
    if (here) renderPlan();
    if (here && state.draft.status === "ready") $("#plan")?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (state.draft.status === "planning") setTimeout(tick, 1500);
  };
  setTimeout(tick, 1500);
}

/* ---------------- create: plan review ---------------- */
function previewHtml(frame, skillId, size) {
  const url = mainUrl();
  const texts = frame.textMode === "none" ? [] : frame.texts;
  const imageTexts = skillId === "detail" ? (frame.textMode === "ai" ? texts.filter((t) => t.role === "headline") : []) : texts;
  const caption = skillId === "detail" ? texts.filter((t) => frame.textMode !== "ai" || t.role !== "headline") : [];
  const layout = imageTexts.length ? frame.layout : "none";
  return `<div class="pv-wrap"><div class="pv ${ASPECT[skillId === "detail" ? "1:1" : size]} lay-${layout}">
      ${url ? `<img class="pv-img" src="${url}" alt="">` : `<div class="pv-img pv-blank">AI 创作主视觉</div>`}
      ${imageTexts.length ? `<div class="pv-text">${imageTexts.map((t) => `<p class="r-${t.role}">${t.role === "point" ? "· " : ""}${esc(t.text)}</p>`).join("")}</div>` : ""}
      ${frame.textMode !== "none" && texts.length ? `<span class="pv-badge">${frame.textMode === "ai" ? "AI 画字" : "精确排字"}</span>` : ""}
    </div>${caption.length ? `<div class="pv-caption">${caption.map((t) => `<p class="r-${t.role}">${esc(t.text)}</p>`).join("")}</div>` : ""}</div>`;
}
function frameEditor(frame, i, skillId) {
  const modes = skillId === "detail" ? ["ai", "overlay"] : skillId === "interior" ? [] : ["ai", "overlay", "none"];
  const modeHelp =
    skillId === "detail"
      ? { ai: "标题画进图里，说明由程序排在图下", overlay: "标题和说明都由程序排在图下" }
      : { ai: "字和画面融为一体，出图后自动校对", overlay: "图上留白，程序把字排上去，保证一字不差", none: "图上不放文字" };
  const canLayout = skillId !== "detail" && skillId !== "interior" && frame.textMode !== "none";
  const roles = skillId === "detail" ? ["headline", "body"] : Object.keys(TEXT_ROLES).filter((r) => r !== "body" || skillId === "poster");
  return `<article class="card frame" data-frame="${i}">
    <header><b>${i + 1}. ${esc(frame.title)}</b></header>
    ${previewHtml(frame, skillId, state.size)}
    ${modes.length ? `<div class="seg" role="group">${modes.map((m) => `<button class="${frame.textMode === m ? "on" : ""}" data-mode="${m}" title="${esc(modeHelp[m])}">${MODE_SHORT[m]}</button>`).join("")}</div><p class="hint">${esc(modeHelp[frame.textMode] || "")}</p>` : ""}
    ${canLayout ? `<label class="inline">文字位置<select data-layout>${Object.entries(LAYOUTS).filter(([k]) => k !== "none").map(([k, v]) => `<option value="${k}" ${frame.layout === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>` : ""}
    ${frame.textMode !== "none" && skillId !== "interior" ? `<div class="texts">${frame.texts
      .map(
        (t, j) => `<div class="text-row" data-text="${j}">
          <select data-role aria-label="文字类型">${roles.map((r) => `<option value="${r}" ${t.role === r ? "selected" : ""}>${TEXT_ROLES[r].name}</option>`).join("")}</select>
          <input data-value maxlength="${TEXT_ROLES[t.role].max}" value="${esc(t.text)}" aria-label="文字内容">
          <button class="x" data-del aria-label="删除这行">×</button></div>`,
      )
      .join("")}${frame.texts.length < (skillId === "detail" ? 2 : MAX_TEXTS) ? `<button class="link" data-add>＋ 加一行文字</button>` : ""}</div>` : ""}
    <details class="scene-desc"><summary>画面描述（AI 写的，可改）</summary><textarea data-scene rows="4" maxlength="600">${esc(frame.scene)}</textarea></details>
  </article>`;
}
function renderPlan() {
  const box = $("#plan");
  if (!box) return;
  const d = state.draft;
  updateAction();
  if (!d) return (box.innerHTML = "");
  if (d.status === "planning")
    return (box.innerHTML = `<section class="card planning"><div class="spinner"></div><div><b>AI 正在策划</b><p class="muted">看图识别商品 → 润色文案 → 规划每张图的画面和文字位置</p></div></section>`);
  if (d.status === "failed")
    return (box.innerHTML = `<section class="card warn"><b>策划没有完成</b><p>${esc(d.error)}</p></section>`);
  const skillId = d.input.skillId;
  box.innerHTML = `<section class="plan-head">
      <h2>AI 方案 <small class="muted">${d.via === "rules" ? "基础方案" : d.via === "codex" ? "由本机 Codex 策划" : "由 Kimi 策划"}</small></h2>
      ${d.plan.summary ? `<p class="summary">${esc(d.plan.summary)}</p>` : ""}
      ${d.warning ? `<p class="warn-text">${esc(d.warning)}</p>` : ""}
      ${d.plan.polishedCopy ? `<details class="polished"><summary>润色后的完整文案</summary><pre>${esc(d.plan.polishedCopy)}</pre><button class="link" id="use-polished">用它替换我写的文案</button></details>` : ""}
      <p class="muted">检查一下每张图上的字。改字、换位置都免费；点下方“确认出图”才会扣积分。</p>
    </section>
    <div class="frames ${skillId === "detail" ? "detail" : ""}">${state.frames.map((f, i) => frameEditor(f, i, skillId)).join("")}</div>`;
  bindPlan(skillId);
}
function bindPlan(skillId) {
  $("#use-polished")?.addEventListener("click", () => {
    state.copy = state.draft.plan.polishedCopy;
    $("#copy").value = state.copy;
    toast("已替换文案。方案没变，想按新文案重排可以点“重新策划”");
  });
  $$(".frame").forEach((card) => {
    const i = Number(card.dataset.frame);
    const f = state.frames[i];
    const rerender = () => {
      card.outerHTML = frameEditor(f, i, skillId);
      bindPlan(skillId);
      updateAction();
    };
    if (card.dataset.bound) return;
    card.dataset.bound = "1";
    $$("[data-mode]", card).forEach(
      (b) =>
        (b.onclick = () => {
          f.textMode = b.dataset.mode;
          if (skillId === "detail") f.layout = f.textMode === "ai" ? "top" : "none";
          else if (f.textMode !== "none" && f.layout === "none") f.layout = "top";
          if (f.textMode !== "none" && !f.texts.length) f.texts.push({ role: "headline", text: "" });
          rerender();
        }),
    );
    $("[data-layout]", card)?.addEventListener("change", (e) => {
      f.layout = e.target.value;
      rerender();
    });
    $$(".text-row", card).forEach((row) => {
      const t = f.texts[Number(row.dataset.text)];
      $("[data-role]", row).onchange = (e) => {
        t.role = e.target.value;
        t.text = Array.from(t.text).slice(0, TEXT_ROLES[t.role].max).join("");
        rerender();
      };
      const input = $("[data-value]", row);
      input.oninput = () => {
        t.text = input.value;
        const pv = $(".pv-wrap", card);
        pv.outerHTML = previewHtml(f, skillId, state.size);
      };
      $("[data-del]", row).onclick = () => {
        f.texts.splice(Number(row.dataset.text), 1);
        rerender();
      };
    });
    $("[data-add]", card)?.addEventListener("click", () => {
      f.texts.push({ role: skillId === "detail" ? "body" : "point", text: "" });
      rerender();
    });
    $("[data-scene]", card).oninput = (e) => (f.scene = e.target.value);
  });
}
async function submitJob(button) {
  const frames = state.frames.map((f) => ({ ...f, texts: f.texts.filter((t) => t.text.trim()) }));
  await busy(button, async () => {
    const job = await api("/jobs", {
      ...json({ draftId: state.draft.id, frames, providerMode: state.providerMode, resolution: state.resolution }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    });
    await refresh();
    location.hash = "#/job/" + job.id;
  });
}

/* ---------------- tasks ---------------- */
const fileUrl = (job, name, download = false) =>
  `/api/jobs/${job.id}/files/${encodeURIComponent(name)}?v=${encodeURIComponent(job.updatedAt)}${download ? "&download=1" : ""}`;
function thumb(job) {
  const assets = job.manifest?.assets || [];
  const a = assets.find((x) => x.role === "image") || assets.find((x) => x.role === "module") || assets[0];
  return a && job.status === "succeeded" ? `<img src="${fileUrl(job, a.name)}" alt="" loading="lazy">` : `<span class="ph ${job.status}">${STATUS[job.status]}</span>`;
}
function tasksPage(jobs) {
  app.innerHTML = `<div class="page-head"><h1>我的作品</h1><a class="btn primary" href="#/">＋ 新建</a></div>
  ${jobs.length ? `<div class="task-grid">${jobs
    .map(
      (j) => `<a class="task card" href="#/job/${j.id}"><div class="task-thumb">${thumb(j)}</div><div class="task-meta"><b>${esc(j.params.productName)}</b><span class="muted">${SCENE_NAME(j.params.skillId)} · ${date(j.createdAt)}</span><span class="status ${j.status}">${STATUS[j.status]}</span></div></a>`,
    )
    .join("")}</div>` : `<section class="card empty"><h2>还没有作品</h2><p class="muted">上传一张商品图，三步就能出图。</p><a class="btn primary" href="#/">开始出图</a></section>`}`;
}

/* ---------------- job ---------------- */
function checkBadge(job, i) {
  const c = job.manifest?.textCheck?.find((x) => x.frame === i);
  if (!c) return "";
  if (c.ok === null) return `<span class="badge muted-badge">文字未校对</span>`;
  if (c.ok) return `<span class="badge ok">✓ 文字已校对</span>`;
  return `<details class="badge-detail"><summary class="badge bad">⚠ ${c.problems.length} 处文字可能不一致</summary><ul>${c.problems.map((p) => `<li>应为“${esc(p.text)}”</li>`).join("")}</ul><p class="muted">AI 读到：${esc((c.seen || []).join(" / ") || "无")}</p></details>`;
}
function editableTexts(job, f) {
  if (!f) return [];
  if (job.params.skillId === "detail") return f.textMode === "ai" ? f.texts.filter((t) => t.role !== "headline") : f.texts;
  return f.textMode === "overlay" ? f.texts : [];
}
function textEditor(job, i) {
  const f = job.params.frames?.[i];
  const list = editableTexts(job, f);
  if (!list.length && !(job.params.skillId === "detail" && f)) return "";
  const roles = job.params.skillId === "detail" ? (f.textMode === "ai" ? ["body"] : ["headline", "body"]) : Object.keys(TEXT_ROLES);
  return `<details class="edit"><summary>改文字（免费，不重新出图）</summary><div class="texts" data-edit="${i}">${list
    .map((t) => `<div class="text-row"><select data-role>${roles.map((r) => `<option value="${r}" ${t.role === r ? "selected" : ""}>${TEXT_ROLES[r].name}</option>`).join("")}</select><input data-value maxlength="${TEXT_ROLES[t.role].max}" value="${esc(t.text)}"></div>`)
    .join("")}${job.params.skillId === "detail" && f.textMode === "ai" && !list.length ? `<div class="text-row"><select data-role><option value="body">说明</option></select><input data-value maxlength="60" value=""></div>` : ""}</div></details>`;
}
function jobPage(job) {
  const p = job.params;
  const m = job.manifest;
  const legacy = !p.frames;
  const cost = (n) => (workspace.skills[p.skillId]?.cost || 10) * n;
  const images = m ? m.assets.filter((a) => ["image", "module"].includes(a.role)) : [];
  const long = m?.assets.find((a) => a.role === "long" || a.role === "long-preview");
  const apiReady = workspace.providers.find((x) => x.mode === "api")?.ready;
  const canUpscale = (a) => {
    if (!apiReady || a.role !== "image" || p.skillId === "detail") return false;
    const [w, h] = upscaleSize(a.width, a.height).split("x").map(Number);
    return a.width < w || a.height < h;
  };
  app.innerHTML = `<a class="back" href="#/tasks">← 我的作品</a>
  <div class="page-head"><div><h1>${esc(p.productName)}</h1><p class="muted">${SCENE_NAME(p.skillId)} · ${date(job.createdAt)} · ${job.cost} 积分</p></div><span class="status ${job.status}">${STATUS[job.status]}</span></div>
  ${active(job) ? `<section class="card progress"><div class="spinner"></div><div><b>${esc(job.phase)}</b><p class="muted">一张图通常 1–3 分钟，可以先离开，稍后在“我的作品”里看。</p><div class="bar"></div></div><button class="btn" id="cancel">取消并退积分</button></section>` : ""}
  ${job.status === "failed" || job.status === "cancelled" ? `<section class="card warn"><b>${STATUS[job.status]}</b><p>${esc(job.error || "")}</p></section>` : ""}
  ${m?.warnings?.length ? `<p class="warn-text">${m.warnings.map(esc).join("<br>")}</p>` : ""}
  ${
    m && p.skillId === "detail"
      ? `<div class="detail-result">
          <div class="long-view card">${long ? `<img src="${fileUrl(job, long.name)}" alt="详情页长图">` : ""}</div>
          <div class="side">
            <section class="card"><h2>下载</h2>${long ? `<a class="btn primary wide" href="${fileUrl(job, long.name, true)}">下载整张长图</a>` : ""}<div class="dl-list">${images.map((a, i) => `<a class="link" href="${fileUrl(job, a.name, true)}">第 ${i + 1} 屏切片 ↓</a>`).join("")}</div></section>
            ${legacy ? "" : `<section class="card"><h2>每屏文字</h2>${images.map((a, i) => `<div class="screen"><b>第 ${i + 1} 屏</b>${checkBadge(job, i)}${textEditor(job, i)}<button class="link" data-redo="${i}">重新生成这屏 · ${cost(1)} 积分</button></div>`).join("")}<button class="btn wide" id="save-texts">保存文字并重新排版</button></section>`}
          </div></div>`
      : m
        ? `<div class="results">${images
            .map(
              (a, i) => `<article class="card result">
                <a href="${fileUrl(job, a.name)}" target="_blank" rel="noopener"><img src="${fileUrl(job, a.name)}" alt="第 ${i + 1} 张"></a>
                <div class="result-bar"><b>${esc(p.frames?.[i]?.title || `第 ${i + 1} 张`)}</b><small class="muted">${a.width}×${a.height}</small></div>
                ${checkBadge(job, i)}
                ${legacy ? "" : textEditor(job, i)}
                <div class="row wrap">
                  <a class="btn small" href="${fileUrl(job, a.name, true)}">下载</a>
                  ${legacy || p.operation === "upscale" ? "" : `<button class="btn small" data-redo="${i}">重新生成 · ${cost(1)}</button>`}
                  ${!legacy && p.frames?.[i]?.textMode === "ai" ? `<button class="btn small" data-overlay="${i}" title="重新出一张不带字的图，由程序把字排上去">改用精确排字 · ${cost(1)}</button>` : ""}
                  ${canUpscale(a) ? `<button class="link" data-upscale="${esc(a.name)}">提升到 4K · ${workspace.skills.upscale.cost}</button>` : ""}
                </div>
                ${!legacy && p.frames?.[i]?.textMode === "overlay" ? `<button class="btn small wide" data-save-one>保存文字并重新排版</button>` : ""}
              </article>`,
            )
            .join("")}</div>`
        : ""
  }
  ${!active(job) && !legacy && p.operation !== "upscale" ? `<div class="row wrap"><button class="btn" id="retry">${job.status === "succeeded" ? "整组再来一次" : "重新生成"} · ${job.cost} 积分</button><a class="btn" href="#/new/${p.skillId}">新建</a>${job.sourceId ? `<a class="link" href="#/job/${job.sourceId}">查看来源</a>` : ""}</div>` : ""}
  ${
    !legacy
      ? `<details class="card plan-detail"><summary>查看策划方案与版式稿</summary>${p.frames
          .map(
            (f, i) => `<div class="plan-row">${p.layoutFiles?.[i] ? `<img src="/api/jobs/${job.id}/source/${p.layoutFiles[i]}" alt="版式稿 ${i + 1}">` : ""}<div><b>${i + 1}. ${esc(f.title)}</b> <small class="muted">${TEXT_MODES[f.textMode]}</small><p>${esc(f.scene)}</p>${f.texts.length ? `<p class="muted">${f.texts.map((t) => esc(t.text)).join(" / ")}</p>` : ""}</div></div>`,
          )
          .join("")}<p class="muted">${p.copy ? "你的原文：" + esc(p.copy) : ""}</p></details>`
      : ""
  }`;
  bindJob(job);
}
function bindJob(job) {
  const key = () => crypto.randomUUID();
  const go = async (route, body) => {
    const next = await api(route, { ...json(body), headers: { "Content-Type": "application/json", "Idempotency-Key": key() } });
    await refresh();
    location.hash = "#/job/" + next.id;
  };
  $("#cancel")?.addEventListener("click", () => busy($("#cancel"), async () => {
    await api(`/jobs/${job.id}/cancel`, { method: "POST" });
    await refresh();
    render();
  }));
  $("#retry")?.addEventListener("click", () => busy($("#retry"), () => go(`/jobs/${job.id}/retry`, {})));
  $$("[data-redo]").forEach((b) => (b.onclick = () => busy(b, () => go(`/jobs/${job.id}/retry`, { frame: Number(b.dataset.redo) }))));
  $$("[data-overlay]").forEach((b) => (b.onclick = () => busy(b, () => go(`/jobs/${job.id}/retry`, { frame: Number(b.dataset.overlay), textMode: "overlay" }))));
  $$("[data-upscale]").forEach((b) => (b.onclick = () => busy(b, () => go(`/jobs/${job.id}/upscale`, { asset: b.dataset.upscale }))));
  const saveTexts = (button) =>
    busy(button, async () => {
      const frames = job.params.frames.map((f, i) => {
        const box = $(`[data-edit="${i}"]`);
        if (!box) return null;
        return { texts: $$(".text-row", box).map((r) => ({ role: $("[data-role]", r).value, text: $("[data-value]", r).value })).filter((t) => t.text.trim()) };
      });
      await api(`/jobs/${job.id}/texts`, json({ frames }));
      toast("已重新排版");
      render();
    });
  $("#save-texts")?.addEventListener("click", (e) => saveTexts(e.currentTarget));
  $$("[data-save-one]").forEach((b) => (b.onclick = () => saveTexts(b)));
}

/* ---------------- credits ---------------- */
function creditsPage() {
  const kinds = { reserve: "出图预扣", refund: "失败 / 取消退回", grant: "管理员充值" };
  app.innerHTML = `<div class="page-head"><h1>积分</h1></div>
  <section class="card balance-card"><b>${workspace.account.balance}</b><span class="muted">可用积分 · 出图时预扣，失败或取消自动退回，改文字免费</span></section>
  <section class="card ledger">${workspace.account.ledger.length ? workspace.account.ledger.map((l) => `<div class="ledger-row"><div><b>${kinds[l.kind] || l.kind}</b><small class="muted">${date(l.createdAt)}${l.jobId ? ` · <a href="#/job/${l.jobId}">查看</a>` : ""}</small></div><b class="${l.amount > 0 ? "plus" : ""}">${l.amount > 0 ? "+" : ""}${l.amount}</b></div>`).join("") : `<p class="muted">还没有积分记录。</p>`}</section>`;
}

/* ---------------- router ---------------- */
async function render() {
  cleanup();
  cleanup = () => {};
  const token = ++view;
  const [route, id] = location.hash.replace(/^#\/?/, "").split("/");
  try {
    if (!workspace) await refresh();
    if (token !== view) return;
    header();
    if (route === "tasks") {
      const data = await api("/jobs");
      if (token !== view) return;
      tasksPage(data.jobs);
      if (data.jobs.some(active)) {
        const t = setTimeout(render, 4000);
        cleanup = () => clearTimeout(t);
      }
    } else if (route === "job" && id) {
      const job = await api("/jobs/" + encodeURIComponent(id));
      if (token !== view) return;
      jobPage(job);
      if (active(job)) {
        const t = setTimeout(render, 3000);
        cleanup = () => clearTimeout(t);
      } else await refresh();
    } else if (route === "credits") {
      await refresh();
      if (token === view) creditsPage();
    } else createPage(route === "new" ? id : null);
  } catch (error) {
    if (token !== view) return;
    if (error.status === 401) {
      workspace = null;
      login();
    } else {
      app.innerHTML = `<section class="card empty"><h2>暂时打不开</h2><p>${esc(error.message)}</p><button class="btn" id="reload">重试</button></section>`;
      $("#reload").onclick = render;
    }
  }
}
addEventListener("hashchange", () => {
  scrollTo(0, 0);
  render();
});
render();
