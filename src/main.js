import { preview } from "./preview.js";
import { SCENES, SIZE_NAMES, TEXT_MODES, TEXT_ROLES, MAX_TEXTS } from "../shared/scenes.js";
import { CATEGORIES, IMAGE_TYPES, TONES, sceneTypes } from "../shared/styles.js";
import { IMAGE_SIZES, upscaleSize } from "../shared/generation.js";
import { initSuite } from "./suite.js";

const app = document.querySelector("#app");
const nav = document.querySelector("#nav");
const tabbar = document.querySelector("#tabbar");
let workspace = null;
let view = 0;
let cleanup = () => {};

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const date = (v) => new Date(v).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const active = (job) => ["queued", "running"].includes(job.status);
const STATUS = { partial: "部分完成", queued: "排队中", running: "生成中", succeeded: "已完成", failed: "失败 · 已退积分", cancelled: "已取消 · 已退积分" };
const SCENE_NAME = (id) => (id === "upscale" ? "4K 提升" : SCENES[id]?.name || id);
const MODE_SHORT = { ai: "AI 画字", overlay: "精确排字", none: "不加字" };
const key = () => crypto.randomUUID();

async function api(route, { timeout, ...options } = {}) {
  // Uploads get longer; nothing waits forever. `timeout` (ms) overrides for the few slow calls.
  const limit = timeout || (options.body instanceof FormData ? 180000 : 45000);
  let response;
  try {
    response = await fetch("/api" + route, { ...options, headers: { "X-Requested-With": "SkillHub", ...options.headers }, signal: AbortSignal.timeout(limit) });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new Error(`等了 ${Math.round(limit / 1000)} 秒服务器还没回应，这次没有成功。请稍后再点一次；如果是出图，先到“我的作品”看看是否已经开始。`);
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
const json = (body, headers = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
function toast(message, error = false) {
  const box = document.createElement("div");
  box.className = "toast" + (error ? " error" : "");
  box.textContent = message;
  box.setAttribute("role", "status");
  document.body.append(box);
  setTimeout(() => box.remove(), 4500);
}
// Every button that talks to the server: grey out and spin at once, come back (with the reason) if it fails.
async function busy(button, fn) {
  if (button.classList.contains("loading")) return;
  button.disabled = true;
  button.classList.add("loading");
  button.setAttribute("aria-busy", "true");
  try {
    await fn();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
    button.removeAttribute("aria-busy");
  }
}
const ICON = {
  goods: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z"/><path d="M4 8.5l8 4.5 8-4.5M12 13v7"/></svg>`,
  single: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m5 17 5-4.5 3.5 3 2.5-2 4 3.5"/></svg>`,
  styles: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="9" rx="2"/><rect x="13" y="4" width="7" height="5" rx="2"/><rect x="13" y="11" width="7" height="9" rx="2"/><rect x="4" y="15" width="7" height="5" rx="2"/></svg>`,
  works: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h9"/></svg>`,
};
function header() {
  const route = location.hash.replace(/^#\/?/, "").split("/")[0];
  const on = (r) => (r.includes(route) ? "on" : "");
  const main = [
    ["#/", "商品", ["", "suite"], "goods"],
    ["#/new/product", "单张出图", ["new"], "single"],
    ["#/styles", "风格库", ["styles"], "styles"],
    ["#/tasks", "我的作品", ["tasks", "job"], "works"],
  ];
  nav.innerHTML = workspace
    ? `${main.map(([href, name, r]) => `<a href="${href}" class="main ${on(r)}">${name}</a>`).join("")}${isAdmin() ? `<a href="#/admin" class="${on(["admin"])}">管理</a>` : ""}<a class="balance ${on(["credits"])} ${workspace.checkin && !workspace.checkin.today ? "todo" : ""}" href="#/credits" title="${esc(workspace.user.name)}${workspace.checkin && !workspace.checkin.today ? "（今天还没签到）" : ""}"><b>${workspace.account.balance}</b> 积分</a><button class="link" id="logout">退出</button>`
    : "";
  // Phones get the four main places as a bottom bar; the top keeps only credits.
  tabbar.innerHTML = workspace ? main.map(([href, name, r, icon]) => `<a href="${href}" class="${on(r)}">${ICON[icon]}<span>${name}</span></a>`).join("") : "";
  document.body.classList.toggle("signed-in", !!workspace);
  $("#logout")?.addEventListener("click", () =>
    busy($("#logout"), async () => {
      await api("/logout", { method: "POST" });
      workspace = null;
      styleCache = null;
      location.hash = "#/";
      render();
    }),
  );
}
async function refresh() {
  workspace = await api("/workspace");
  header();
}
const isAdmin = () => workspace?.user?.role === "admin";
// Login / sign-up. A shared link #/join/<邀请码> opens sign-up with the code filled in.
function login(mode, invite = "") {
  nav.innerHTML = "";
  tabbar.innerHTML = "";
  document.body.classList.remove("signed-in");
  const [route, code] = location.hash.replace(/^#\/?/, "").split("/");
  if (!mode) mode = route === "join" ? "register" : "login";
  if (route === "join" && code) invite = decodeURIComponent(code);
  const forms = {
    login: `<label>手机号<input name="phone" type="tel" inputmode="tel" autocomplete="username" required placeholder="注册时用的手机号"></label>
      <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn primary wide">登录</button>`,
    register: `<label>邀请码<input name="invite" required value="${esc(invite)}" placeholder="找管理员要" autocomplete="off"></label>
      <label>手机号<input name="phone" type="tel" inputmode="tel" autocomplete="username" required placeholder="以后用它登录"></label>
      <label>设个密码<input name="password" type="password" autocomplete="new-password" required minlength="6" placeholder="至少 6 位"></label>
      <label>确认密码<input id="confirm-password" type="password" autocomplete="new-password" required placeholder="请再输入一次密码"></label>
      <label>店铺 / 称呼<input name="name" maxlength="20" placeholder="选填，例如：阿海水产"></label>
      <button class="btn primary wide">注册并进入</button>`,
    code: `<label>管理员访问码<input name="code" type="password" autocomplete="current-password" required></label>
      <button class="btn primary wide">进入</button>`,
  };
  app.innerHTML = `<section class="login card"><h1>星图</h1><p class="muted">一个商品，一键出笔记、商品图和详情页。</p>
    ${mode === "code" ? "" : `<div class="seg"><button data-mode="login" class="${mode === "login" ? "on" : ""}">登录</button><button data-mode="register" class="${mode === "register" ? "on" : ""}">注册</button></div>`}
    <form id="login-form">${forms[mode]}<p class="err" id="login-error" role="alert"></p></form>
    <button class="link login-alt" id="alt">${mode === "code" ? "← 用手机号登录" : "管理员用访问码登录"}</button></section>`;
  $$("[data-mode]").forEach((b) => (b.onclick = () => login(b.dataset.mode, $("[name=invite]")?.value || invite)));
  $("#alt").onclick = () => login(mode === "code" ? "login" : "code");
  const form = $("#login-form");
  const confirmation = $("#confirm-password", form);
  if (confirmation) {
    form.addEventListener("input", () => confirmation.setCustomValidity(""));
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (confirmation && confirmation.value !== form.elements.password.value) {
      confirmation.setCustomValidity("两次输入的密码不一致，请重新确认。");
      confirmation.reportValidity();
      confirmation.select();
      return;
    }
    const b = e.currentTarget.querySelector("button");
    const body = Object.fromEntries(new FormData(e.currentTarget));
    b.disabled = true;
    try {
      await api(mode === "register" ? "/register" : "/login", json(body));
      styleCache = null;
      await refresh();
      if (location.hash.startsWith("#/join")) location.hash = "#/";
      else render();
      if (mode === "register") toast(`注册成功，送你 ${workspace.account.balance} 积分`);
    } catch (error) {
      $("#login-error").textContent = error.message;
    } finally {
      b.disabled = false;
    }
  };
}

/* ---------------- shared: style visuals ---------------- */
let styleCache = null;
async function loadStyles(force = false) {
  if (!styleCache || force) styleCache = (await api("/styles")).styles;
  return styleCache;
}
const styleOf = (id) => styleCache?.find((s) => s.id === id);
function swatches(palette = []) {
  return `<span class="swatches">${palette.map((c) => `<i data-color="${esc(c)}"></i>`).join("")}</span>`;
}
// CSP forbids inline style attributes; colors are applied through the CSSOM.
function paint(root = document) {
  $$("[data-color]", root).forEach((el) => (el.style.background = el.dataset.color));
  $$("[data-gradient]", root).forEach((el) => {
    const p = el.dataset.gradient.split(",");
    el.style.background = `linear-gradient(135deg, ${p.join(", ")})`;
  });
}
function coverHtml(style, fallbackUrl = null) {
  if (style?.cover) return `<img src="${preview(style.cover,320)}" alt="${esc(style.name)} 样图" loading="lazy">`;
  if (fallbackUrl) return `<img src="${fallbackUrl.startsWith("/api/") ? preview(fallbackUrl,320) : fallbackUrl}" alt="参考图">`;
  return `<div class="cover-ph" data-gradient="${esc((style?.palette || ["#eee", "#ccc"]).join(","))}"><span>${esc(style?.name || "")}</span></div>`;
}

/* ---------------- create ---------------- */
const state = {
  scene: "product",
  main: null,
  refs: [],
  copy: "",
  count: SCENES.product.defaultCount,
  size: SCENES.product.defaultSize,
  styleId: "",
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
  const st = styleOf(state.styleId);
  if (st && !st.types.some((t) => sceneTypes[id].includes(t))) state.styleId = "";
  state.draft = null;
  state.frames = null;
  state.filesDirty = true;
}
const invalidate = (files) => {
  if (files) state.filesDirty = true;
  if (state.draft) state.stale = true;
};

async function createPage(sceneParam) {
  await loadStyles();
  if (sceneParam && SCENES[sceneParam]) setScene(sceneParam);
  const s = SCENES[state.scene];
  state.providerMode ||= workspace.provider.mode;
  const chosen = styleOf(state.styleId);
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
          <span class="drop-label">${s.mainLabel}${s.mainRequired ? " <em>必传</em>" : ""}</span>
          ${state.main ? `<span class="swap">点击更换</span>` : `<small>点击或拖入 · JPG / PNG / WebP</small>`}
        </label>
        <div class="refs">
          <span class="refs-title">照这个感觉做 <small>可选 · 喜欢的图最多 3 张</small></span>
          <div class="ref-row">${state.urls.refs
            .map((u, i) => `<div class="ref"><img src="${u}" alt="参考图 ${i + 1}"><button class="x" data-remove-ref="${i}" aria-label="移除参考图">×</button></div>`)
            .join("")}${state.refs.length < 3 ? `<label class="ref add"><input type="file" id="ref-file" accept="image/png,image/jpeg,image/webp" multiple hidden>＋</label>` : ""}</div>
          <div class="chosen-style">${
            chosen
              ? `<span class="muted">已选风格</span><b>${esc(chosen.name)}</b>${swatches(chosen.palette)}<button class="link" id="clear-style">不指定</button>`
              : `<span class="muted">也可以先去</span><a class="link" href="#/styles">风格库</a><span class="muted">挑一个样子</span>`
          }</div>
        </div>
      </div>
      <label class="note-label">${s.copyLabel}<textarea id="copy" rows="3" maxlength="1500" placeholder="${esc(s.copyPlaceholder)}">${esc(state.copy)}</textarea></label>
      <div class="row wrap specs">
        <div class="pills">${s.counts.map((c) => `<button class="pill ${c === state.count ? "on" : ""}" data-count="${c}">${c} ${s.unit}</button>`).join("")}</div>
        ${s.sizes.length > 1 ? `<div class="pills">${s.sizes.map((z) => `<button class="pill ${z === state.size ? "on" : ""}" data-size="${z}">${SIZE_NAMES[z]}</button>`).join("")}</div>` : `<span class="muted">每屏 3:4 竖版，自动拼成长图</span>`}
      </div>
      <details class="advanced"><summary>高级设置</summary>
        <div class="row wrap">
          <label>出图通道<select id="provider">${workspace.providers.map((p) => `<option value="${p.mode}" ${p.mode === state.providerMode ? "selected" : ""}>${esc(p.label)}${p.ready ? "" : "（未就绪）"}</option>`).join("")}</select></label>
          <label id="res-wrap">清晰度<select id="resolution"></select></label>
        </div>
        <p class="muted">AI 策划：${esc(workspace.textAI.label)}${workspace.textAI.ready ? "" : " —— 只能给出常用风格和基础分镜"}${workspace.textAI.lastError ? `（上次错误：${esc(workspace.textAI.lastError)}）` : ""}</p>
      </details>
    </section>
    <div id="plan"></div>
    <div class="actionbar"><div class="actionbar-in"><span id="action-note" class="muted"></span><button class="btn primary" id="action"></button></div></div>
  </div>`;
  paint(app);
  bindInputs();
  renderPlan();
  if (state.draft && ["analyzing", "storyboarding"].includes(state.draft.status)) pollDraft();
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
  drop.ondragover = (e) => (e.preventDefault(), drop.classList.add("over"));
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => (e.preventDefault(), takeMain(e.dataTransfer.files[0]));
  $("#ref-file")?.addEventListener("change", (e) => {
    for (const file of [...e.target.files].slice(0, 3 - state.refs.length)) {
      if (file.size > 10 * 1024 * 1024) continue;
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
  $("#clear-style")?.addEventListener("click", () => ((state.styleId = ""), invalidate(true), createPage()));
  $("#copy").oninput = (e) => ((state.copy = e.target.value), invalidate(false), updateAction());
  $$("[data-count]").forEach((b) => (b.onclick = () => ((state.count = Number(b.dataset.count)), invalidate(false), createPage())));
  $$("[data-size]").forEach((b) => (b.onclick = () => ((state.size = b.dataset.size), invalidate(false), createPage())));
  $("#provider").onchange = (e) => ((state.providerMode = e.target.value), syncProvider());
  $("#resolution").onchange = (e) => (state.resolution = e.target.value);
  syncProvider();
}
function syncProvider() {
  const p = workspace.providers.find((x) => x.mode === state.providerMode) || workspace.provider;
  $("#res-wrap").hidden = p.mode !== "api";
  const sizes = IMAGE_SIZES[state.size];
  if (!sizes[state.resolution]) state.resolution = "2K";
  $("#resolution").innerHTML = Object.entries(sizes)
    .map(([tier, px]) => `<option value="${tier}" ${tier === state.resolution ? "selected" : ""}>${tier} · ${px.replace("x", "×")}</option>`)
    .join("");
  updateAction();
}

function updateAction() {
  const b = $("#action");
  if (!b) return;
  const note = $("#action-note");
  const d = state.draft;
  b.disabled = false;
  if (d && ["analyzing", "storyboarding"].includes(d.status)) {
    b.textContent = d.status === "analyzing" ? "AI 正在看图…" : "AI 正在写分镜…";
    b.disabled = true;
    note.textContent = d.status === "analyzing" ? "通常 20–60 秒" : "通常 1–2 分钟";
    return;
  }
  if (!d || d.status === "failed" || state.stale || state.filesDirty) {
    b.textContent = d ? "按新内容重新出方案 →" : "AI 出方案 →";
    note.textContent = "先看方案和文字，确认后才扣积分";
    b.onclick = () => startDraft();
    return;
  }
  if (d.status === "directions") {
    b.textContent = "选一个方向";
    b.disabled = true;
    note.textContent = "点上面任意一个方向的“用这个”";
    return;
  }
  const cost = workspace.skills[state.scene].cost * state.frames.length;
  b.textContent = `确认出图 · ${cost} 积分`;
  note.textContent = cost > workspace.account.balance ? "积分不足，请联系管理员" : `余额 ${workspace.account.balance} · 失败或取消自动退回`;
  b.disabled = cost > workspace.account.balance;
  b.onclick = () => submitJob(b);
}
async function startDraft() {
  const s = SCENES[state.scene];
  const reuse = state.draft && !state.filesDirty && state.draft.input.skillId === state.scene;
  if (s.mainRequired && !state.main && !reuse) return toast(`请先上传${s.mainLabel}`, true);
  const fields = { copy: state.copy, count: state.count, size: state.size, styleId: state.styleId };
  try {
    let d;
    if (reuse) d = await api(`/drafts/${state.draft.id}/replan`, json(fields));
    else {
      const form = new FormData();
      form.set("skillId", state.scene);
      for (const [k, v] of Object.entries(fields)) form.set(k, String(v));
      if (state.main) form.append("main", state.main);
      for (const r of state.refs) form.append("reference", r);
      d = await api("/drafts", { method: "POST", body: form });
      state.filesDirty = false;
    }
    state.draft = d;
    state.frames = null;
    state.stale = false;
    renderPlan();
    $("#plan")?.scrollIntoView({ behavior: "smooth", block: "center" });
    pollDraft();
  } catch (error) {
    toast(error.message, true);
  }
}
let polling = null;
function pollDraft() {
  const id = state.draft?.id;
  if (polling === id) return;
  polling = id;
  const tick = async () => {
    if (state.draft?.id !== id || !["analyzing", "storyboarding"].includes(state.draft.status)) return (polling = null);
    try {
      state.draft = await api("/drafts/" + id);
    } catch (error) {
      state.draft = { ...state.draft, status: "failed", error: error.message };
    }
    const here = /^#?\/?(new.*)?$/.test(location.hash);
    if (state.draft.status === "ready") state.frames = structuredClone(state.draft.frames);
    if (["directions", "ready"].includes(state.draft.status) && state.draft.warning) toast(state.draft.warning, true);
    if (here) {
      renderPlan();
      if (["directions", "ready"].includes(state.draft.status)) $("#plan")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (["analyzing", "storyboarding"].includes(state.draft.status)) setTimeout(tick, 1500);
    else polling = null;
  };
  setTimeout(tick, 1500);
}

function directionCard(dir, i, chosen) {
  const style = styleOf(dir.styleId);
  const refUrl = dir.styleId === "ref" ? state.urls.refs[0] || (state.draft ? `/api/drafts/${state.draft.id}/input/${state.draft.hasMainImage ? 1 : 0}` : null) : null;
  return `<article class="card direction ${chosen ? "on" : ""}">
    <div class="dir-cover">${coverHtml(style, refUrl)}<span class="dir-style">${esc(dir.styleName)}</span></div>
    <div class="dir-body">
      <h3>${esc(dir.conceptName)}</h3>
      <p>${esc(dir.story)}</p>
      ${swatches(dir.palette)}
      <dl><dt>道具</dt><dd>${esc(dir.props)}</dd><dt>光线</dt><dd>${esc(dir.light)}</dd><dt>排版</dt><dd>${esc(dir.type)}</dd></dl>
      ${dir.why ? `<p class="why">${esc(dir.why)}</p>` : ""}
      <button class="btn ${chosen ? "" : "primary"} wide" data-choose="${i}">${chosen ? "重新写分镜" : "用这个方向"}</button>
    </div>
  </article>`;
}
function frameEditor(frame, i, skillId) {
  const roles = Object.keys(TEXT_ROLES);
  const modes = skillId === "interior" ? [] : ["ai", "none", "overlay"];
  return `<article class="card frame" data-frame="${i}">
    <header><b>${i + 1}. ${esc(frame.title)}</b>${modes.length ? `<div class="seg small">${modes.map((m) => `<button class="${frame.textMode === m ? "on" : ""}" data-mode="${m}" title="${esc(TEXT_MODES[m])}">${MODE_SHORT[m]}</button>`).join("")}</div>` : ""}</header>
    <label class="scene-label">画面<textarea data-scene rows="4" maxlength="800">${esc(frame.scene)}</textarea></label>
    ${frame.textMode !== "none" && skillId !== "interior" ? `<div class="texts">${frame.texts
      .map(
        (t, j) => `<div class="text-row" data-text="${j}">
          <select data-role aria-label="文字类型">${roles.map((r) => `<option value="${r}" ${t.role === r ? "selected" : ""}>${TEXT_ROLES[r].name}</option>`).join("")}</select>
          <input data-value maxlength="${TEXT_ROLES[t.role].max}" value="${esc(t.text)}" aria-label="文字内容">
          <button class="x" data-del aria-label="删除这行">×</button></div>`,
      )
      .join("")}${frame.texts.length < MAX_TEXTS ? `<button class="link" data-add>＋ 加一行文字</button>` : ""}</div>` : ""}
    ${frame.textMode === "overlay" ? `<p class="hint">精确排字：图上留白，程序把字排上去，适合价格、菜单、参数</p>` : ""}
  </article>`;
}
function renderPlan() {
  const box = $("#plan");
  if (!box) return;
  updateAction();
  const d = state.draft;
  if (!d) return (box.innerHTML = "");
  if (d.status === "analyzing")
    return (box.innerHTML = `<section class="card planning"><div class="spinner"></div><div><b>AI 正在看图</b><p class="muted">识别商品 → 判断气质和人群 → 从风格库挑 3 个方向并改造成专属方案</p></div></section>`);
  if (d.status === "failed") return (box.innerHTML = `<section class="card warn"><b>没有完成</b><p>${esc(d.error)}</p></section>`);
  const a = d.analysis || {};
  const seen = [a.product, a.material, a.mood, a.audience && "适合" + a.audience].filter(Boolean).join(" · ");
  box.innerHTML = `
    <section class="plan-head">
      <div class="row spread"><h2>选一个方向 <small class="muted">${d.via === "rules" ? "常用风格" : d.via === "codex" ? "本机 Codex" : d.via === "deepseek" ? "DeepSeek" : "Kimi"}</small></h2><button class="link" id="reroll">换一批</button></div>
      ${seen ? `<p class="summary">AI 看到的：${esc(seen)}</p>` : ""}
      ${d.warning ? `<p class="warn-text">${esc(d.warning)}</p>` : ""}
    </section>
    <div class="directions">${d.directions.map((dir, i) => directionCard(dir, i, d.chosen === i)).join("")}</div>
    ${
      d.status === "storyboarding"
        ? `<section class="card planning"><div class="spinner"></div><div><b>AI 正在写分镜</b><p class="muted">按选定方向，规划每一张的画面、排版和文字（通常 1–2 分钟）</p></div></section>`
        : d.status === "ready" && state.frames
          ? `<section class="plan-head"><h2>分镜 <small class="muted">${esc(d.directions[d.chosen].conceptName)}</small></h2>
              ${d.polishedCopy ? `<details class="polished"><summary>AI 整理的文案</summary><pre>${esc(d.polishedCopy)}</pre></details>` : ""}
              <p class="muted">重点看图上的字：改字、删行都免费。确认后才扣积分。</p></section>
             <div class="frames">${state.frames.map((f, i) => frameEditor(f, i, d.input.skillId)).join("")}</div>`
          : ""
    }`;
  paint(box);
  $("#reroll").onclick = () => startDraft();
  $$("[data-choose]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          state.draft = await api(`/drafts/${d.id}/choose`, json({ index: Number(b.dataset.choose) }));
          state.frames = null;
          renderPlan();
          pollDraft();
        })),
  );
  bindFrames(d.input.skillId);
}
function bindFrames(skillId) {
  $$(".frame").forEach((card) => {
    const i = Number(card.dataset.frame);
    const f = state.frames[i];
    const rerender = () => {
      card.outerHTML = frameEditor(f, i, skillId);
      bindFrames(skillId);
    };
    if (card.dataset.bound) return;
    card.dataset.bound = "1";
    $$("[data-mode]", card).forEach(
      (b) =>
        (b.onclick = () => {
          f.textMode = b.dataset.mode;
          f.layout = f.textMode === "overlay" ? "top" : f.textMode === "ai" ? "free" : "none";
          if (f.textMode !== "none" && !f.texts.length) f.texts.push({ role: "headline", text: "" });
          rerender();
        }),
    );
    $$(".text-row", card).forEach((row) => {
      const t = f.texts[Number(row.dataset.text)];
      $("[data-role]", row).onchange = (e) => {
        t.role = e.target.value;
        t.text = Array.from(t.text).slice(0, TEXT_ROLES[t.role].max).join("");
        rerender();
      };
      $("[data-value]", row).oninput = (e) => (t.text = e.target.value);
      $("[data-del]", row).onclick = () => (f.texts.splice(Number(row.dataset.text), 1), rerender());
    });
    $("[data-add]", card)?.addEventListener("click", () => (f.texts.push({ role: "body", text: "" }), rerender()));
    $("[data-scene]", card).oninput = (e) => (f.scene = e.target.value);
  });
}
async function submitJob(button) {
  const frames = state.frames.map((f) => {
    const texts = f.texts.filter((t) => t.text.trim());
    return { ...f, texts, textMode: texts.length ? f.textMode : "none" };
  });
  await busy(button, async () => {
    const job = await api("/jobs", json({ draftId: state.draft.id, frames, providerMode: state.providerMode, resolution: state.resolution }, { "Idempotency-Key": key() }));
    await refresh();
    location.hash = "#/job/" + job.id;
  });
}

/* ---------------- style library ---------------- */
const lib = { cat: "", type: "", tone: "", mine: false };
async function stylesPage() {
  const all = await loadStyles(true);
  if (!location.hash.startsWith("#/styles")) return;
  renderStyleFilters(all);
  if (all.some((s) => s.status === "analyzing")) {
    const t = setTimeout(() => location.hash.startsWith("#/styles") && stylesPage(), 3000);
    cleanup = () => clearTimeout(t);
  }
}
function renderStyleFilters(all) {
  const list = all.filter(
    (s) =>
      (!lib.cat || s.categories?.includes(lib.cat)) &&
      (!lib.type || s.types?.includes(lib.type)) &&
      (!lib.tone || s.tone === lib.tone) &&
      (!lib.mine || (s.source === "upload" && (s.mine || isAdmin()))),
  );
  const chips = (field, items) =>
    `<button class="chip ${!lib[field] ? "on" : ""}" data-f="${field}" data-v="">全部</button>${items
      .map(([v, n]) => `<button class="chip ${lib[field] === v ? "on" : ""}" data-f="${field}" data-v="${esc(v)}">${esc(n)}</button>`)
      .join("")}`;
  const extra = [lib.type, lib.tone, lib.mine].filter(Boolean).length;
  app.innerHTML = `<div class="page-head"><div><h1>风格库</h1><p class="muted">挑一个样子直接用；看到好图就传上来，AI 会拆成可复用的配方。</p></div><div class="row wrap">${isAdmin() && all.some((s) => s.source === "builtin" && !s.cover && !s.types.includes("interior")) ? `<button class="btn" id="all-covers">批量生成缺失样图</button>` : ""}<button class="btn primary" id="upload-style">上传好图</button></div></div>
  <div class="lib-bar">
    <div class="lib-cats" role="group" aria-label="品类">${chips("cat", CATEGORIES.map((c) => [c, c]))}</div>
    <button class="btn small lib-toggle ${extra ? "has" : ""}" id="lib-more" aria-expanded="${!!lib.open}">筛选${extra ? ` ${extra}` : ""}</button>
  </div>
  <section class="filters card" id="lib-filters" ${lib.open ? "" : "hidden"}>
    <div class="filter"><span>类型</span>${chips("type", Object.entries(IMAGE_TYPES))}</div>
    <div class="filter"><span>调性</span>${chips("tone", TONES.map((t) => [t, t]))}</div>
    <div class="filter"><span>来源</span><button class="chip ${!lib.mine ? "on" : ""}" data-mine="0">全部</button><button class="chip ${lib.mine ? "on" : ""}" data-mine="1">我上传的</button></div>
  </section>
  <p class="muted lib-count">${list.length} 个风格${lib.cat || extra ? ` <button class="link" id="lib-clear">清空筛选</button>` : ""}</p>
  ${list.length ? "" : `<section class="card empty"><h2>这个组合下还没有风格</h2><p class="muted">换一个品类，或者把筛选清空看看。</p></section>`}
  <div class="style-grid">${list
    .map(
      (s) => `<button class="style-card" data-style="${esc(s.id)}">
        <div class="style-cover">${coverHtml(s)}${s.status === "analyzing" ? `<span class="badge-on">AI 拆解中…</span>` : s.status === "failed" ? `<span class="badge-on bad">拆解失败</span>` : ""}</div>
        <div class="style-meta"><b>${esc(s.name)}</b><small>${esc(s.tagline || "")}</small><span class="tags">${[s.tone, ...(s.types || []).map((t) => IMAGE_TYPES[t])].filter(Boolean).slice(0, 3).map((t) => `<i>${esc(t)}</i>`).join("")}</span></div>
      </button>`,
    )
    .join("")}</div>`;
  paint(app);
  $$("[data-f]").forEach((b) => (b.onclick = () => ((lib[b.dataset.f] = b.dataset.v), renderStyleFilters(all))));
  $$("[data-mine]").forEach((b) => (b.onclick = () => ((lib.mine = b.dataset.mine === "1"), renderStyleFilters(all))));
  $$("[data-style]").forEach((b) => (b.onclick = () => styleModal(b.dataset.style)));
  $("#lib-more").onclick = () => ((lib.open = !lib.open), renderStyleFilters(all));
  $("#lib-clear")?.addEventListener("click", () => (Object.assign(lib, { cat: "", type: "", tone: "", mine: false }), renderStyleFilters(all)));
  $(".lib-cats .chip.on")?.scrollIntoView({ block: "nearest", inline: "center" });
  $("#upload-style").onclick = uploadModal;
  $("#all-covers")?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const codex = workspace.providers.find((p) => p.mode === "codex")?.ready;
      const r = await api("/styles-covers", json({ providerMode: codex ? "codex" : "api" }));
      toast(`已排队 ${r.queued} 张样图（${codex ? "本机 Codex" : "中转站"}，不扣积分），生成好会自动出现`);
    }),
  );
}
function modal(html) {
  const wrap = document.createElement("div");
  wrap.className = "modal";
  wrap.innerHTML = `<div class="modal-box card" role="dialog" aria-modal="true"><button class="x close" aria-label="关闭">×</button>${html}</div>`;
  document.body.append(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) close();
  });
  $(".close", wrap).onclick = close;
  paint(wrap);
  return { wrap, close };
}
// "Keep this picture, change one thing": the finished image becomes the base.
const TWEAK_IDEAS = ["背景再亮一点", "换成干净的浅色背景", "商品再放大一些", "去掉多余的道具", "整体颜色更暖一些", "光线更有质感", "字再大一点"];
function tweakModal(job, i) {
  const p = job.params;
  const frame = p.frames[i];
  const asset = job.manifest.assets.filter((a) => ["image", "module"].includes(a.role)).find((a, pos) => (a.frame ?? pos) === i);
  const cost = workspace.skills[p.skillId]?.cost || 10;
  const aiTexts = frame.textMode === "ai" ? frame.texts : [];
  const { wrap, close } = modal(`
    <div class="tweak">
      <div class="tweak-img"><img src="${preview(fileUrl(job, asset.name))}" alt="要微调的图"></div>
      <form class="tweak-form">
        <h2>修改图片 · ${esc(frame.title || `第 ${i + 1} 张`)}</h2>
        <p class="muted">以这张图为底，只改你说的地方，其他尽量不动。原图会一直保留。</p>
        <label>想怎么改？<textarea name="instruction" rows="3" maxlength="300" placeholder="例如：背景再亮一点，去掉左边的柠檬"></textarea></label>
        <div class="chips">${TWEAK_IDEAS.map((t) => `<button type="button" class="chip" data-idea="${esc(t)}">${esc(t)}</button>`).join("")}</div>
        ${aiTexts.length ? `<details class="tweak-texts"><summary>顺便改图上的字</summary>${aiTexts.map((t, j) => `<label class="text-row two"><span class="muted">${TEXT_ROLES[t.role]?.name || "文字"}</span><input data-tt="${j}" maxlength="${TEXT_ROLES[t.role]?.max || 40}" value="${esc(t.text)}"></label>`).join("")}</details>` : ""}
        <p class="hint">一次只改一两处，效果最好。改完会自动核对图上的字，并和原图并排给你看。</p>
        <p class="err" role="alert"></p>
        <button class="btn primary wide">开始微调 · ${cost} 积分</button>
      </form>
    </div>`);
  const form = $(".tweak-form", wrap);
  const area = form.instruction;
  $$("[data-idea]", wrap).forEach((b) => (b.onclick = () => {
    area.value = area.value.trim() ? `${area.value.trim().replace(/[，。；,;]$/, "")}，${b.dataset.idea}` : b.dataset.idea;
    area.focus();
  }));
  area.focus();
  form.onsubmit = (e) => {
    e.preventDefault();
    const body = { frame: i, instruction: area.value.trim() };
    if (aiTexts.length) body.texts = aiTexts.map((t, j) => ({ role: t.role, text: $(`[data-tt="${j}"]`, form).value.trim() })).filter((t) => t.text);
    busy(form.querySelector("button.primary"), async () => {
      try {
        const next = await api(`/jobs/${job.id}/tweak`, json(body, { "Idempotency-Key": key() }));
        close();
        await refresh();
if (p.suiteId) {
          // Made inside a product: stay there, the new version replaces the picture when it is ready.
          await refresh();
          toast("正在修改，好了会直接替换这张图");
          if (location.hash.startsWith("#/suite/" + p.suiteId)) render();
          else location.hash = `#/suite/${p.suiteId}/${p.skillId === "detail" ? "detail" : "shots"}`;
        } else location.hash = "#/job/" + next.id;
      } catch (error) {
        $(".err", form).textContent = error.message;
      }
    });
  };
}
function styleModal(id) {
  const s = styleOf(id);
  if (!s) return;
  const scenes = Object.keys(SCENES).filter((sc) => s.types?.some((t) => sceneTypes[sc].includes(t)));
  const codexReady = workspace.providers.find((p) => p.mode === "codex")?.ready;
  const { wrap, close } = modal(`
    <div class="style-detail">
      <div class="style-detail-cover">${coverHtml(s)}</div>
      <div>
        <h2>${esc(s.name)}</h2>
        <p>${esc(s.tagline || "")}</p>
        ${swatches(s.palette)}
        <p class="tags">${[...(s.categories || []), ...(s.types || []).map((t) => IMAGE_TYPES[t]), s.tone].filter(Boolean).map((t) => `<i>${esc(t)}</i>`).join("")}</p>
        ${s.status === "failed" ? `<p class="warn-text">${esc(s.error || "")}</p>` : ""}
        <dl><dt>道具材质</dt><dd>${esc(s.props)}</dd><dt>光线</dt><dd>${esc(s.light)}</dd><dt>机位构图</dt><dd>${esc(s.camera)}</dd><dt>字体排版</dt><dd>${esc(s.type)}</dd><dt>避免</dt><dd>${esc(s.avoid)}</dd><dt>提示词核心</dt><dd class="mono">${esc(s.core)}</dd>${s.prompt ? `<dt>原始提示词</dt><dd class="mono">${esc(s.prompt)}</dd>` : ""}</dl>
        <div class="row wrap">${scenes.map((sc) => `<button class="btn primary" data-use="${sc}">用它做${SCENES[sc].name}</button>`).join("")}
          ${isAdmin() && s.source === "builtin" && !s.types.includes("interior") ? `<button class="btn" id="make-cover">${s.cover ? "重新生成样图" : "生成样图"}${codexReady ? "（本机 Codex，不扣积分）" : "（中转站，不扣积分）"}</button>` : ""}
          ${isAdmin() && s.source === "upload" && s.status === "ready" ? `<button class="btn" id="share-style">${s.shared ? "取消公开" : "公开给所有商家"}</button>` : ""}
          ${s.source === "upload" && (s.mine || isAdmin()) ? `<button class="link" id="del-style">删除</button>` : ""}</div>
        ${s.source === "upload" ? `<p class="muted">${s.shared ? "已公开：所有商家都能看到和使用" : "仅自己可见"}</p>` : ""}
      </div>
    </div>`);
  $$("[data-use]", wrap).forEach(
    (b) =>
      (b.onclick = () => {
        state.styleId = s.id;
        state.draft = null;
        state.filesDirty = true;
        close();
        location.hash = "#/new/" + b.dataset.use;
      }),
  );
  $("#make-cover", wrap)?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const job = await api(`/styles/${s.id}/cover`, json({}, { "Idempotency-Key": key() }));
      await refresh();
      toast("已开始生成样图，完成后会出现在风格库");
      close();
      void job;
    }),
  );
  $("#share-style", wrap)?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      await api(`/styles/${s.id}/share`, json({ shared: !s.shared }));
      close();
      stylesPage();
      toast(s.shared ? "已改为仅上传者可见" : "已公开，所有商家都能在风格库看到");
    }),
  );
  $("#del-style", wrap)?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      await api(`/styles/${s.id}`, { method: "DELETE" });
      close();
      stylesPage();
    }),
  );
}
function uploadModal() {
  const { wrap, close } = modal(`
    <h2>上传好图</h2>
    <p class="muted">传一张你觉得“合格”的图（小红书、Pinterest、竞品都行），有提示词就一起贴上。AI 会把它拆成可复用的风格配方，只在你的工作台里可见。</p>
    <form id="style-form" class="stack">
      <label class="drop small" id="style-drop"><input type="file" id="style-file" accept="image/png,image/jpeg,image/webp" hidden><span class="plus">＋</span><span>选择图片</span></label>
      <label>风格名（可选）<input id="style-name" maxlength="16" placeholder="不填由 AI 起名"></label>
      <label>提示词（可选）<textarea id="style-prompt" rows="5" maxlength="2000" placeholder="作者附带的提示词，有就贴上，能拆得更准"></textarea></label>
      <button class="btn primary wide">上传并拆解</button>
    </form>`);
  let file = null;
  $("#style-file", wrap).onchange = (e) => {
    file = e.target.files[0];
    if (!file) return;
    $("#style-drop", wrap).innerHTML = `<img src="${URL.createObjectURL(file)}" alt="已选择的图片">`;
    $("#style-drop", wrap).classList.add("has");
  };
  $("#style-form", wrap).onsubmit = (e) => {
    e.preventDefault();
    if (!file) return toast("请先选择图片", true);
    busy(e.submitter || $("button.primary", wrap), async () => {
      const form = new FormData();
      form.set("image", file);
      form.set("name", $("#style-name", wrap).value);
      form.set("prompt", $("#style-prompt", wrap).value);
      await api("/styles", { method: "POST", body: form });
      close();
      lib.mine = true;
      toast("已上传，AI 正在拆解风格（约 20–40 秒）");
      stylesPage();
    });
  };
}

/* ---------------- tasks ---------------- */
const fileUrl = (job, name, download = false) =>
  `/api/jobs/${job.id}/files/${encodeURIComponent(name)}?v=${encodeURIComponent(job.updatedAt)}${download ? "&download=1" : ""}`;
function thumb(job) {
  const assets = job.manifest?.assets || [];
  const a = assets.find((x) => x.role === "image") || assets.find((x) => x.role === "module") || assets[0];
  return a && ["succeeded","partial"].includes(job.status) ? `<img src="${preview(fileUrl(job, a.name),320)}" alt="" loading="lazy">` : `<span class="ph ${job.status}">${STATUS[job.status]}</span>`;
}
function tasksPage(jobs) {
  app.innerHTML = `<div class="page-head"><h1>我的作品</h1><a class="btn primary" href="#/">＋ 新建</a></div>
  ${jobs.length ? `<div class="task-grid">${jobs
    .map(
      (j) => `<a class="task card" href="#/job/${j.id}"><div class="task-thumb">${thumb(j)}</div><div class="task-meta"><b>${esc(j.params.productName)}</b><span class="muted">${j.params.operation === "cover" ? "风格样图" : SCENE_NAME(j.params.skillId)} · ${date(j.createdAt)}</span><span class="status ${j.status}">${STATUS[j.status]}</span></div></a>`,
    )
    .join("")}</div>` : `<section class="card empty"><h2>还没有作品</h2><p class="muted">上传一张商品图，选一个风格就能出图。</p><a class="btn primary" href="#/">开始出图</a></section>`}`;
}

/* ---------------- job ---------------- */
function checkBadge(job, i) {
  const c = job.manifest?.textCheck?.find((x) => x.frame === i);
  if (!c) return "";
  if (c.ok) return `<span class="badge ok">✓ 文字已核对</span>`;
  if (c.ok === null)
    return c.unsure?.length
      ? `<details class="badge-detail"><summary class="badge muted-badge">${c.unsure.length} 处没读清</summary><p class="muted">AI 没能读清${c.unsure.map((p) => `“${esc(p.text)}”`).join("、")}（艺术字、小字常见），不一定有错，放大看一眼就行。</p></details>`
      : `<span class="badge muted-badge">文字未核对</span>`;
  return `<details class="badge-detail" open><summary class="badge bad">${c.problems.length} 处文字有误</summary><ul>${c.problems.map((p) => `<li>${problemText(p)}</li>`).join("")}</ul></details>`;
}
// One proofreading finding, in the merchant's words.
function problemText(p) {
  if (p.kind === "repeated" || p.repeated) return `“${esc(p.text)}”在图上出现了 ${p.repeated} 次`;
  if (p.kind === "missing") return `图上没找到“${esc(p.text)}”`;
  return `应为“${esc(p.text)}”${p.near ? `，图上像是“${esc(p.near)}”` : ""}`;
}
function textEditor(job, i) {
  const f = job.params.frames?.[i];
  if (!f || f.textMode !== "overlay") return "";
  return `<details class="edit"><summary>改文字（免费，不重新出图）</summary><div class="texts" data-edit="${i}">${f.texts
    .map((t) => `<div class="text-row two"><select data-role>${Object.keys(TEXT_ROLES).map((r) => `<option value="${r}" ${t.role === r ? "selected" : ""}>${TEXT_ROLES[r].name}</option>`).join("")}</select><input data-value maxlength="${TEXT_ROLES[t.role].max}" value="${esc(t.text)}"></div>`)
    .join("")}<button class="btn small" data-save="${i}">保存并重新排版</button></div></details>`;
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
    if (job.status === "partial" || !apiReady || a.role !== "image" || p.operation === "cover") return false;
    const [w, h] = upscaleSize(a.width, a.height).split("x").map(Number);
    return a.width < w || a.height < h;
  };
  const special = ["upscale", "cover"].includes(p.operation);
  const card = (a, i) => `<article class="card result">
      <a href="${fileUrl(job, a.name)}" target="_blank" rel="noopener"><img loading="lazy" decoding="async" src="${preview(fileUrl(job, a.name))}" alt="第 ${i + 1} 张"></a>
      <div class="result-bar"><b>${esc(p.frames?.[i]?.title || `第 ${i + 1} 张`)}</b><small class="muted">${a.width}×${a.height}</small></div>
      ${checkBadge(job, i)}
      ${job.status === "partial" ? "" : textEditor(job, i)}
      <div class="row wrap">
        <a class="btn small" href="${fileUrl(job, a.name, true)}">下载</a>
        ${legacy || special ? "" : `<button class="btn small primary-soft" data-tweak="${i}">修改这张图 · ${cost(1)}</button><button class="btn small" data-redo="${i}">重出这张 · ${cost(1)}</button>`}
        ${job.status !== "partial" && !legacy && !special && p.frames?.[i]?.textMode === "ai" ? `<button class="btn small" data-overlay="${i}" title="重新出一张留白的图，由程序把字排上去">改用精确排字 · ${cost(1)}</button>` : ""}
        ${canUpscale(a) ? `<button class="link" data-upscale="${esc(a.name)}">提升到 4K · ${workspace.skills.upscale.cost}</button>` : ""}
      </div>
    </article>`;
  const d = p.direction;
  app.innerHTML = `${p.suiteId && p.skillId === "product" ? `<a class="back" href="#/suite/${encodeURIComponent(p.suiteId)}/shots">← 返回商品图</a>` : `<a class="back" href="#/tasks">← 我的作品</a>`}
  <div class="page-head"><div><h1>${esc(p.productName)}</h1><p class="muted">${p.operation === "cover" ? "风格样图" : SCENE_NAME(p.skillId)}${d?.conceptName ? ` · ${esc(d.conceptName)}` : ""} · ${date(job.createdAt)} · ${job.cost} 积分</p></div><span class="status ${job.status}">${STATUS[job.status]}</span></div>
  ${active(job) ? `<section class="card progress"><div class="spinner"></div><div><b>${esc(job.phase)}</b><p class="muted">一张图通常 1–3 分钟，${p.count > 1 ? `这次共 ${p.count} 张，` : ""}可以先离开，稍后在“我的作品”里看。</p><div class="bar"></div></div><button class="btn" id="cancel">取消并退积分</button></section>` : ""}
  ${["partial","failed","cancelled"].includes(job.status) ? `<section class="card warn"><b>${STATUS[job.status]}</b><p>${esc(job.error || "")}</p></section>` : ""}
  ${m?.warnings?.length ? `<p class="warn-text">${m.warnings.map(esc).join("<br>")}</p>` : ""}
  ${p.operation === "tweak" ? `<section class="card tweak-info"><b>修改要求</b><p>${esc(p.instruction)}</p>
      ${m ? `<div class="compare"><figure><img src="/api/jobs/${p.tweakFrom.jobId}/files/${p.skillId === "detail" ? "module" : "image"}-${p.tweakFrom.frame + 1}.png?thumb=720" alt="微调前"><figcaption>微调前</figcaption></figure><figure><img src="${preview(fileUrl(job, images[0].name))}" alt="微调后"><figcaption>微调后</figcaption></figure></div>` : ""}
      ${m ? `${checkBadge(job, 0)}<div class="row wrap"><a class="btn small primary" href="${fileUrl(job, images[0].name, true)}">下载这张</a><button class="btn small primary-soft" data-tweak="0">继续微调 · ${cost(1)}</button><button class="btn small" data-redo="0">按同样要求再来一张 · ${cost(1)}</button></div>` : ""}
      <p class="muted">不满意可以在新图上继续微调，或回到<a href="#/job/${p.tweakFrom.jobId}">上一版</a>。</p></section>` : ""}
  ${job.tweaks?.length ? `<section class="card versions"><b>微调过的版本</b><div class="version-list">${job.tweaks
    .map((t) => `<a href="#/job/${t.id}" class="version">${t.asset ? `<img src="/api/jobs/${t.id}/files/${encodeURIComponent(t.asset)}?thumb=320" alt="">` : `<span class="status ${t.status}">${STATUS[t.status]}</span>`}<small>第 ${t.frame + 1} 张 · ${esc(t.instruction.slice(0, 18))}</small></a>`)
    .join("")}</div></section>` : ""}
  ${
    m && p.skillId === "detail" && long && p.operation !== "tweak"
      ? `<div class="detail-result">
          <div class="long-view card"><a href="${fileUrl(job, long.name)}" target="_blank" rel="noopener"><img src="${preview(fileUrl(job, long.name))}" alt="查看详情页长图原图"></a></div>
          <div class="side">
            <section class="card"><h2>下载</h2><a class="btn primary wide" href="${fileUrl(job, long.name, true)}">下载整张长图</a></section>
            ${images.map((a, i) => card(a, i)).join("")}
          </div></div>`
      : m && p.operation !== "tweak"
        ? `<div class="results">${images.map((a,i) => card(a,a.frame ?? i)).join("")}</div>`
        : ""
  }
  ${!active(job) && !legacy && !special && p.operation !== "tweak" ? `<div class="row wrap"><button class="btn" id="retry">${m?.missing ? "只补缺少的 " + m.missing.length + " 张" : job.status === "succeeded" ? "整组再来一次" : "重新生成"} · ${cost(m?.missing?.length || p.count)} 积分</button><a class="btn" href="#/new/${p.skillId}">新建</a>${job.sourceId ? `<a class="link" href="#/job/${job.sourceId}">查看来源</a>` : ""}</div>` : ""}
  ${
    !legacy && d
      ? `<details class="card plan-detail"><summary>查看方案与分镜</summary>
          <p><b>${esc(d.conceptName)}</b>（${esc(d.styleName || "")}）${esc(d.story || "")}</p>${swatches(d.palette)}
          ${p.frames.map((f, i) => `<div class="plan-row"><b>${i + 1}. ${esc(f.title)}</b> <small class="muted">${TEXT_MODES[f.textMode]}</small><p>${esc(f.scene)}</p>${f.texts.length ? `<p class="muted">${f.texts.map((t) => esc(t.text)).join(" / ")}</p>` : ""}</div>`).join("")}
        </details>`
      : ""
  }`;
  paint(app);
  bindJob(job);
}
function bindJob(job) {
  const go = async (route, body) => {
    const next = await api(route, json(body, { "Idempotency-Key": key() }));
    await refresh();
    location.hash = "#/job/" + next.id;
  };
  $("#cancel")?.addEventListener("click", () =>
    busy($("#cancel"), async () => {
      await api(`/jobs/${job.id}/cancel`, { method: "POST" });
      await refresh();
      render();
    }),
  );
  $("#retry")?.addEventListener("click", () => busy($("#retry"), () => go(`/jobs/${job.id}/retry`, {})));
  $$("[data-redo]").forEach((b) => (b.onclick = () => busy(b, () => go(`/jobs/${job.id}/retry`, { frame: Number(b.dataset.redo) }))));
  $$("[data-tweak]").forEach((b) => (b.onclick = () => tweakModal(job, Number(b.dataset.tweak))));
  $$("[data-overlay]").forEach((b) => (b.onclick = () => busy(b, () => go(`/jobs/${job.id}/retry`, { frame: Number(b.dataset.overlay), textMode: "overlay" }))));
  $$("[data-upscale]").forEach((b) => (b.onclick = () => busy(b, () => go(`/jobs/${job.id}/upscale`, { asset: b.dataset.upscale }))));
  $$("[data-save]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          const frames = job.params.frames.map((_, i) => {
            const box = $(`[data-edit="${i}"]`);
            return box ? { texts: $$(".text-row", box).map((r) => ({ role: $("[data-role]", r).value, text: $("[data-value]", r).value })).filter((t) => t.text.trim()) } : null;
          });
          await api(`/jobs/${job.id}/texts`, json({ frames }));
          toast("已重新排版");
          render();
        })),
  );
}

/* ---------------- credits ---------------- */
function creditsPage() {
  const kinds = { reserve: "出图预扣", refund: "失败 / 取消退回", grant: "充值", signup: "注册赠送", checkin: "签到", expire: "签到积分过期" };
  const c = workspace.checkin;
  const pr = workspace.pricing;
  const per = (p) => (p.price / (p.credits / 10)).toFixed(2);
  const u = workspace.user;
  app.innerHTML = `<div class="page-head"><div><h1>我的账号</h1><p class="muted">${esc(u.name)}${u.phone ? ` · ${esc(u.phone)}` : ""}</p></div></div>
  <section class="card balance-card"><b>${workspace.account.balance}</b><span class="muted">可用积分。一张图 10 积分，出图时预扣，失败或取消自动退回。</span></section>
  ${c ? `<section class="card checkin"><div class="row spread wrap"><div><h2>每日签到</h2><p class="muted">${c.today ? `今天已签到，已连续 ${c.streak} 天。` : c.streak ? `已连续 ${c.streak} 天，今天签到领 ${c.amount} 积分。` : `今天签到领 ${c.amount} 积分。`}签到积分 ${c.expireDays} 天内有效，出图时优先使用。</p></div>
      <button class="btn primary" id="checkin" ${c.today ? "disabled" : ""}>${c.today ? "今天已签到" : `签到 +${c.amount}`}</button></div>
    <ol class="week">${c.week.map((n, i) => `<li class="${i + 1 < c.position || (c.today && i + 1 === c.position) ? "done" : i + 1 === c.position ? "next" : ""}"><b>+${n}</b><small>第 ${i + 1} 天</small></li>`).join("")}</ol></section>` : ""}
  ${pr ? `<section class="card packages"><h2>充值套餐</h2><p class="muted">套餐越大，每张图越便宜。充值请联系管理员，到账后一年内有效。</p>
    <div class="pack-grid">${pr.packages.map((p) => `<div class="pack"><b>¥${p.price}</b><span>${p.credits} 积分</span><small>可出 ${p.credits / 10} 张，约 ¥${per(p)} 一张</small></div>`).join("")}
      <div class="pack plain"><b>单买</b><span>1 元 = ${pr.perYuan} 积分</span><small>¥1.00 一张</small></div></div></section>` : ""}
  <section class="card ledger">${workspace.account.ledger.length ? workspace.account.ledger.map((l) => `<div class="ledger-row"><div><b>${kinds[l.kind] || l.kind}</b><small class="muted">${date(l.createdAt)}${l.note ? ` · ${esc(l.note)}` : ""}${l.jobId ? ` · <a href="#/job/${l.jobId}">查看</a>` : ""}</small></div><b class="${l.amount > 0 ? "plus" : ""}">${l.amount > 0 ? "+" : ""}${l.amount}</b></div>`).join("") : `<p class="muted">还没有积分记录。</p>`}</section>
  <section class="card account-form"><h2>${u.phone ? "修改密码" : "设置手机号登录"}</h2>
    <form id="pw-form" class="row wrap">
      ${u.phone ? `<input name="old" type="password" autocomplete="current-password" placeholder="原密码" required>` : isAdmin() ? `<input name="phone" type="tel" placeholder="手机号" required>` : ""}
      <input name="password" type="password" autocomplete="new-password" minlength="6" placeholder="新密码（至少 6 位）" required>
      <button class="btn">保存</button>
    </form></section>
  <p class="center-row"><button class="btn" id="logout2">退出登录</button></p>`;
  $("#logout2").onclick = () => $("#logout").click();
  $("#checkin")?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const r = await api("/me/checkin", json({}));
      await refresh();
      toast(`签到成功，+${r.got} 积分`);
      creditsPage();
    }),
  );
  $("#pw-form").onsubmit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    busy(form.querySelector("button"), async () => {
      const body = Object.fromEntries(new FormData(form));
      if (body.phone) await api("/me/phone", json({ phone: body.phone }));
      await api("/me/password", json(body));
      await refresh();
      toast("已保存");
      creditsPage();
    });
  };
}

/* ---------------- admin ---------------- */
async function adminPage() {
  const data = await api("/admin");
  const link = (code) => `${location.origin}${location.pathname}#/join/${code}`;
  const invite = (i) => `<tr class="${i.revoked || i.used >= i.maxUses ? "dim" : ""}">
      <td class="mono">${esc(i.code)}</td><td>${i.credits}</td><td>${i.used}/${i.maxUses}</td><td>${esc(i.note)}</td>
      <td>${i.revoked ? "已作废" : i.used >= i.maxUses ? "已用完" : `<div class="row"><button class="btn small" data-copy="${esc(i.code)}">复制邀请</button><button class="link" data-revoke="${esc(i.code)}">作废</button></div>`}</td></tr>`;
  const user = (u) => `<tr>
      <td><b>${esc(u.name)}</b>${u.role === "admin" ? ` <i class="tag">管理员</i>` : ""}<small class="muted">${esc(u.phone || "访问码登录")}</small></td>
      <td><b>${u.balance}</b></td><td>${u.jobs} 次 / ${u.spent} 分</td>
      <td class="muted">${u.lastLogin ? date(u.lastLogin) : "—"}</td>
      <td><form class="row grant" data-user="${esc(u.id)}"><select name="pack" aria-label="套餐"><option value="">自定义</option>${(workspace.pricing?.packages || []).map((p) => `<option value="${p.credits}|¥${p.price} 套餐">¥${p.price} · ${p.credits}</option>`).join("")}</select><input name="amount" type="number" step="1" placeholder="+100" required><input name="note" maxlength="40" placeholder="备注（如：转账 50 元）"><button class="btn small">加积分</button></form>
        ${u.role === "admin" ? "" : `<button class="link" data-reset="${esc(u.id)}" data-name="${esc(u.name)}">重置密码</button>`}</td></tr>`;
  app.innerHTML = `<div class="page-head"><div><h1>管理</h1><p class="muted">发邀请码给要体验的人；他们转账后在这里加积分。</p></div></div>
  <section class="card admin-block"><h2>新建邀请码</h2>
    <form id="invite-form" class="row wrap">
      <label class="inline">送积分<input name="credits" type="number" min="0" max="10000" value="40" required></label>
      <label class="inline">可注册人数<input name="maxUses" type="number" min="1" max="1000" value="5" required></label>
      <input name="note" maxlength="40" placeholder="备注：发给谁 / 哪个群">
      <button class="btn primary">生成</button>
    </form>
    <p class="muted">商品图和详情页一屏都是 10 积分一张，送 40 积分够新用户出 4 张图。邀请码不区分大小写，一个码可以发给多人。</p>
    <div class="table-wrap"><table class="admin-table"><thead><tr><th>邀请码</th><th>送积分</th><th>已用</th><th>备注</th><th></th></tr></thead>
    <tbody>${data.invites.map(invite).join("") || `<tr><td colspan="5" class="muted">还没有邀请码</td></tr>`}</tbody></table></div>
  </section>
  <section class="card admin-block"><h2>账号（${data.users.length}）</h2>
    <div class="table-wrap"><table class="admin-table"><thead><tr><th>商家</th><th>余额</th><th>出图 / 消耗</th><th>最近登录</th><th>充值</th></tr></thead>
    <tbody>${data.users.map(user).join("")}</tbody></table></div>
  </section>`;
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制，直接发到微信");
    } catch {
      window.prompt("复制下面这段发给对方：", text);
    }
  };
  const message = (code) => `邀请你体验「星图」：一个商品一键出笔记、商品图和详情页。\n打开链接注册：${link(code)}\n邀请码：${code}`;
  $("#invite-form").onsubmit = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    busy(form.querySelector("button"), async () => {
      const body = Object.fromEntries(new FormData(form));
      const r = await api("/admin/invites", json({ credits: Number(body.credits), maxUses: Number(body.maxUses), note: body.note }));
      await adminPage();
      await copy(message(r.code));
    });
  };
  $$("[data-copy]").forEach((b) => (b.onclick = () => copy(message(b.dataset.copy))));
  $$("[data-revoke]").forEach((b) => (b.onclick = () => busy(b, async () => {
    await api(`/admin/invites/${encodeURIComponent(b.dataset.revoke)}/revoke`, json({}));
    await adminPage();
  })));
  // Picking a package fills in its credits and a note, so the ledger says what was bought.
  $$(".grant [name=pack]").forEach((sel) => (sel.onchange = () => {
    if (!sel.value) return;
    const [credits, note] = sel.value.split("|");
    sel.form.amount.value = credits;
    sel.form.note.value = note;
  }));
  $$(".grant").forEach((form) => (form.onsubmit = (e) => {
    e.preventDefault();
    busy(form.querySelector("button"), async () => {
      const body = Object.fromEntries(new FormData(form));
      const u = await api(`/admin/users/${encodeURIComponent(form.dataset.user)}/grant`, json({ amount: Number(body.amount), note: body.note }));
      toast(`${u.name} 现在有 ${u.balance} 积分`);
      await refresh();
      await adminPage();
    });
  }));
  $$("[data-reset]").forEach((b) => (b.onclick = () => {
    const password = window.prompt(`给「${b.dataset.name}」设一个新密码（至少 6 位），然后告诉对方：`);
    if (password) busy(b, async () => {
      await api(`/admin/users/${encodeURIComponent(b.dataset.reset)}/password`, json({ password }));
      toast("已重置，对方需要用新密码重新登录");
    });
  }));
}

/* ---------------- router ---------------- */
async function render() {
  cleanup();
  cleanup = () => {};
  document.querySelectorAll(".modal").forEach((m) => m.remove());
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
    } else if (route === "styles") await stylesPage();
    else if (route === "suite" && id === "new") await suite.newPage();
    else if (route === "suite" && id) await suite.suitePage(id, location.hash.split("/")[3]);
    else if (!route) await suite.homePage();
    else if (route === "join") location.hash = "#/";
    else if (route === "admin" && isAdmin()) await adminPage();
    else if (route === "credits") {
      await refresh();
      if (token === view) creditsPage();
    } else await createPage(route === "new" ? id : null);
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
const suite = initSuite({
  modal,
  app,
  api,
  json,
  toast,
  busy,
  esc,
  $,
  $$,
  key,
  refresh,
  getWorkspace: () => workspace,
  tweak: async (jobId, i) => tweakModal(await api("/jobs/" + jobId), i),
  problemText,
  setCleanup: (fn) => (cleanup = fn),
});
addEventListener("hashchange", () => {
  scrollTo(0, 0);
  render();
});
render();
