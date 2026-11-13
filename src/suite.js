import { preview } from "./preview.js";
import { upscaleSize } from "../shared/generation.js";

// Stat numbers are set big; longer ones (“48小时”) step down so they stay on one line.
const bigSize = (t) => { const n = [...String(t)].length; return n > 5 ? "xs" : n > 3 ? "sm" : ""; };

// 商品全套：资料 → 档案 → 笔记 → 商品图 → 详情页
export function initSuite(ctx) {
  const { app, api, json, toast, busy, esc, $, $$, key, refresh, getWorkspace, setCleanup, tweak, problemText, modal } = ctx;
  let meta = null;
  const loadMeta = async () => (meta ||= await api("/suite-meta"));
  const photoUrl = (s, file) => `/api/suites/${s.id}/photo/${encodeURIComponent(file)}`;
  const fileUrl = (job, name, dl = false) => `/api/jobs/${job.id}/files/${encodeURIComponent(name)}?v=${encodeURIComponent(job.updatedAt)}${dl ? "&download=1" : ""}`;
  const busyTask = (s, name) => s.tasks?.[name]?.status === "running";
  const anyBusy = (s) => Object.values(s.tasks || {}).some((t) => t.status === "running");
  const nl = (t) => esc(t).replace(/\n/g, "<br>");
  // Long headlines break at their first comma (or before “vs”) rather than leaving one character alone on a line.
  const head = (text) => {
    const v = String(text || "");
    if (Array.from(v).length <= 9) return esc(v);
    const m = v.match(/^(.{3,}?)[，,、]\s*(.+)$/) || v.match(/^(.{3,}?)\s+(vs\s*.+)$/i);
    return m ? `${esc(m[1])}<br>${esc(m[2])}` : esc(v);
  };


  /* ---------------- home: my products ---------------- */
  async function homePage() {
    const { suites } = await api("/suites");
    const flow = [["商品档案", "AI 读图读笔记，建好档案"], ["笔记", "私域能直接发的文案"], ["包装", "要印箱子再做，可跳过"], ["商品图", "8–10 张，主图到售后"], ["详情页", "分镜出图，拼成长图"]];
    const stepNames = { profile: "档案", note: "笔记", shots: "商品图", detail: "详情页" };
    const when = (v) => new Date(v).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    app.innerHTML = `
      <section class="home-hero">
        <div class="home-hero-text"><h1>拍几张实拍图，<br>剩下的交给工作台</h1><p>传上实拍图，说几句商品情况。笔记、商品图、详情页长图，一个商品一次出齐。</p>
          <a class="btn primary big" href="#/suite/new">新建商品</a></div>
        <ol class="flow">${flow.map(([n, d], i) => `<li><i>${i + 1}</i><b>${n}</b><small>${d}</small></li>`).join("")}</ol>
      </section>
      <div class="page-head list-head"><h2>我的商品${suites.length ? `<small class="muted">${suites.length} 个</small>` : ""}</h2></div>
      ${
        suites.length
          ? `<div class="prod-list">${suites
              .map(
                (s) => `<a class="prod" href="#/suite/${s.id}"><div class="prod-thumb">${s.cover ? `<img src="/api/suites/${s.id}/photo/${encodeURIComponent(s.cover)}?thumb=320" alt="" loading="lazy">` : ""}</div>
                <div class="prod-meta"><b>${esc(s.name)}</b>
                ${Object.values(s.tasks || {}).some((t) => t.status === "running") ? `<span class="status running">AI 处理中</span>` : s.steps ? `<span class="prod-steps">${Object.entries(stepNames).map(([k, n]) => `<i class="${s.steps[k] ? "on" : ""}">${n}</i>`).join("")}</span>` : ""}
                <small class="muted">${when(s.updatedAt)} 更新</small></div></a>`,
              )
              .join("")}</div>`
          : `<section class="card empty"><h2>还没有商品</h2><p class="muted">点上面的“新建商品”，传几张实拍图就能开始。</p></section>`
      }`;
  }

  /* ---------------- new product ---------------- */
  // New product: one box to say/paste anything, plus photos and an optional note file.
  const draft = { text: "", note: null, photos: [], urls: [], caseId: "" };
  const NOTE_TYPES = /\.(pdf|docx|txt)$/i;
  async function newPage() {
    await loadMeta();
    const ready = draft.text.trim() || draft.note || draft.photos.length;
    app.innerHTML = `
      <a class="back" href="#/">← 我的商品</a>
      <div class="create">
        <section class="card step tell">
          <h2>说说你的商品</h2>
          <p class="muted">想到什么写什么，不用整理。AI 会帮你理成商品档案，缺什么再问你。</p>
          <textarea id="tell" rows="8" maxlength="20000" placeholder="例如：舟山的雷达网带鱼，沈家门码头直接发，肉厚、清蒸出油，一盒两条独立真空包装，冷冻发顺丰，江浙沪包邮……\n\n以前写过的文案、跟客户的聊天记录，也可以直接粘贴进来">${esc(draft.text)}</textarea>
          <p class="voice-tip">🎤 手机上点输入法键盘上的<b>话筒</b>，直接说就行，说完会变成文字</p>
        </section>
        <section class="card step">
          <h2>放几张实拍图 <small class="muted">越全越好，手机拍的就行</small></h2>
          <p class="muted">包装正面、实物、做好的成品、产地/码头/工厂、细节或切面。有现成的笔记（PDF / Word）也可以放这里，里面的图会自动提取。</p>
          <div class="ref-row">${draft.urls.map((u, i) => `<div class="ref"><img src="${u}" alt=""><button class="x" data-rm="${i}" aria-label="移除">×</button></div>`).join("")}
            ${draft.note ? `<div class="ref note-file"><span>📄</span><small>${esc(draft.note.name)}</small><button class="x" id="rm-note" aria-label="移除">×</button></div>` : ""}
            <label class="ref add"><input type="file" id="add-files" accept="image/png,image/jpeg,image/webp,.pdf,.docx,.txt" multiple hidden>＋</label></div>
          <details class="advanced"><summary>参考案例（默认自动选）</summary><div class="pills">
            <button class="pill ${!draft.caseId ? "on" : ""}" data-case="">自动</button>
            ${meta.cases.map((c) => `<button class="pill ${draft.caseId === c.id ? "on" : ""}" data-case="${c.id}">${esc(c.name)}</button>`).join("")}</div></details>
        </section>
        <div class="actionbar"><div class="actionbar-in"><span class="muted">AI 先整理成“商品档案”给你看，不扣积分</span><button class="btn primary" id="go" ${ready ? "" : "disabled"}>帮我整理 →</button></div></div>
      </div>`;
    const tell = $("#tell");
    tell.addEventListener("input", () => {
      draft.text = tell.value;
      $("#go").disabled = !(draft.text.trim() || draft.note || draft.photos.length);
    });
    $("#add-files").addEventListener("change", (e) => {
      for (const f of e.target.files) {
        if (NOTE_TYPES.test(f.name)) draft.note = f;
        else if (f.type.startsWith("image/") && draft.photos.length < 30) {
          draft.photos.push(f);
          draft.urls.push(URL.createObjectURL(f));
        }
      }
      newPage();
    });
    $("#rm-note")?.addEventListener("click", () => ((draft.note = null), newPage()));
    $$("[data-rm]").forEach((b) => (b.onclick = () => (draft.photos.splice(+b.dataset.rm, 1), draft.urls.splice(+b.dataset.rm, 1), newPage())));
    $$("[data-case]").forEach((b) => (b.onclick = () => ((draft.caseId = b.dataset.case), newPage())));
    $("#go").onclick = (e) =>
      busy(e.currentTarget, async () => {
        if (!draft.photos.length && !draft.note) throw new Error("再放几张实拍图吧，出图要用到");
        const form = new FormData();
        if (draft.note) form.append("note", draft.note);
        form.set("text", draft.text);
        form.set("answers", "{}");
        form.set("caseId", draft.caseId);
        for (const p of draft.photos) form.append("photos", p);
        toast("上传中，图片多的话需要几十秒…");
        const s = await api("/suites", { method: "POST", body: form });
        Object.assign(draft, { text: "", note: null, photos: [], urls: [], caseId: "" });
        location.hash = "#/suite/" + s.id;
      });
    if (!draft.text) tell.focus();
  }

  /* ---------------- one product ---------------- */
  const tabs = { profile: "1 商品档案", note: "2 笔记", pack: "3 包装", shots: "4 商品图", detail: "5 详情页" };
  let tab = "profile";
  let current = null;
  let shotView = "results";
  let lastSnap = "";
  const pendingJob = (j) => ["queued", "running"].includes(j?.status);
  const jobImage = (j, i = 0) => {
    const newest = j?.tweaks?.find((t) => t.frame === i && t.status === "succeeded" && t.asset);
    if (newest) return `/api/jobs/${newest.id}/files/${encodeURIComponent(newest.asset)}`;
    const asset = j?.manifest?.assets?.filter((a) => ["image", "module"].includes(a.role)).find((a, pos) => (a.frame ?? pos) === i);
    return asset ? fileUrl(j, asset.name) : null;
  };
  // The finished picture for one planned product shot: from the full set, or made on its own.
  const shotImage = (s, shotId) => {
    const set = s.jobs?.shots;
    const i = set?.frames?.findIndex((f) => f.ref === shotId) ?? -1;
    return (i >= 0 && jobImage(set, i)) || jobImage(s.jobs?.["try:" + shotId]) || null;
  };
  // `quiet` = a background check while something is generating: redraw only when something
  // actually changed, and never under the merchant's fingers while they are typing.
  async function suitePage(id, sub, quiet = false) {
    const [, s] = await Promise.all([loadMeta(), api("/suites/" + id)]);
    if (location.hash.split("/")[2] !== id || !location.hash.startsWith("#/suite/")) return;
    if (current?.id !== id) {
      tab = s.jobs?.shots && s.profile ? "shots" : "profile";
      shotView = "results";
      quiet = false;
    }
    if (sub && tabs[sub]) tab = sub;
    const snap = JSON.stringify(s);
    const typing = !!document.activeElement?.matches?.("#tab input:not([type=checkbox]), #tab textarea");
    if (!quiet || (snap !== lastSnap && !typing)) {
      current = s;
      lastSnap = snap;
      render(s);
    }
    if (snap !== lastSnap || anyBusy(s) || Object.values(s.jobs || {}).some((j) => pendingJob(j) || j?.tweaks?.some(pendingJob) || j?.upscales?.some(pendingJob))) {
      const t = setTimeout(async () => {
        if (location.hash.startsWith("#/suite/" + id)) suitePage(id, undefined, true);
      }, 3000);
      setCleanup(() => clearTimeout(t));
    }
  }
  function render(s) {
    const p = s.profile;
    const name = p?.name || s.name || "新商品";
    app.innerHTML = `
      <a class="back" href="#/">← 我的商品</a>
      <div class="page-head"><div><h1>${esc(name)}</h1><p class="muted">${esc(meta.cases.find((c) => c.id === s.caseId)?.name || "")}</p></div>
        <button class="link" id="del-suite">删除</button></div>
      <nav class="tabs" aria-label="步骤">${Object.entries(tabs).map(([k, v]) => `<button class="${tab === k ? "on" : ""}" data-tab="${k}" ${tab === k ? 'aria-current="step"' : ""} ${!p && k !== "profile" ? "disabled" : ""}><i>${v.split(" ")[0]}</i><span>${v.split(" ")[1]}</span></button>`).join("")}</nav>
      <div id="tab"></div>`;
    $$("[data-tab]").forEach((b) => (b.onclick = () => ((tab = b.dataset.tab), render(current))));
    $(".tabs .on")?.scrollIntoView({ block: "nearest", inline: "center" });
    $("#del-suite").onclick = (e) =>
      busy(e.currentTarget, async () => {
        if (!confirmDelete()) return;
        await api("/suites/" + s.id, { method: "DELETE" });
        location.hash = "#/";
      });
    const box = $("#tab");
    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-recheck]");
      if (b)
        busy(b, async () => {
          await api(`/jobs/${b.dataset.recheck}/recheck`, { ...json({}), timeout: 600000 });
          toast("文字已重新核对");
          suitePage(s.id);
        });
    });
    if (!p) return profileWaiting(box, s);
    ({ profile: profileTab, note: noteTab, pack: packTab, shots: shotsTab, detail: detailTab })[tab](box, s);
  }
  let delArmed = 0;
  const confirmDelete = () => {
    if (Date.now() - delArmed < 4000) return true;
    delArmed = Date.now();
    toast("再点一次“删除”确认");
    return false;
  };
  const saveSuite = async (patch) => (current = await api("/suites/" + current.id, json(patch)));
  const failed = (s, name) => (s.tasks?.[name]?.status === "failed" ? `<p class="warn-text">${esc(s.tasks[name].error)}</p>` : "");
  const spinner = (title, sub) => `<section class="card planning"><div class="spinner"></div><div><b>${title}</b><p class="muted">${sub}</p></div></section>`;

  function profileWaiting(box, s) {
    box.innerHTML = busyTask(s, "profile")
      ? spinner("AI 正在整理商品档案", `识别 ${s.photos.length} 张图片分别是什么 → 读笔记 → 提炼卖点、产地、对比、答疑（约 1–2 分钟）`)
      : `<section class="card warn"><b>整理没有完成</b>${failed(s, "profile")}<button class="btn" id="retry-profile">重新整理</button></section>`;
    $("#retry-profile")?.addEventListener("click", (e) => busy(e.currentTarget, async () => (await api(`/suites/${s.id}/profile`, json({})), suitePage(s.id))));
  }

  /* ---- tab 1: profile ---- */
  const FIELDS = [
    ["name", "品名"], ["origin", "产地"], ["shipFrom", "发货地"], ["spec", "规格"], ["storage", "储存方式"], ["courier", "快递"],
    ["freeShipping", "包邮"], ["dispatch", "发货时效"], ["excludedAreas", "不发/加价地区"], ["packaging", "包装方式"], ["afterSales", "售后"],
  ];
  // "AI filled these, still missing these": one tap per answer, written straight into the fields below.
  const GAPS = ["name", "origin", "spec", "storage", "courier", "freeShipping", "dispatch", "afterSales"];
  const GAP_HINTS = { name: "例如：舟山雷达网带鱼 整条礼盒装", origin: "例如：浙江舟山", spec: "例如：2 条装，每条约 500g" };
  function gapsCard(p) {
    const filled = FIELDS.filter(([k]) => p[k]?.trim()).length;
    const gaps = GAPS.filter((k) => !p[k]?.trim());
    if (!gaps.length && !p.missing?.length) return `<section class="card ok-card"><b>✓ AI 已经帮你整理好了</b><p class="muted">下面每一项都可以改；没问题就点最下面的“保存”。</p></section>`;
    const label = Object.fromEntries(FIELDS);
    return `<section class="card gaps-card">
      <h2>AI 帮你填好了 ${filled} 项，还差这几项</h2>
      <p class="muted">点一下就填上，没有的可以跳过</p>
      ${gaps
        .map((k) => {
          const q = meta.quick[k];
          return `<div class="gap"><span>${label[k]}</span>${
            q
              ? q.options.map((o) => `<button class="chip" data-gap="${k}" data-multi="${q.multi ? 1 : 0}" data-v="${esc(o)}">${esc(o)}</button>`).join("")
              : `<input data-gap-input="${k}" placeholder="${esc(GAP_HINTS[k] || "")}">`
          }</div>`;
        })
        .join("")}
      ${p.missing?.length ? `<p class="hint">AI 还建议补充：${p.missing.map(esc).join("；")}</p>` : ""}
    </section>`;
  }
  function bindGaps(box) {
    const field = (k) => $(`[data-f="${k}"]`, box);
    $$("[data-gap]", box).forEach(
      (b) =>
        (b.onclick = () => {
          const k = b.dataset.gap;
          const el = field(k);
          if (b.dataset.multi === "1") {
            const cur = new Set(el.value.split(/[、,，\s]+/).filter(Boolean));
            cur.has(b.dataset.v) ? cur.delete(b.dataset.v) : cur.add(b.dataset.v);
            el.value = [...cur].join("、");
            b.classList.toggle("on", cur.has(b.dataset.v));
          } else {
            const on = el.value !== b.dataset.v;
            el.value = on ? b.dataset.v : "";
            $$(`[data-gap="${k}"]`, box).forEach((x) => x.classList.toggle("on", on && x === b));
          }
        }),
    );
    $$("[data-gap-input]", box).forEach((el) => el.addEventListener("input", () => (field(el.dataset.gapInput).value = el.value)));
  }
  function profileTab(box, s) {
    const p = s.profile;
    box.innerHTML = `
      ${busyTask(s, "profile") ? spinner("AI 正在重新整理", "完成后自动刷新") : ""}
      ${gapsCard(p)}
      ${s.risky?.length ? `<section class="card warn"><b>淘宝要注意的词</b><p>${s.risky.map((r) => `“${esc(r.word)}”→ ${esc(r.fix)}`).join("；")}</p><p class="muted">私域群发可以保留；放淘宝详情页会被判违规，出详情页时会自动换成右边的说法。</p></section>` : ""}
      <section class="card"><h2>实拍图 <small class="muted">AI 已经认出每张是什么，认错了就改一下</small></h2>
        <div class="photo-grid">${s.photos
          .map(
            (ph) => `<figure class="${ph.usable ? "" : "dim"}">${ph.ai ? `<i class="ai-badge">AI 示意</i>` : ""}<img src="${preview(photoUrl(s, ph.file),320)}" alt="" loading="lazy">
              <select data-role="${esc(ph.file)}">${Object.entries(meta.roles).map(([k, v]) => `<option value="${k}" ${ph.role === k ? "selected" : ""}>${v}</option>`).join("")}</select>
              <label class="mini"><input type="checkbox" data-usable="${esc(ph.file)}" ${ph.usable ? "checked" : ""}>用于出图</label></figure>`,
          )
          .join("")}</div>
        <label class="btn small"><input type="file" id="more-photos" accept="image/*" multiple hidden>＋ 补充图片</label>
      </section>
      ${dishCard(s)}
      <section class="card"><h2>基本信息</h2><div class="fields">${FIELDS.map(([k, label]) => `<label>${label}<input data-f="${k}" value="${esc(p[k] || "")}"></label>`).join("")}</div>
        <label>产品介绍<textarea data-f="intro" rows="3">${esc(p.intro)}</textarea></label></section>
      <section class="card"><h2>卖点</h2>${p.sellingPoints.map((x, i) => `<div class="pair"><input data-sp="${i}" data-k="title" value="${esc(x.title)}"><input data-sp="${i}" data-k="detail" value="${esc(x.detail)}"></div>`).join("")}</section>
      ${block("why", "为什么是这里", p.why, ["kicker", "headline", "body", "highlight"], true)}
      ${block("faq", "提前说清楚（容易被误会的地方）", p.faq, ["kicker", "headline", "body", "highlight"], true)}
      <section class="card"><h2>对比 <small class="muted">${esc(p.compare.ours || "我们")} vs ${esc(p.compare.others || "其他")}</small></h2>
        <div class="pair three"><b>对比项</b><b><input data-cmp="ours" value="${esc(p.compare.ours)}" placeholder="我们"></b><b><input data-cmp="others" value="${esc(p.compare.others)}" placeholder="对比对象"></b></div>
        ${p.compare.rows.map((r, i) => `<div class="pair three"><input data-row="${i}" data-k="aspect" value="${esc(r.aspect)}"><input data-row="${i}" data-k="ours" value="${esc(r.ours)}"><input data-row="${i}" data-k="others" value="${esc(r.others)}"></div>`).join("")}
        <button class="link" id="add-row">＋ 加一行</button></section>
      <section class="card"><h2>怎么挑 / 怎么辨别</h2><input data-pick-head value="${esc(p.pick.headline)}" placeholder="标题">
        ${p.pick.points.map((x, i) => `<div class="pair"><input data-pick="${i}" data-k="title" value="${esc(x.title)}"><input data-pick="${i}" data-k="detail" value="${esc(x.detail)}"></div>`).join("")}</section>
      <section class="card"><h2>购物须知</h2><textarea id="notice" rows="5">${esc(p.notice.join("\n"))}</textarea><p class="muted">一行一条</p></section>
      <div class="actionbar"><div class="actionbar-in"><button class="link" id="reprofile">让 AI 重新整理</button><span class="muted">改完点保存，后面的笔记和图都按这份档案出</span><button class="btn primary" id="save-profile">保存，下一步：笔记 →</button></div></div>`;
    function block(k, title, v, keys, withCards) {
      return `<section class="card"><h2>${title}</h2><div class="fields">${keys
        .filter((x) => x !== "body")
        .map((x) => `<label>${{ kicker: "小标签", headline: "大标题", highlight: "高亮一句" }[x]}<input data-blk="${k}" data-k="${x}" value="${esc(v[x])}"></label>`)
        .join("")}</div>
        ${withCards ? `<div class="cards-edit">${[0, 1, 2].map((i) => `<div><input data-card="${k}" data-i="${i}" data-k="big" value="${esc(v.cards[i]?.big || "")}" placeholder="大字"><input data-card="${k}" data-i="${i}" data-k="label" value="${esc(v.cards[i]?.label || "")}" placeholder="说明"><input data-card="${k}" data-i="${i}" data-k="sub" value="${esc(v.cards[i]?.sub || "")}" placeholder="小字"></div>`).join("")}</div>` : ""}
        <label>正文<textarea data-blk="${k}" data-k="body" rows="3">${esc(v.body)}</textarea></label></section>`;
    }
    const collect = () => {
      const next = structuredClone(p);
      $$("[data-f]", box).forEach((el) => (next[el.dataset.f] = el.value));
      $$("[data-sp]", box).forEach((el) => (next.sellingPoints[+el.dataset.sp][el.dataset.k] = el.value));
      $$("[data-blk]", box).forEach((el) => (next[el.dataset.blk][el.dataset.k] = el.value));
      $$("[data-card]", box).forEach((el) => {
        const c = next[el.dataset.card].cards;
        c[+el.dataset.i] ||= { big: "", label: "", sub: "" };
        c[+el.dataset.i][el.dataset.k] = el.value;
      });
      for (const k of ["why", "faq"]) next[k].cards = next[k].cards.filter((c) => c.big || c.label);
      $$("[data-cmp]", box).forEach((el) => (next.compare[el.dataset.cmp] = el.value));
      $$("[data-row]", box).forEach((el) => (next.compare.rows[+el.dataset.row][el.dataset.k] = el.value));
      next.pick.headline = $("[data-pick-head]", box).value;
      $$("[data-pick]", box).forEach((el) => (next.pick.points[+el.dataset.pick][el.dataset.k] = el.value));
      next.notice = $("#notice", box).value.split("\n").map((x) => x.trim()).filter(Boolean);
      const photos = s.photos.map((ph) => ({ file: ph.file, role: $(`[data-role="${CSS.escape(ph.file)}"]`, box).value, usable: $(`[data-usable="${CSS.escape(ph.file)}"]`, box).checked }));
      return { profile: next, photos };
    };
    bindGaps(box);
    bindDish(box, s);
    $("#add-row").onclick = () => {
      current.profile.compare.rows.push({ aspect: "", ours: "", others: "" });
      profileTab(box, current);
    };
    $("#more-photos").onchange = (e) =>
      busy($("#save-profile"), async () => {
        const form = new FormData();
        for (const f of e.target.files) form.append("photos", f);
        current = await api(`/suites/${s.id}/photos`, { method: "POST", body: form });
        toast("已添加；新图默认“其他”，请选一下类别");
        render(current);
      });
    $("#reprofile").onclick = (e) => busy(e.currentTarget, async () => (await api(`/suites/${s.id}/profile`, json({})), suitePage(s.id)));
    $("#save-profile").onclick = (e) =>
      busy(e.currentTarget, async () => {
        await saveSuite(collect());
        tab = "note";
        render(current);
        scrollTo(0, 0);
      });
  }

  /* ---- tab 2: note ---- */
  function noteTab(box, s) {
    const own = s.profile.copy;
    const note = s.note;
    box.innerHTML = `
      ${busyTask(s, "note") ? spinner("AI 正在写笔记", "约 20–60 秒") : ""}${failed(s, "note")}
      ${own ? `<section class="card"><h2>你原来的文案</h2><pre class="note-text">${esc(own)}</pre><button class="btn small" data-copy="own">复制</button></section>` : ""}
      <section class="card"><div class="row spread"><h2>${note ? "笔记" : own ? "要不要 AI 帮你润色一版？" : "让 AI 帮你写笔记"}</h2>
        <div class="row wrap"><button class="btn small" data-gen="私域">${note ? "重写（私域版）" : "生成私域版"}</button><button class="btn small" data-gen="淘宝">生成淘宝合规版</button></div></div>
        ${note ? `<input id="note-title" value="${esc(note.title)}"><textarea id="note-body" rows="14">${esc(note.text)}</textarea>
          <div class="row wrap"><button class="btn primary" data-copy="note">一键复制（发微信）</button><button class="btn" id="save-note">保存修改</button></div>` : `<p class="muted">私域版口语化、带表情，适合发群/朋友圈；淘宝合规版自动避开“最、第一、没有之一”这类词。</p>`}
      </section>
      <section class="card row spread"><div><b>Word 版本</b><p class="muted">按“【品名】【产地】…配图…文案…购物须知”排好，图文都能复制</p></div><a class="btn" href="/api/suites/${s.id}/note.docx">下载 Word</a></section>
      <div class="row"><button class="btn primary" id="to-shots">下一步：包装 →</button></div>`;
    $$("[data-gen]").forEach((b) => (b.onclick = () => busy(b, async () => (await api(`/suites/${s.id}/note`, json({ style: b.dataset.gen })), suitePage(s.id)))));
    $$("[data-copy]").forEach(
      (b) =>
        (b.onclick = async () => {
          const text = b.dataset.copy === "own" ? own : `${$("#note-title").value}\n${$("#note-body").value}`;
          try {
            await navigator.clipboard.writeText(text);
            toast("已复制，去微信粘贴就行");
          } catch {
            toast("浏览器不允许自动复制，请手动全选复制", true);
          }
        }),
    );
    $("#save-note")?.addEventListener("click", (e) => busy(e.currentTarget, async () => (await saveSuite({ note: { title: $("#note-title").value, text: $("#note-body").value } }), toast("已保存"))));
    $("#to-shots").onclick = () => ((tab = "pack"), render(current));
  }

  /* ---- tab 3: product images ---- */
  function checklist(s) {
    const c = meta.cases.find((x) => x.id === s.caseId);
    const have = new Set(s.photos.filter((p) => p.usable).map((p) => p.role));
    const any = new Set(s.photos.map((p) => p.role));
    const ai = new Set(s.photos.filter((p) => p.usable && p.ai).map((p) => p.role));
    const got = c.photoChecklist.filter((x) => have.has(x.role)).length;
    return `<details class="card need" ${s.shots ? "" : "open"}><summary><b>需要的实拍图</b><span class="need-count ${got === c.photoChecklist.length ? "ok" : ""}">已有 ${got} / ${c.photoChecklist.length}</span></summary><ul class="checklist">${c.photoChecklist
      .map((x) => {
        const note = have.has(x.role) ? (ai.has(x.role) && !s.photos.some((p) => p.usable && !p.ai && p.role === x.role) ? "（AI 示意图）" : "") : any.has(x.role) ? "（有，但图上带字，只放在详情页对比里）" : x.role === "cooked" ? "（没有？在“商品档案”里让 AI 做一盘）" : "";
        return `<li class="${have.has(x.role) ? "ok" : ""}">${have.has(x.role) ? "✓" : "○"} ${esc(x.need)}<small class="muted">${note}</small></li>`;
      })
      .join("")}</ul><p class="muted">缺的那几张图会自动跳过；补拍后在“商品档案”里上传。</p></details>`;
  }
  // Pictures the vision model couldn't read back yet: offer a free second look.
  function detailCheck(job) {
    const bad = (job.manifest?.textCheck || []).filter((c) => c.ok === false);
    if (!bad.length) return "";
    return `<details class="badge-detail"><summary class="badge bad">${bad.length} 屏文字有误</summary><ul>${bad
      .map((c) => `<li>${esc(job.frames?.[c.frame]?.title || `第 ${c.frame + 1} 屏`)}：${c.problems.map(problemText).join("；")}</li>`)
      .join("")}</ul><p class="muted">不对的屏可以点“✕”去掉，或在“我的作品”里一句话微调。</p></details>`;
  }
  function recheckLink(job) {
    const n = job?.manifest?.textCheck?.filter((c) => c.ok === null && !c.unsure?.length).length;
    return n ? `<p class="muted">有 ${n} 张图的文字还没核对上（校对 AI 当时没响应）。<button class="link" data-recheck="${job.id}">重新核对文字（免费）</button></p>` : "";
  }
  function partialResults(job, showImages = true) {
    return `<section class="card warn"><b>部分完成</b><p>${esc(job.error)}</p><button class="btn primary" data-resume="${job.id}">只补缺少的 ${job.manifest.missing.length} 张 · ${job.manifest.missing.length * (getWorkspace().skills[job.skillId]?.cost || 10)} 积分</button></section>
      ${showImages ? `<div class="results">${job.manifest.assets.map(a => `<article class="card result"><a href="${fileUrl(job,a.name)}" target="_blank" rel="noopener"><img src="${preview(fileUrl(job,a.name))}" loading="lazy" alt=""></a><b>${esc(job.frames[a.frame]?.title)}</b> <a href="${fileUrl(job,a.name,true)}">下载</a></article>`).join("")}</div>` : ""}`;
  }
  function bindResume(box, suiteId) {
    $$("[data-resume]", box).forEach(b => b.onclick = () => busy(b, async () => {
      await api(`/jobs/${b.dataset.resume}/retry`, json({}, { "Idempotency-Key": key() }));
      await refresh();
      suitePage(suiteId);
    }));
  }
  function jobResults(job) {
    if (!job) return "";
    if (["queued", "running"].includes(job.status)) return spinner(job.phase || "生成中", "一张图 1–3 分钟，可以先离开，稍后回来看");
    if (!["partial","succeeded"].includes(job.status)) return `<section class="card warn"><b>没有成功</b><p>${esc(job.error || "")}</p></section>`;
    const imgs = job.manifest.assets.filter((a) => ["image", "module"].includes(a.role));
    const ws = getWorkspace();
    // Product pictures of this product can be redrawn from other real photos.
    const swapRef = (i) => (job.id === current?.jobs?.shots?.id && current.shots?.some((x) => x.id === job.frames?.[i]?.ref) ? job.frames[i].ref : null);
    const bigger = (a) => {
      try {
        const [w, h] = upscaleSize(a.width, a.height).split("x").map(Number);
        return a.width < w || a.height < h;
      } catch {
        return false;
      }
    };
    return `${job.status === "partial" ? partialResults(job, false) : ""}${recheckLink(job)}<div class="results">${imgs
      .map((a, pos) => {
        const i = a.frame ?? pos;
        const title = job.frames?.[i]?.title || "商品图";
        const check = job.manifest.textCheck?.find((c) => c.frame === i);
        // The newest finished fine-tune of this picture stands in for it.
        const latest = job.tweaks?.find((t) => t.frame === i && t.status === "succeeded" && t.asset);
        const pending = job.tweaks?.find((t) => t.frame === i && ["queued", "running"].includes(t.status));
        const src = latest ? `/api/jobs/${latest.id}/files/${encodeURIComponent(latest.asset)}` : fileUrl(job, a.name);
        const count = job.tweaks?.filter((t) => t.frame === i && t.status === "succeeded").length || 0;
        // 4K: made from the picture the merchant is looking at (the fine-tuned one if there is one).
        const from = latest ? [latest.id, latest.asset] : [job.id, a.name];
        const up = job.upscales?.find((u) => u.sourceId === from[0] && u.sourceAsset === from[1] && !["failed", "cancelled"].includes(u.status));
        const canUp = job.status === "succeeded" && a.role === "image" && ws.providers.find((x) => x.mode === "api")?.ready && bigger(a);
        const upHtml = up
          ? up.status === "succeeded" && up.asset
            ? `<a class="link" href="/api/jobs/${up.id}/files/${encodeURIComponent(up.asset)}?download=1">下载 4K 版</a>`
            : `<a class="link" href="#/job/${up.id}">正在提升到 4K…</a>`
          : canUp
            ? `<button class="link" data-up="${from[0]}:${esc(from[1])}">提升到 4K · ${ws.skills.upscale.cost} 积分</button>`
            : "";
        return `<article class="card result" id="shot-result-${i}" tabindex="-1">
          <header class="result-bar"><h3><span class="no">${i + 1}</span>${esc(title)}</h3>${latest ? `<a class="badge" href="#/job/${latest.id}">已改 ${count} 次</a>` : check ? (check.ok ? `<span class="badge ok">✓ 文字已核对</span>` : check.ok === false ? `<span class="badge bad">文字有误</span>` : check.unsure?.length ? `<span class="badge muted-badge" title="AI 没读清图上的艺术字或小字，不一定有错">有字没读清</span>` : "") : ""}</header>
          <a href="${src}" target="_blank" rel="noopener"><img loading="lazy" decoding="async" src="${preview(src)}" alt="${esc(title)}，查看原图"></a>
          ${check?.ok === false && !latest ? `<ul class="problem-list">${check.problems.map((p) => `<li>${problemText(p)}</li>`).join("")}</ul>` : ""}
          ${pending ? `<p class="hint working"><i class="spin"></i>${pending.redo ? "正在重出这张" : "正在修改这张"}，好了会直接替换。<a href="#/job/${pending.id}">看进度</a></p>` : ""}
          <div class="result-actions"><button class="btn small navy" data-tweak="${latest ? `${latest.id}:0` : `${job.id}:${i}`}">修改</button><a class="btn small" href="${latest ? src + "?download=1" : fileUrl(job, a.name, true)}">下载</a><button class="link" data-redo="${job.id}:${i}">重出 · ${ws.skills.product.cost} 积分</button></div>
          <div class="result-more">${swapRef(i) ? `<button class="link" data-refs="${swapRef(i)}" data-go="1">换实拍图</button>` : ""}${upHtml}</div></article>`;
      })
      .join("")}</div>`;
  }
  function bindRedo(box) {
    $$("[data-up]", box).forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            const at = b.dataset.up.indexOf(":");
            await api(`/jobs/${b.dataset.up.slice(0, at)}/upscale`, json({ asset: b.dataset.up.slice(at + 1) }, { "Idempotency-Key": key() }));
            await refresh();
            toast("已开始提升到 4K，好了会出现“下载 4K 版”");
            suitePage(current.id);
          })),
    );
    $$("[data-tweak]", box).forEach((b) => (b.onclick = () => busy(b, () => tweak(...b.dataset.tweak.split(":").map((x, j) => (j ? Number(x) : x))))));
    $$("[data-refs]", box).forEach((b) => (b.onclick = () => photoPicker(b.dataset.refs, box.__collectShots)));
    $$("[data-redo]", box).forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            const [jobId, i] = b.dataset.redo.split(":");
            // Redraw with the words and scene as they are now in the plan, not as they were when the set was made.
            const ref = Object.values(current.jobs || {}).find((j) => j?.id === jobId)?.frames?.[Number(i)]?.ref;
            if (jobId === current.jobs?.shots?.id && (current.shots || []).some((x) => x.id === ref)) {
              // A product picture: made again from the plan as it is now (words, scene, real photos, look).
              await api(`/suites/${current.id}/shots/generate`, json({ only: ref }, { "Idempotency-Key": key() }));
              await refresh();
              toast("正在重出，好了会直接替换这张图");
              return void (await suitePage(current.id));
            }
            const now = (current.sections || []).find((x) => x.id === ref && (x.mode === "ai" || x.mode === "bg"));
            const body = { frame: Number(i), ...(now?.scene ? { scene: now.scene } : {}), ...(now?.texts?.length && now.mode !== "bg" ? { texts: now.texts.map((t) => ({ role: t.role, text: t.text })) } : {}) };
            await api(`/jobs/${jobId}/retry`, json(body, { "Idempotency-Key": key() }));
            await refresh();
            toast("正在重出，好了会直接替换这张图");
            await suitePage(current.id);
          })),
    );
  }
  // Which real photos one product picture is built from: pick among the product's photos or add a new one.
  function photoPicker(shotId, collectShots) {
    const s = current;
    const shot = (s.shots || []).find((x) => x.id === shotId);
    if (!shot) return;
    const cost = getWorkspace().skills.product.cost;
    let sel = [...shot.photos];
    const pool = s.photos.filter((p) => p.usable || sel.includes(p.file));
    const { wrap, close } = modal(`
      <h2>「${esc(shot.title)}」用哪几张实拍图</h2>
      <p class="muted">这张图会照着选中的实拍图来画，最多 3 张，标 1 的是主体。没有合适的就传一张新的。</p>
      <div class="pick-grid">${pool
        .map((p) => `<button class="pick" data-f="${esc(p.file)}" title="${esc(p.desc || "")}"><img loading="lazy" src="${preview(photoUrl(s, p.file), 320)}" alt="${esc(p.desc || "实拍图")}"><span>${esc(meta.roles[p.role] || "实拍图")}${p.ai ? "（AI 示意）" : ""}</span><i></i></button>`)
        .join("")}
        <label class="pick add" tabindex="0"><input type="file" accept="image/png,image/jpeg,image/webp" hidden><b>＋</b><span>上传新的实拍图</span></label></div>
      <div class="row wrap picker-actions"><button class="btn" id="pick-save">只保存</button><button class="btn primary" id="pick-go">保存并出这张 · ${cost} 积分</button></div>`);
    const mark = () =>
      $$(".pick[data-f]", wrap).forEach((b) => {
        const at = sel.indexOf(b.dataset.f);
        b.classList.toggle("on", at >= 0);
        $("i", b).textContent = at >= 0 ? at + 1 : "";
      });
    mark();
    $$(".pick[data-f]", wrap).forEach(
      (b) =>
        (b.onclick = () => {
          const f = b.dataset.f;
          if (sel.includes(f)) sel = sel.filter((x) => x !== f);
          else if (sel.length >= 3) return toast("最多选 3 张，先点掉一张", true);
          else sel.push(f);
          mark();
        }),
    );
    // Keep whatever is typed in the plan (if it is on screen) together with the new choice of photos.
    const save = async () => {
      const base = collectShots?.() || s.shots.map((x) => ({ id: x.id }));
      await saveSuite({ shots: base.map((x) => (x.id === shotId ? { ...x, photos: sel } : x)) });
    };
    $("#pick-save", wrap).onclick = (e) =>
      busy(e.currentTarget, async () => {
        if (!sel.length) throw new Error("至少选 1 张实拍图");
        await save();
        close();
        render(current);
        toast("已保存。点这张图的“重新出”，才会按新的实拍图来画");
      });
    $("#pick-go", wrap).onclick = (e) =>
      busy(e.currentTarget, async () => {
        if (!sel.length) throw new Error("至少选 1 张实拍图");
        await save();
        await api(`/suites/${s.id}/shots/generate`, json({ only: shotId }, { "Idempotency-Key": key() }));
        close();
        await refresh();
        toast("正在按新的实拍图出这张");
        await suitePage(s.id);
      });
    $("input[type=file]", wrap).onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      busy($(".pick.add", wrap), async () => {
        if (sel.length) await save();
        const form = new FormData();
        form.set("photo", file);
        current = await api(`/suites/${s.id}/shots/${encodeURIComponent(shotId)}/photo`, { method: "POST", body: form });
        close();
        render(current);
        toast("新的实拍图已加入，并排在这张图的第 1 张");
        photoPicker(shotId, collectShots);
      });
    };
  }
  const ROLE_NAME = { headline: "主标题", sub: "副标题", point: "卖点", tag: "小标" };
  function shotsTab(box, s) {
    const ws = getWorkspace();
    const cost = ws.skills.product.cost;
    const shots = s.shots;
    const job = s.jobs?.shots;
    const finished = job?.manifest?.assets.filter(a => a.role === "image" || a.role === "module") || [];
    const showResults = job && shotView === "results";
    const enabledShots = (shots || []).filter((x) => x.enabled);
    // Pictures made one at a time: each plan card shows its own, and the set takes over the ones still valid.
    const tryOf = (x) => s.jobs?.["try:" + x.id];
    const made = new Set(s.madeShots || []);
    const madeCount = enabledShots.filter((x) => made.has(x.id)).length;
    const rest = enabledShots.length - madeCount;
    const firstTry = madeCount || enabledShots.some((x) => tryOf(x)) ? null : enabledShots.find((x) => x.photos.length)?.id;
    const making = busyTask(s, "shots") || busyTask(s, "looks") || pendingJob(s.jobs?.shots);
    const madeHtml = (x) => {
      const tryBtn = (label) => (x.photos.length ? `<button class="link" data-try="${x.id}" ${making ? "disabled" : ""}>${label} · ${cost} 积分</button>` : "");
      // Already part of the finished set: the newest version is shown; making it again files a newer one.
      const at = job && ["succeeded", "partial"].includes(job.status) ? job.frames?.findIndex((f) => f.ref === x.id) ?? -1 : -1;
      const inSet = at >= 0 ? jobImage(job, at) : null;
      if (inSet) {
        const changing = job.tweaks?.find((v) => v.frame === at && pendingJob(v));
        if (changing) return `<p class="hint working"><i class="spin"></i>${changing.redo ? "正在重新出这张" : "正在改这张"}（${esc(changing.phase || "排队中")}），好了会替换整套里的第 ${at + 1} 张。</p>`;
        const newest = job.tweaks?.find((v) => v.frame === at && v.status === "succeeded" && v.asset);
        return `<div class="shot-made"><a href="${inSet}" target="_blank" rel="noopener"><img loading="lazy" src="${preview(inSet)}" alt="整套里的这张，点开看大图"></a>
          <div><b>已在整套里（第 ${at + 1} 张）</b>
          <div class="row wrap"><button class="link" data-tweak="${newest ? `${newest.id}:0` : `${job.id}:${at}`}">修改</button>${tryBtn("按现在的方案重新出")}</div></div></div>`;
      }
      const t = tryOf(x);
      if (!t) return tryBtn("单独出这张");
      const changing = t.tweaks?.find(pendingJob);
      if (pendingJob(t) || changing) return `<p class="hint working"><i class="spin"></i>${changing ? "正在改这张" : "正在单独出这张"}（${esc((changing || t).phase || "排队中")}），可以接着改别的图。</p>`;
      const url = jobImage(t);
      if (!url) return `<p class="warn-text">这张没出成功：${esc(t.error || "")}</p>${tryBtn("再出一次")}`;
      const ok = made.has(x.id);
      const newest = t.tweaks?.find((v) => v.status === "succeeded" && v.asset);
      return `<div class="shot-made ${ok ? "" : "stale"}"><a href="${url}" target="_blank" rel="noopener"><img loading="lazy" src="${preview(url)}" alt="单独出的这张，点开看大图"></a>
        <div><b>${ok ? "已出好，整套会直接用这张" : x.enabled ? "之后改过方案，整套会重新出这张" : "已出好（没勾“出这张”，不进整套）"}</b>
        <div class="row wrap"><button class="link" data-tweak="${newest ? `${newest.id}:0` : `${t.id}:0`}">修改</button>${tryBtn("重新出")}<a class="link" href="${url}${url.includes("?") ? "&" : "?"}download=1">下载</a></div></div></div>`;
    };
    box.innerHTML = `
      ${job ? `<div class="shot-toolbar"><div class="seg"><button data-panel="results" aria-pressed="${showResults}" class="${showResults ? "on" : ""}">生成结果${finished.length ? `（${finished.length}）` : ""}</button><button data-panel="plan" aria-pressed="${!showResults}" class="${showResults ? "" : "on"}">出图方案</button></div>
        ${finished.length > 1 ? `<select id="find-shot" aria-label="定位到商品图板块" ${showResults ? "" : "hidden"}><option value="">定位到板块…</option>${finished.map((a,pos) => { const i=a.frame ?? pos; return `<option value="${i}">第 ${i+1} 张 · ${esc(job.frames?.[i]?.title || "商品图")}</option>`; }).join("")}</select>` : ""}</div>
        <section id="shot-results" ${showResults ? "" : "hidden"}>${jobResults(job)}
        ${job.status === "succeeded" ? `<div class="next-row"><button class="btn navy" id="to-detail">下一步：做详情页</button></div>` : ""}</section>` : ""}
      <div id="shot-plan" ${showResults ? "hidden" : ""}>
      ${busyTask(s, "shots") ? spinner("AI 正在规划商品图", "给每张图挑实拍图、写标题和画面（约 1 分钟）") : ""}${failed(s, "shots")}
      ${checklist(s)}
      ${lookCard(s)}
      ${
        !shots
          ? `<div class="row"><button class="btn primary" id="plan-shots" ${busyTask(s, "shots") ? "disabled" : ""}>AI 规划商品图</button><span class="muted">不扣积分</span></div>`
          : `<div class="row spread plan-bar"><h2>出图方案<small class="muted">${shots.filter((x) => x.enabled).length} / ${shots.length} 张要出</small></h2><span class="muted">图上的字在这里改，出图时一字不差。<button class="link" id="replan-shots">重新规划</button></span></div>
            <div class="frames">${shots
              .map(
                (x, n) => `<article class="card frame shot ${x.enabled ? "" : "dim"}" data-shot="${x.id}">
                  <header><span class="no">${n + 1}</span><b>${esc(x.title)}</b><label class="mini"><input type="checkbox" data-en ${x.enabled ? "checked" : ""} ${x.photos.length ? "" : "disabled"}>出这张</label></header>
                  ${x.missing ? `<p class="hint">${esc(x.missing)}</p>` : ""}
                  <div class="shot-body">
                    <button class="shot-refs pickable" data-refs="${x.id}" title="换这张图参考的实拍图，或上传新的">${x.photos.map((f) => `<img loading="lazy" src="${preview(photoUrl(s, f), 320)}" alt="用到的实拍图">`).join("")}<span>${x.photos.length ? "换图" : "＋ 选实拍图"}</span></button>
                    <div class="tlines">${x.texts.map((t, j) => `<label class="tline"><span>${ROLE_NAME[t.role] || "文字"}</span><input data-t="${j}" value="${esc(t.text)}"></label>`).join("")}</div>
                  </div>
                  <details class="scene-desc"><summary>画面描述</summary><textarea data-scene rows="4">${esc(x.scene)}</textarea></details>
                  <div class="shot-one">${madeHtml(x)}</div>
                </article>`,
              )
              .join("")}</div>
            <div class="actionbar"><div class="actionbar-in"><span class="muted">${madeCount ? `已单独出好 ${madeCount} 张，整套直接用，不重复扣积分` : "每张都能先单独出来看效果，满意再出整套"}</span>
              <div class="row">${firstTry ? `<button class="btn" data-try="${firstTry}" ${making ? "disabled" : ""}>先出 1 张试试 · ${cost} 积分</button>` : ""}<button class="btn primary" id="gen-shots" ${making || !enabledShots.length ? "disabled" : ""}>${s.jobs?.shots?.status === "partial" && !madeCount ? `整组重新生成 ${rest} 张 · ${rest * cost} 积分` : !rest ? "都出好了，汇总成整套（免费）" : `${madeCount ? "生成其余" : "生成"} ${rest} 张 · ${rest * cost} 积分`}</button></div></div></div>`
      }
      </div>`;
    $$("[data-panel]", box).forEach(b => b.onclick = () => {
      shotView = b.dataset.panel;
      const results = shotView === "results";
      $("#shot-plan", box).hidden = results;
      $("#shot-results", box).hidden = !results;
      const jump = $("#find-shot", box);
      if (jump) jump.hidden = !results;
      $$("[data-panel]", box).forEach(btn => {
        btn.classList.toggle("on", btn === b);
        btn.setAttribute("aria-pressed", String(btn === b));
      });
    });
    $("#find-shot", box)?.addEventListener("change", e => {
      if (!e.target.value) return;
      const card = $("#shot-result-" + e.target.value, box);
      card.focus({ preventScroll: true });
      card.scrollIntoView({ block: "start" });
      e.target.value = "";
    });
    const collect = () =>
      shots.map((x) => {
        const card = $(`[data-shot="${x.id}"]`, box);
        return { id: x.id, enabled: $("[data-en]", card).checked, scene: $("[data-scene]", card).value, texts: x.texts.map((t, j) => ({ role: t.role, text: $(`[data-t="${j}"]`, card).value })) };
      });
    // Ticking "出这张" shows at once: the card lights up or dims, and the count and price follow.
    $$("[data-en]", box).forEach(
      (el) =>
        (el.onchange = async () => {
          el.closest("[data-shot]").classList.toggle("dim", !el.checked);
          const want = el.checked;
          try {
            await saveSuite({ shots: collect() });
            shotsTab(box, current);
          } catch (error) {
            el.checked = !want;
            el.closest("[data-shot]").classList.toggle("dim", want);
            toast("没保存上：" + error.message, true);
          }
        }),
    );
    // For the photo picker: what is typed in the plan right now (when the plan is the panel on screen).
    box.__collectShots = shots ? () => ($("#shot-plan", box)?.hidden ? null : collect()) : null;
    $("#plan-shots")?.addEventListener("click", (e) => busy(e.currentTarget, async () => (await api(`/suites/${s.id}/shots/plan`, json({})), suitePage(s.id))));
    $("#replan-shots")?.addEventListener("click", (e) => busy(e.currentTarget, async () => (await api(`/suites/${s.id}/shots/plan`, json({})), (lookChangedFor = null), suitePage(s.id))));
    $$("[data-try]", box).forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            await saveSuite({ shots: collect() });
            await api(`/suites/${s.id}/shots/generate`, json({ only: b.dataset.try }, { "Idempotency-Key": key() }));
            shotView = "plan";
            await refresh();
            await suitePage(s.id);
          })),
    );
    $("#gen-shots")?.addEventListener("click", (e) =>
      busy(e.currentTarget, async () => {
        await saveSuite({ shots: collect() });
        // The button named a count and a price; if an edit just changed which pictures can be kept, show the new ones first.
        const restNow = (current.shots || []).filter((x) => x.enabled && !(current.madeShots || []).includes(x.id)).length;
        if (restNow !== rest) {
          render(current);
          return toast("方案改动后，要出的张数和积分变了。请看一下新的数字，再点一次。", true);
        }
        await api(`/suites/${s.id}/shots/generate`, json({}, { "Idempotency-Key": key() }));
        shotView = "results";
        await refresh();
        await suitePage(s.id);
        if (tab === "shots") $("#tab")?.scrollIntoView({ block: "start" });
      }),
    );
    $("#to-detail")?.addEventListener("click", () => ((tab = "detail"), render(current)));
    bindResume(box,s.id);
    bindRedo(box);
    bindLooks(box, s);
  }

  /* ---------------- packaging ---------------- */
  // Asked right after the note: merchants with fixed foam boxes print an outer carton or a gift box,
  // and the new box then shows up in every product shot and detail screen.
  function packTab(box, s) {
    const ws = getWorkspace();
    const cost = ws.skills.product.cost;
    const pk = s.packaging || {};
    const art = s.jobs?.packArt;
    const mock = s.jobs?.packMock;
    const going = (j) => j && ["queued", "running"].includes(j.status);
    const toShots = `<button class="btn primary" id="pack-next">下一步：商品图 →</button>`;
    if (pk.need !== true) {
      box.innerHTML = `<section class="card pack-ask"><h2>需要设计包装吗？</h2>
        <p class="muted">有固定泡沫箱、想在外面套一个印好的纸箱或做礼盒的，选“需要”。先把包装定下来，后面的商品图和详情页都会用新包装。</p>
        <div class="row wrap"><button class="btn primary" id="pack-yes">需要设计包装</button><button class="btn" id="pack-no">${pk.need === false ? "不需要（已选）" : "不需要，用现有包装"}</button></div></section>
        ${pk.need === false ? `<div class="row">${toShots}</div>` : ""}`;
      $("#pack-yes").onclick = (e) => busy(e.currentTarget, async () => ((current = await api(`/suites/${s.id}/packaging`, json({ need: true }))), render(current)));
      $("#pack-no").onclick = (e) =>
        busy(e.currentTarget, async () => {
          current = await api(`/suites/${s.id}/packaging`, json({ need: false }));
          tab = "shots";
          render(current);
        });
      $("#pack-next")?.addEventListener("click", () => ((tab = "shots"), render(current)));
      return;
    }
    const box3 = pk.box || {};
    const extra = (pk.extra || []).map(([k, v]) => `${k}：${v}`).join("\n");
    const arts = art?.status === "succeeded" ? art.manifest.assets.filter((a) => a.role === "image") : [];
    const chosen = pk.front;
    const adopted = pk.adopted;
    box.innerHTML = `
      <section class="card"><div class="row spread"><h2>包装信息</h2><button class="link" id="pack-no">不做包装了</button></div>
        <div class="pills" role="group">${[["carton", "外箱纸箱（套在泡沫箱外）"], ["gift", "礼盒（天地盖）"]].map(([k, v]) => `<button class="pill ${pk.kind === k ? "on" : ""}" data-kind="${k}">${v}</button>`).join("")}</div>
        <label class="lbl">泡沫箱外尺寸（厘米）</label>
        <div class="row dims"><input id="pk-l" inputmode="decimal" placeholder="长" value="${esc(box3.l ?? "")}"><span>×</span><input id="pk-w" inputmode="decimal" placeholder="宽" value="${esc(box3.w ?? "")}"><span>×</span><input id="pk-h" inputmode="decimal" placeholder="高" value="${esc(box3.h ?? "")}"></div>
        ${pk.size ? `<p class="muted">${pk.kind === "gift" ? "礼盒" : "外箱"}内尺寸约 <b>${pk.size.l} × ${pk.size.w} × ${pk.size.h} cm</b>（泡沫箱外再留一点余量），主画面：${esc(pk.face.name)} ${pk.face.w} × ${pk.face.h} cm</p>` : ""}
        <label class="lbl">品牌 / 店名（印在包装上，可不填）</label><input id="pk-brand" maxlength="16" value="${esc(pk.brand || "")}">
        <label class="lbl">侧面还要印的信息（每行一条“名称：内容”，如 生产商：××水产 / 电话：××）</label>
        <textarea id="pk-extra" rows="3">${esc(extra)}</textarea>
        <p class="muted">品名、规格、贮存、产地、发货地会从商品档案自动印上，字由程序排，不会错字。</p>
        <button class="btn" id="pk-save">保存</button></section>
      ${lookCard(s)}
      ${!s.looks?.length && !busyTask(s, "looks") ? `<div class="row"><button class="btn" id="pk-looks">AI 挑 3 个风格（免费）</button><span class="muted">包装、商品图、详情页用同一套</span></div>` : ""}
      <section class="card"><h2>包装正面</h2>
        ${going(art) ? spinner(art.phase || "生成中", "两个方案，约 2–3 分钟") : ""}
        ${art?.status === "failed" ? `<p class="warn-text">${esc(art.error || "没有成功")}</p>` : ""}
        ${arts.length ? `<div class="pack-arts">${arts.map((a) => `<figure class="${chosen === `${art.id}/${a.name}` ? "on" : ""}"><img src="${preview(fileUrl(art, a.name))}" alt=""><button class="btn small ${chosen === `${art.id}/${a.name}` ? "" : "primary"}" data-pick="${a.name}">${chosen === `${art.id}/${a.name}` ? "已选这个" : "用这个"}</button></figure>`).join("")}</div>` : ""}
        <div class="row"><button class="btn ${arts.length ? "" : "primary"}" id="pk-art" ${pk.size && !going(art) ? "" : "disabled"}>${arts.length ? "再出 2 个方案" : "出 2 个包装正面方案"} · ${2 * cost} 积分</button>${pk.size ? "" : `<span class="muted">先填尺寸并保存</span>`}</div>
      </section>
      ${
        pk.dieline
          ? `<section class="card"><h2>给印刷厂的文件</h2>
              <img class="dieline" src="/api/suites/${s.id}/packaging/dieline.png?v=${encodeURIComponent(chosen || "")}&thumb=720" alt="展开图">
              <div class="row wrap"><a class="btn small" href="/api/suites/${s.id}/packaging/dieline.png" download>下载展开图（带尺寸）</a><a class="btn small" href="/api/suites/${s.id}/packaging/front.png" download>下载正面设计稿</a></div>
              <p class="muted">展开图按真实尺寸排好了正面、侧面信息和摇盖，标了裁切线和压痕线，给印刷厂做刀版参考；最终刀版、纸张和出血以印刷厂为准。</p></section>
            <section class="card"><h2>立体效果图</h2>
              ${going(mock) ? spinner(mock.phase || "生成中", "约 1–2 分钟") : ""}
              ${mock?.status === "failed" ? `<p class="warn-text">${esc(mock.error || "没有成功")}</p>` : ""}
              ${mock?.status === "succeeded" ? `<img class="pack-mock" src="${preview(fileUrl(mock, mock.manifest.assets.find((a) => a.role === "image").name))}" alt="">
                <div class="row wrap">${adopted ? `<span class="ok-text">已用这个包装，后面的商品图和详情页会照它出。</span>${toShots}` : `<button class="btn primary" id="pk-adopt">用这个包装做后面的商品图和详情页</button>`}</div>` : ""}
            </section>`
          : ""
      }`;
    const dims = () => ({ l: $("#pk-l").value, w: $("#pk-w").value, h: $("#pk-h").value });
    const save = (extraBody = {}) =>
      api(`/suites/${s.id}/packaging`, json({
        box: dims(),
        brand: $("#pk-brand").value,
        extra: $("#pk-extra").value.split("\n").map((l) => l.split(/[:：]/)).filter((r) => r.length >= 2).map(([k, ...v]) => [k, v.join("：")]),
        ...extraBody,
      }));
    $$("[data-kind]", box).forEach((b) => (b.onclick = () => busy(b, async () => ((current = await api(`/suites/${s.id}/packaging`, json({ kind: b.dataset.kind }))), render(current)))));
    $("#pk-save").onclick = (e) => busy(e.currentTarget, async () => ((current = await save()), toast("已保存"), render(current)));
    $("#pack-no").onclick = (e) => busy(e.currentTarget, async () => ((current = await api(`/suites/${s.id}/packaging`, json({ need: false }))), render(current)));
    $("#pk-looks")?.addEventListener("click", (e) => busy(e.currentTarget, async () => (await api(`/suites/${s.id}/looks`, json({})), suitePage(s.id))));
    $("#pk-art")?.addEventListener("click", (e) =>
      busy(e.currentTarget, async () => {
        await save();
        await api(`/suites/${s.id}/packaging/art`, json({}, { "Idempotency-Key": key() }));
        await refresh();
        suitePage(s.id);
      }),
    );
    $$("[data-pick]", box).forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            await api(`/suites/${s.id}/packaging/choose`, json({ asset: b.dataset.pick }, { "Idempotency-Key": key() }));
            await refresh();
            suitePage(s.id);
          })),
    );
    $("#pk-adopt")?.addEventListener("click", (e) => busy(e.currentTarget, async () => ((current = await api(`/suites/${s.id}/packaging/adopt`, json({}))), toast("后面的商品图和详情页会重新规划，用上新包装"), render(current))));
    $("#pack-next")?.addEventListener("click", () => ((tab = "shots"), render(current)));
    bindLooks(box, s);
  }

  // Visual direction: 3 suggestions from the style library, or plain retouch of the real photos.
  let lookChangedFor = null; // the product whose look changed since its plan was made
  function lookCard(s) {
    const looks = s.looks || [];
    if (busyTask(s, "looks")) return spinner("AI 正在准备风格", "挑选或拆解风格，约半分钟");
    const lookFailed = s.tasks?.looks?.status === "failed" ? `<p class="warn-text">${esc(s.tasks.looks.error)}</p>` : "";
    const ownLookTile = `<label class="look plain upload-look" tabindex="0"><input type="file" id="own-look" accept="image/png,image/jpeg,image/webp" hidden><span class="plain-ico">＋</span><b>上传我喜欢的风格</b><small>传一张你觉得好看的图，整套照它的感觉做</small></label>`;
    if (!looks.length) return `<section class="card look-card"><h2>风格</h2><p class="muted">点“AI 规划商品图”时，AI 会先从风格库挑 3 个适合这件商品的方向，挑好后可以换。也可以直接传一张你喜欢的图。</p>${lookFailed}<div class="looks">${ownLookTile}</div></section>`;
    const on = (l) => s.look && s.look.styleId === l.styleId && s.look.conceptName === l.conceptName;
    return `<section class="card look-card"><div class="row spread"><h2>风格 <small class="muted">商品图和详情页用同一套</small></h2><button class="link" id="more-looks">换一批</button></div>
      <div class="looks">${looks
        .map(
          (l, i) => `<button class="look ${on(l) ? "on" : ""}" data-look="${i}"><img src="/api/styles/${encodeURIComponent(l.styleId)}/cover?thumb=320" alt="" loading="lazy">
            <b>${esc(l.conceptName)}</b>${l.own ? `<em class="own-tag">我上传的</em>` : ""}<span class="swatches">${(l.palette || []).map((c) => `<i data-c="${esc(c)}"></i>`).join("")}</span><small>${esc(l.why || l.story)}</small></button>`,
        )
        .join("")}
        <button class="look plain ${s.look ? "" : "on"}" data-look="plain"><span class="plain-ico">📷</span><b>实拍精修</b><small>不套风格，在实拍基础上重新布光排版</small></button>
        ${ownLookTile}</div>
      ${lookFailed}${s.shots && lookChangedFor === s.id ? `<p class="hint">换了风格，点“重新规划”让标题和画面跟着变（免费）</p>` : ""}</section>`;
  }
  function bindLooks(box, s) {
    $$(".swatches i", box).forEach((i) => (i.style.background = i.dataset.c));
    $$("[data-look]", box).forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            current = await api(`/suites/${s.id}/look`, json({ index: b.dataset.look === "plain" ? null : Number(b.dataset.look) }));
            lookChangedFor = s.id;
            render(current);
          })),
    );
    const own = $("#own-look", box);
    if (own)
      own.onchange = () => {
        const file = own.files[0];
        if (!file) return;
        busy(own.closest("label"), async () => {
          const form = new FormData();
          form.set("image", file);
          await api(`/suites/${s.id}/look/upload`, { method: "POST", body: form });
          lookChangedFor = s.id;
          toast("已收到，AI 正在拆解这张图的风格（约半分钟）");
          await suitePage(s.id);
        });
      };
    $("#more-looks", box)?.addEventListener("click", (e) => busy(e.currentTarget, async () => (await api(`/suites/${s.id}/looks`, json({})), suitePage(s.id))));
  }

  // AI dish pictures: for stock that hasn't been cooked and photographed yet.
  const DISH_METHODS = ["清蒸", "红烧", "香煎", "干炸", "椒盐", "糖醋", "炖汤", "凉拌", "烧烤", "蒜蓉"];
  function dishCard(s) {
    if (!["生鲜水产", "农副产品", "食品零食"].includes(s.profile.category) && !s.photos.some((p) => p.role === "cooked")) return "";
    const job = s.jobs?.dish;
    const hasReal = s.photos.some((p) => p.role === "cooked" && !p.ai);
    const fromTips = (s.profile.usage?.tips || []).join(" ");
    const methods = [...new Set([...DISH_METHODS.filter((m) => fromTips.includes(m)), ...DISH_METHODS])].slice(0, 8);
    const adopted = new Set(s.photos.filter((p) => p.fromJob).map((p) => p.fromJob));
    let results = "";
    if (job && ["queued", "running"].includes(job.status)) results = `<p class="hint">正在做菜…（${esc(job.phase || "排队中")}，约 1–2 分钟）</p>`;
    else if (job?.status === "failed") results = `<p class="warn-text">${esc(job.error || "没有成功")}</p>`;
    else if (job?.status === "succeeded")
      results = `<div class="dish-results">${job.manifest.assets
        .filter((a) => a.role === "image")
        .map((a) => {
          const used = adopted.has(`${job.id}/${a.name}`);
          return `<figure><img src="/api/jobs/${job.id}/files/${encodeURIComponent(a.name)}?thumb=720" loading="lazy" alt=""><button class="btn small ${used ? "" : "primary-soft"}" data-adopt="${esc(a.name)}" data-job="${job.id}" ${used ? "disabled" : ""}>${used ? "✓ 已加入" : "用这张"}</button></figure>`;
        })
        .join("")}</div><p class="muted">点“用这张”加入实拍图库，商品图和详情页的“吃法”会用它。</p>`;
    return `<section class="card dish-card"><h2>${hasReal ? "再做几盘菜" : "还没做成菜？让 AI 做一盘"} <small class="muted">照着你的生鲜实拍图做，食材样子不变</small></h2>
      <div class="pills" id="dish-methods">${methods.map((m, i) => `<button class="pill ${i === 0 ? "on" : ""}" data-m="${esc(m)}">${esc(m)}</button>`).join("")}</div>
      <div class="pills" id="dish-look"><button class="pill on" data-look="home">家常随手拍</button><button class="pill" data-look="shop">餐厅精致</button></div>
      <div class="row wrap"><input id="dish-custom" maxlength="20" placeholder="或者自己写，例如：雪菜蒸"><button class="btn" id="make-dish">做 2 盘 · ${2 * getWorkspace().skills.product.cost} 积分</button></div>
      <label class="mini"><input type="checkbox" id="ai-label" ${s.aiLabel === false ? "" : "checked"}>用到 AI 菜品图的商品图，角落标“烹饪示意 图片仅供参考”</label>
      ${results}</section>`;
  }
  function bindDish(box, s) {
    let method = $("#dish-methods .pill.on", box)?.dataset.m || "";
    $$("#dish-methods .pill", box).forEach(
      (b) =>
        (b.onclick = () => {
          $$("#dish-methods .pill", box).forEach((x) => x.classList.toggle("on", x === b));
          method = b.dataset.m;
          $("#dish-custom", box).value = "";
        }),
    );
    $("#make-dish", box)?.addEventListener("click", (e) =>
      busy(e.currentTarget, async () => {
        const m = $("#dish-custom", box).value.trim() || method;
        const look = $("#dish-look .pill.on", box)?.dataset.look || "home";
        await api(`/suites/${s.id}/dish`, json({ method: m, count: 2, look }, { "Idempotency-Key": key() }));
        await refresh();
        suitePage(s.id);
      }),
    );
    $$("#dish-look .pill", box).forEach((b) => (b.onclick = () => $$("#dish-look .pill", box).forEach((x) => x.classList.toggle("on", x === b))));
    $("#ai-label", box)?.addEventListener("change", (e) => saveSuite({ aiLabel: e.target.checked }));
    $$("[data-adopt]", box).forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            current = await api(`/suites/${s.id}/photos/adopt`, json({ jobId: b.dataset.job, asset: b.dataset.adopt }));
            toast("已加入实拍图库（标为 AI 示意）");
            render(current);
          })),
    );
  }

  /* ---- tab 4: detail page ---- */
  function aiImage(s, sec) {
    const job = s.jobs?.detail;
    if (job?.status !== "succeeded") return null;
    const i = job.frames?.findIndex((f) => f.ref === sec.id);
    const latest = job.tweaks?.find((t) => t.frame === i && t.status === "succeeded" && t.asset);
    if (latest) return `/api/jobs/${latest.id}/files/${encodeURIComponent(latest.asset)}`;
    const asset = job.manifest.assets.filter((a) => a.role === "module")[i];
    return asset ? fileUrl(job, asset.name) : null;
  }
  const hi = (body, mark) => {
    const b = esc(body || "");
    return mark && body?.includes(mark) ? b.replace(esc(mark), `<em>${esc(mark)}</em>`) : b;
  };
  function cardsTpl(v) {
    if (!v.headline && !v.body) return "";
    return `<div class="tp-kicker">${esc(v.kicker)}</div><h3 class="tp-head">${nl(v.headline)}</h3>
      ${v.cards.length ? `<div class="tp-cards">${v.cards.map((c) => `<div><strong class="${bigSize(c.big)}">${esc(c.big)}</strong><b>${esc(c.label)}</b><small>${esc(c.sub)}</small></div>`).join("")}</div>` : ""}
      ${v.body ? `<p class="tp-body">${hi(v.body, v.highlight)}</p>` : ""}`;
  }
  const secName = (x) => (x.type === "shot" ? `商品图 · ${x.name || ""}` : meta.sections[x.type].name);
  function sectionHtml(s, sec, safe) {
    if (sec.type === "shot") {
      const url = shotImage(s, sec.shot);
      return url ? `<img class="tp-img" data-original="${url}" src="${preview(url)}" alt="">` : `<div class="tp-wait">${esc(secName(sec))}<small>这张商品图出好后显示在这里</small></div>`;
    }
    const p = s.profile;
    const t = (x) => (safe ? safeText(x) : x);
    if (sec.mode === "ai") {
      const url = aiImage(s, sec);
      return url ? `<img class="tp-img" data-original="${url}" src="${preview(url)}" alt="">` : `<div class="tp-wait">${esc(meta.sections[sec.type].name)}<small>AI 出图后显示在这里</small></div>`;
    }
    if (sec.mode === "photo") {
      const f = sec.photos[0] || s.photos.find((ph) => ph.usable && meta.sections[sec.type].photo.includes(ph.role))?.file;
      return `${f ? `<img class="tp-img" data-original="${photoUrl(s, f)}" src="${preview(photoUrl(s,f))}" alt="">` : ""}<div class="tp-caption">${esc(meta.sections[sec.type].name)}</div>`;
    }
    const tpl = {
      why: () => cardsTpl({ ...p.why, headline: t(p.why.headline), body: t(p.why.body) }),
      faq: () => cardsTpl({ ...p.faq, headline: t(p.faq.headline), body: t(p.faq.body) }),
      compare: () => {
        const c = p.compare;
        const pics = s.photos.filter((ph) => ph.usable && ph.role === "compare").slice(0, 2);
        return `<div class="tp-kicker">看得见的差别</div><h3 class="tp-head">${head(t(c.headline) || `${c.ours} vs ${c.others}`)}</h3>
          ${pics.length ? `<div class="tp-pics">${pics.map((ph) => `<img data-original="${photoUrl(s, ph.file)}" src="${preview(photoUrl(s,ph.file))}" alt="">`).join("")}</div>` : ""}
          <table class="tp-table"><tr><th></th><th class="ours">${esc(c.ours)}</th><th>${esc(c.others)}</th></tr>${c.rows.map((r) => `<tr><td>${esc(r.aspect)}</td><td class="ours">${esc(t(r.ours))}</td><td>${esc(r.others)}</td></tr>`).join("")}</table>
          ${c.note ? `<p class="tp-body">${esc(t(c.note))}</p>` : ""}`;
      },
      pick: () => `<div class="tp-kicker">买之前看一眼</div><h3 class="tp-head">${head(t(p.pick.headline) || "怎么挑")}</h3>
        <ol class="tp-points">${p.pick.points.map((x, i) => `<li><span>${String(i + 1).padStart(2, "0")}</span><div><b>${esc(t(x.title))}</b><p>${esc(t(x.detail))}</p></div></li>`).join("")}</ol>`,
      material: () => `<h3 class="tp-head">${esc(p.sellingPoints[0]?.title || "选材")}</h3><ol class="tp-points">${p.sellingPoints.map((x, i) => `<li><span>${String(i + 1).padStart(2, "0")}</span><div><b>${esc(t(x.title))}</b><p>${esc(t(x.detail))}</p></div></li>`).join("")}</ol>`,
      normal: () => `<div class="tp-kicker">收到别担心</div><h3 class="tp-head">${head(t(p.normal?.headline) || "这些是正常现象")}</h3>
        <ol class="tp-points">${(p.normal?.items || []).map((x, i) => `<li><span>${String(i + 1).padStart(2, "0")}</span><div><b>${esc(t(x.title))}</b><p>${esc(t(x.detail))}</p></div></li>`).join("")}</ol>`,
      pack: () => `<h3 class="tp-head">从包装，到收货</h3><p class="tp-body">${esc(p.packaging)}</p>`,
      info: () => `<h3 class="tp-head">商品信息</h3><table class="tp-info">${[["品名", p.name], ["产地", p.origin], ["发货地", p.shipFrom], ["规格", p.spec], ["储存", p.storage], ["包装", p.packaging], ["快递", p.courier], ["发货时效", p.dispatch]]
        .filter(([, v]) => v)
        .map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`)
        .join("")}</table>`,
      notice: () => `<h3 class="tp-head">下单与收货须知</h3><ol class="tp-notice">${p.notice.map((x, i) => `<li><span>${String(i + 1).padStart(2, "0")}</span>${esc(t(x))}</li>`).join("")}</ol>`,
    }[sec.type];
    return tpl ? tpl() : "";
  }
  const RISKY = [["没有之一", ""], ["最好吃", "口碑好"], ["最好", "很好"], ["最佳", "很适合"], ["最香", "很香"], ["最肥", "正当季"], ["最厚", "很厚"], ["最新鲜", "很新鲜"], ["第一", "领先"], ["唯一", "独特"], ["顶级", "高品质"], ["极品", "精选"], ["全网最低", "实惠"]];
  const safeText = (x) => RISKY.reduce((acc, [w, r]) => acc.split(w).join(r), String(x || "")).replace(/，，/g, "，");
  let safeMode = true;
  let detailView = "board";
  let addOpen = false;
  let fitDetail = () => {};
  addEventListener("resize", () => fitDetail());
  const MODE_SHORT = { ai: "AI 出图", bg: "底图排字", tpl: "排版", photo: "实拍", shot: "商品图", off: "不要" };
  const SECTION_WHY = {
    hero: "第一眼留住人，讲清卖的是什么。",
    why: "讲产地凭什么好，先把信任立住。",
    origin: "用实景证明东西从哪来。",
    compare: "和普通货放一起，差别一眼看到。",
    pick: "教买家怎么辨别，顺带证明自己经得起看。",
    material: "把卖点落到看得见的细节上。",
    usage: "让人想到端上桌的样子。",
    faq: "下单前的顾虑，提前说掉。",
    normal: "这些情况属于正常，减少售后争议。",
    pack: "怎么包、怎么发，打消运输顾虑。",
    info: "规格参数一次看全。",
    notice: "下单和收货的规则。",
  };
  function detailTab(box, s) {
    const ws = getWorkspace();
    const cost = ws.skills.detail.cost;
    const pal = s.palette?.length ? s.palette : ["#1d3557", "#e8541e", "#f6efe6"];
    const ai = s.sections.filter((x) => x.mode === "ai" || x.mode === "bg");
    const planned = ai.length && ai.every((x) => x.scene);
    const job = s.jobs?.detail;
    // Every AI screen still in the page already has a picture: removing screens needs no new run.
    const done = job?.status === "succeeded" && ai.every((x) => aiImage(s, x));
    // One screen of a finished set can be redrawn or fine-tuned on its own.
    const frameNo = (x) => (job?.status === "succeeded" && (x.mode === "ai" || x.mode === "bg") ? job.frames?.findIndex((f) => f.ref === x.id) ?? -1 : -1);
    const pendingOf = (x) => job?.tweaks?.find((t) => t.frame === frameNo(x) && pendingJob(t));
    const latestOf = (x) => job?.tweaks?.find((t) => t.frame === frameNo(x) && t.status === "succeeded" && t.asset);
    // Finished product pictures that can be dropped into the page.
    const addable = (s.shots || []).map((x) => ({ id: x.id, title: x.title, url: shotImage(s, x.id), sec: s.sections.find((y) => y.type === "shot" && y.shot === x.id) })).filter((a) => a.url);
    const live = s.sections.filter((x) => x.mode !== "off");
    const no = (x) => String(live.indexOf(x) + 1).padStart(2, "0");
    const running = busyTask(s, "detail") || ["queued", "running"].includes(job?.status);
    box.innerHTML = `
      ${busyTask(s, "detail") ? spinner("AI 正在规划详情页画面", "约 1 分钟") : ""}${failed(s, "detail")}
      <div class="sb-layout">
        <aside class="card sb-rail">
          <h2>详情页分镜<small class="muted">${live.length} 屏</small></h2>
          <ol class="sb-toc">${s.sections
            .map((x) => `<li class="${x.mode === "off" ? "off" : ""}"><button data-goto="${x.id}"><i>${x.mode === "off" ? "–" : no(x)}</i><span>${esc(secName(x))}</span><em class="m-${x.mode}">${MODE_SHORT[x.mode]}</em></button></li>`)
            .join("")}</ol>
          ${addable.length ? `<details class="sb-add" ${addOpen ? "open" : ""}><summary>＋ 把商品图放进详情页</summary><p class="muted">点一张就加到详情页末尾，再用 ↑↓ 挪到想要的位置。不花积分。</p>
            <div class="add-grid">${addable.map((a) => `<button class="add-shot ${a.sec ? "in" : ""}" data-add="${a.id}" title="${esc(a.title)}"><img loading="lazy" src="${preview(a.url, 320)}" alt="${esc(a.title)}"><span>${a.sec ? "已放入" : esc(a.title)}</span></button>`).join("")}</div></details>` : ""}
          ${s.look !== undefined ? `<p class="muted look-line">风格：<b>${esc(s.look?.conceptName || "实拍精修")}</b>，在“商品图”里换</p>` : ""}
          <label class="mini"><input type="checkbox" id="safe" ${safeMode ? "checked" : ""}>淘宝合规（自动替换“最、第一”等极限词）</label>
          <div class="sb-actions">
            <button class="btn" id="plan-detail">${planned ? "重新规划 AI 画面" : "AI 规划画面"}（免费）</button>
            ${planned ? `<button class="btn ${done ? "" : "primary"}" id="gen-detail" ${running ? "disabled" : ""}>${done || job?.status === "partial" ? "全部重新生成" : "生成"} ${ai.length} 屏 · ${ai.length * cost} 积分</button>` : ""}
            <button class="btn ${done ? "primary" : "navy"}" id="export">导出详情长图</button>
          </div>
          ${job && ["queued", "running"].includes(job.status) ? spinner(job.phase || "生成中", `共 ${job.frames?.length || ai.length} 屏，约 ${ai.length * 2} 分钟`) : ""}
          ${job?.status === "partial" ? partialResults(job) : job?.status === "failed" ? `<p class="warn-text">${esc(job.error)}</p>` : ""}
          ${done ? `<p class="ok-text">AI 图都已生成。去掉某屏或调顺序后直接导出，不用重新生成。</p>` : ""}
          ${job?.status === "succeeded" ? recheckLink(job) + detailCheck(job) : ""}
          <details class="sb-help"><summary>三种做法怎么选</summary><p class="muted">“AI 出图”整屏由 AI 画。字多、要一字不错的屏（答疑、商品信息、须知）用“AI 底图+排字”：AI 只画背景，字由程序排，改字免费。哪屏不满意点“不要这屏”，长图里就不拼它，不扣积分。</p><button class="link" id="all-ai">全部改成 AI 出图</button></details>
        </aside>
        <div class="sb-main ${detailView === "long" ? "long" : ""}">
          <div class="sb-top"><div class="seg small"><button data-dview="board" class="${detailView === "long" ? "" : "on"}">分镜编辑</button><button data-dview="long" class="${detailView === "long" ? "on" : ""}">长图预览</button></div><span class="muted sb-tip">点左边的小图可以看大图</span></div>
          <div class="sb-list">${s.sections
            .map((x, i) => {
              if (x.type === "shot")
                return `<article class="sb-card" data-sec="${x.id}" id="sec-${x.id}">
                  <button class="sb-phone" data-zoom="${x.id}" aria-label="看第 ${no(x)} 屏大图"><div class="dp"><div class="dp-sec" data-pv="${x.id}">${sectionHtml(s, x, safeMode)}</div></div></button>
                  <div class="sb-info">
                    <header><span class="no">${no(x)}</span><b>${esc(secName(x))}</b><div class="sec-move"><button data-up="${i}" aria-label="上移">↑</button><button data-down="${i}" aria-label="下移">↓</button></div></header>
                    <p class="sb-why">直接放一张做好的商品图，不花积分。想换图上的内容，到“商品图”里修改或重出，这里会跟着变。</p>
                    <div class="sb-foot"><button class="link" data-dl="${x.id}">导出这一屏</button><button class="link danger" data-remove="${x.id}">移出详情页</button></div>
                  </div>
                </article>`;
              const m = meta.sections[x.type];
              const modes = `<select data-mode aria-label="这一屏的做法">${[...m.modes, "off"].map((k) => `<option value="${k}" ${x.mode === k ? "selected" : ""}>${meta.modes[k]}</option>`).join("")}</select>`;
              if (x.mode === "off") return `<article class="sb-card off" data-sec="${x.id}" id="sec-${x.id}"><div class="sb-info"><header><span class="no">–</span><b>${esc(m.name)}</b><span class="muted">已去掉，改回任一做法就恢复</span></header>${modes}</div></article>`;
              const photos = x.photos?.length ? x.photos : [];
              return `<article class="sb-card" data-sec="${x.id}" id="sec-${x.id}">
                <button class="sb-phone" data-zoom="${x.id}" aria-label="看第 ${no(x)} 屏大图"><div class="dp"><div class="dp-sec ${x.mode === "tpl" ? "tpl" : x.mode === "bg" ? "bg" : ""}" data-pv="${x.id}">${x.mode === "bg" ? `<div class="bg-panel">${sectionHtml(s, x, safeMode)}</div>` : sectionHtml(s, x, safeMode)}</div></div></button>
                <div class="sb-info">
                  <header><span class="no">${no(x)}</span><b>${esc(m.name)}</b><div class="sec-move"><button data-up="${i}" aria-label="上移">↑</button><button data-down="${i}" aria-label="下移">↓</button></div></header>
                  <p class="sb-why">${SECTION_WHY[x.type] || ""}</p>
                  <label class="tline"><span>做法</span>${modes}</label>
                  ${x.mode === "ai" ? x.texts.map((t, j) => `<label class="tline"><span>${ROLE_NAME[t.role] || "文字"}</span><input data-tx="${j}" value="${esc(t.text)}"></label>`).join("") : `<p class="hint">${x.mode === "photo" ? "直接用实拍图，不花积分。" : "文字来自“商品档案”，在那里改，这里自动更新。"}</p>`}
                  ${x.scene ? `<details class="scene-desc"><summary>画面描述</summary><textarea data-scene rows="5">${esc(x.scene)}</textarea></details>` : ""}
                  ${photos.length ? `<div class="shot-refs">${photos.map((f) => `<img loading="lazy" src="${preview(photoUrl(s, f), 320)}" alt="用到的实拍图">`).join("")}</div>` : ""}
                  ${frameNo(x) >= 0 && pendingOf(x) ? `<p class="hint working"><i class="spin"></i>${pendingOf(x).redo ? "正在重出这一屏" : "正在修改这一屏"}，好了会直接替换。</p>` : ""}
                  <div class="sb-foot">${frameNo(x) >= 0 && !pendingOf(x) ? `<button class="link" data-redo="${job.id}:${frameNo(x)}">重出这一屏 · ${cost} 积分</button><button class="link" data-tweak="${latestOf(x) ? `${latestOf(x).id}:0` : `${job.id}:${frameNo(x)}`}">修改这一屏</button>` : ""}<button class="link" data-dl="${x.id}">导出这一屏</button><button class="link danger" data-off="${x.id}">不要这屏</button></div>
                </div>
              </article>`;
            })
            .join("")}</div>
        </div>
      </div>`;
    bindResume(box,s.id);
    bindRedo(box);
    const main = $(".sb-main", box);
    for (const dp of $$(".dp", box)) {
      dp.style.setProperty("--c1", pal[0]);
      dp.style.setProperty("--c2", pal[1] || pal[0]);
      dp.style.setProperty("--c3", pal[2] || "#f6efe6");
    }
    // The 750px screens are scaled to their phone frame (CSP: through the CSSOM).
    const fit = () => $$(".sb-phone", box).forEach((ph) => ($(".dp", ph).style.zoom = String(ph.clientWidth / 750)));
    fitDetail = fit;
    fit();
    const setView = (v, goto) => {
      detailView = v;
      main.classList.toggle("long", v === "long");
      $$("[data-dview]", box).forEach((b) => b.classList.toggle("on", b.dataset.dview === v));
      fit();
      if (goto) $("#sec-" + goto, box)?.scrollIntoView({ block: "start" });
    };
    $$("[data-dview]", box).forEach((b) => (b.onclick = () => setView(b.dataset.dview)));
    $$("[data-zoom]", box).forEach((b) => (b.onclick = () => setView(detailView === "long" ? "board" : "long", b.dataset.zoom)));
    $$("[data-goto]", box).forEach((b) => (b.onclick = () => $("#sec-" + b.dataset.goto, box)?.scrollIntoView({ block: "start", behavior: "smooth" })));
    // AI backgrounds behind the typeset screens (CSP: set through CSSOM, not inline styles).
    for (const x of s.sections.filter((y) => y.mode === "bg")) {
      const url = aiImage(s, x);
      if (url) {
        const el = $(`[data-pv="${x.id}"]`, box);
        el.dataset.originalBackground = url;
        el.style.backgroundImage = `url("${preview(url)}")`;
      }
    }
    const collect = () =>
      s.sections.map((x) => {
        const row = $(`[data-sec="${x.id}"]`, box);
        const inputs = $$("[data-tx]", row);
        const scene = $("[data-scene]", row);
        return { id: x.id, mode: $("[data-mode]", row)?.value || x.mode, texts: inputs.length ? x.texts.map((t, j) => ({ ...t, text: inputs[j].value })) : x.texts, ...(scene ? { scene: scene.value } : {}) };
      });
    const persist = async (list) => {
      await saveSuite({ sections: list || collect() });
      detailTab(box, current);
    };
    $$("[data-mode]", box).forEach((el) => (el.onchange = () => persist()));
    $(".sb-add", box)?.addEventListener("toggle", (e) => (addOpen = e.currentTarget.open));
    $$("[data-add]", box).forEach(
      (b) =>
        (b.onclick = () => {
          const have = s.sections.find((y) => y.type === "shot" && y.shot === b.dataset.add);
          if (have) return $("#sec-" + have.id, box)?.scrollIntoView({ block: "start", behavior: "smooth" });
          busy(b, async () => {
            await saveSuite({ sections: collect() });
            current = await api(`/suites/${s.id}/sections/shots`, json({ shots: [b.dataset.add] }));
            detailTab(box, current);
            toast("已放到详情页最后，用 ↑↓ 调位置");
            $("#sec-" + current.sections.find((y) => y.type === "shot" && y.shot === b.dataset.add)?.id)?.scrollIntoView({ block: "center" });
          });
        }),
    );
    $$("[data-remove]", box).forEach((b) => (b.onclick = () => busy(b, () => persist(collect().filter((x) => x.id !== b.dataset.remove)))));
    // Words and scene notes save quietly, so typing in the next box isn't interrupted.
    $$("[data-tx], [data-scene]", box).forEach((el) => (el.onchange = () => saveSuite({ sections: collect() }).then(() => toast("已保存。点这一屏的“重出这一屏”，图上的字才会变"), (e) => toast(e.message, true))));
    const move = (i, d) => {
      const list = collect();
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      persist(list);
    };
    $$("[data-up]", box).forEach((b) => (b.onclick = () => move(+b.dataset.up, -1)));
    $$("[data-down]", box).forEach((b) => (b.onclick = () => move(+b.dataset.down, 1)));
    $("#all-ai").onclick = () =>
      persist(collect().map((x) => {
        const sec = s.sections.find((y) => y.id === x.id);
        return x.mode !== "off" && meta.sections[sec.type].modes.includes("ai") ? { ...x, mode: "ai" } : x;
      }));
    $("#safe").onchange = (e) => ((safeMode = e.target.checked), detailTab(box, current));
    $("#plan-detail").onclick = (e) =>
      busy(e.currentTarget, async () => {
        await saveSuite({ sections: collect() });
        await api(`/suites/${s.id}/detail/plan`, json({}));
        suitePage(s.id);
      });
    $("#gen-detail")?.addEventListener("click", (e) =>
      busy(e.currentTarget, async () => {
        await saveSuite({ sections: collect() });
        await api(`/suites/${s.id}/detail/generate`, json({}, { "Idempotency-Key": key() }));
        await refresh();
        suitePage(s.id);
      }),
    );
    async function shoot(el) {
      // Export a full-resolution copy without changing the scrollable preview.
      const holder = el.closest(".dp").cloneNode(false);
      holder.classList.add("export-copy");
      holder.style.zoom = "1";
      const copy = el.cloneNode(true);
      for (const img of copy.querySelectorAll("img[data-original]")) {
        img.loading = "eager";
        img.src = img.dataset.original;
      }
      if (copy.dataset.originalBackground) copy.style.backgroundImage = `url("${copy.dataset.originalBackground}")`;
      holder.append(copy);
      document.body.append(holder);
      try {
        await Promise.all([...copy.querySelectorAll("img")].map(img => img.decode()));
        const { toPng } = await import("html-to-image"); // only needed when exporting
        return await toPng(copy, { pixelRatio: 1, filter: n => !n.classList?.contains("dp-dl") });
      } finally { holder.remove(); }
    }
    $$("[data-off]", box).forEach(
      (b) =>
        (b.onclick = () =>
          persist(collect().map((x) => (x.id === b.dataset.off ? { ...x, mode: "off" } : x)))),
    );
    const download = (url, name) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
    };
    $$("[data-dl]", box).forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            const el = $(`[data-pv="${b.dataset.dl}"]`, box);
            download(await shoot(el), `${s.profile.name || "详情"}-${b.dataset.dl}.png`);
          })),
    );
    $("#export").onclick = (e) =>
      busy(e.currentTarget, async () => {
        if ($$(".tp-wait", box).length) toast("还有 AI 屏没生成，导出的长图里会是空白占位", true);
        const parts = [];
        for (const el of $$(".dp-sec", box)) {
          const url = await shoot(el);
          const img = new Image();
          img.src = url;
          await img.decode();
          parts.push(img);
        }
        const width = 750;
        const heights = parts.map((im) => Math.round((im.naturalHeight * width) / im.naturalWidth));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = heights.reduce((a, b) => a + b, 0);
        if (canvas.height > 32000) throw new Error("长图太长，请减少几屏或分段导出");
        const g = canvas.getContext("2d");
        g.fillStyle = "#ffffff";
        g.fillRect(0, 0, canvas.width, canvas.height);
        let y = 0;
        parts.forEach((im, i) => {
          g.drawImage(im, 0, y, width, heights[i]);
          y += heights[i];
        });
        download(canvas.toDataURL("image/jpeg", 0.9), `${s.profile.name || "详情页"}-详情长图.jpg`);
      });
  }

  return { homePage, newPage, suitePage };
}
