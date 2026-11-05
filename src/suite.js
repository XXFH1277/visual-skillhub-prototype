import { toPng } from "html-to-image";

// 商品全套：资料 → 档案 → 笔记 → 商品图 → 详情页
export function initSuite(ctx) {
  const { app, api, json, toast, busy, esc, $, $$, key, refresh, getWorkspace, setCleanup, tweak } = ctx;
  let meta = null;
  const loadMeta = async () => (meta ||= await api("/suite-meta"));
  const photoUrl = (s, file) => `/api/suites/${s.id}/photo/${encodeURIComponent(file)}`;
  const fileUrl = (job, name, dl = false) => `/api/jobs/${job.id}/files/${encodeURIComponent(name)}?v=${encodeURIComponent(job.updatedAt)}${dl ? "&download=1" : ""}`;
  const busyTask = (s, name) => s.tasks?.[name]?.status === "running";
  const anyBusy = (s) => Object.values(s.tasks || {}).some((t) => t.status === "running");
  const nl = (t) => esc(t).replace(/\n/g, "<br>");

  /* ---------------- home: my products ---------------- */
  async function homePage() {
    const { suites } = await api("/suites");
    app.innerHTML = `
      <section class="suite-hero card">
        <div><h1>一个商品，一键出全套</h1><p class="muted">传实拍图和笔记（没有笔记也行），AI 帮你出：私域笔记（可复制 / Word）、商品图、淘宝详情页。</p></div>
        <a class="btn primary big" href="#/suite/new">＋ 新建商品</a>
      </section>
      <div class="page-head"><h2>我的商品</h2><span class="muted"><a class="link" href="#/new/product">单张出图</a> · <a class="link" href="#/styles">风格库</a></span></div>
      ${
        suites.length
          ? `<div class="task-grid">${suites
              .map(
                (s) => `<a class="task card" href="#/suite/${s.id}"><div class="task-thumb">${s.cover ? `<img src="/api/suites/${s.id}/photo/${encodeURIComponent(s.cover)}" alt="" loading="lazy">` : ""}</div>
                <div class="task-meta"><b>${esc(s.name)}</b><span class="muted">${new Date(s.updatedAt).toLocaleString("zh-CN", { hour12: false })}</span>${Object.values(s.tasks || {}).some((t) => t.status === "running") ? `<span class="status running">AI 处理中</span>` : ""}</div></a>`,
              )
              .join("")}</div>`
          : `<section class="card empty"><h2>还没有商品</h2><p class="muted">从“新建商品”开始，3 步出全套。</p></section>`
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
  const tabs = { profile: "1 商品档案", note: "2 笔记", shots: "3 商品图", detail: "4 详情页" };
  let tab = "profile";
  let current = null;
  async function suitePage(id, sub) {
    await loadMeta();
    if (sub && tabs[sub]) tab = sub;
    const s = await api("/suites/" + id);
    current = s;
    render(s);
    if (anyBusy(s) || ["queued", "running"].includes(s.jobs?.shots?.status) || ["queued", "running"].includes(s.jobs?.detail?.status)) {
      const t = setTimeout(async () => {
        if (location.hash.startsWith("#/suite/" + id)) suitePage(id);
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
      <nav class="tabs">${Object.entries(tabs).map(([k, v]) => `<button class="${tab === k ? "on" : ""}" data-tab="${k}" ${!p && k !== "profile" ? "disabled" : ""}>${v}</button>`).join("")}</nav>
      <div id="tab"></div>`;
    $$("[data-tab]").forEach((b) => (b.onclick = () => ((tab = b.dataset.tab), render(current))));
    $("#del-suite").onclick = (e) =>
      busy(e.currentTarget, async () => {
        if (!confirmDelete()) return;
        await api("/suites/" + s.id, { method: "DELETE" });
        location.hash = "#/";
      });
    const box = $("#tab");
    if (!p) return profileWaiting(box, s);
    ({ profile: profileTab, note: noteTab, shots: shotsTab, detail: detailTab })[tab](box, s);
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
            (ph) => `<figure class="${ph.usable ? "" : "dim"}"><img src="${photoUrl(s, ph.file)}" alt="" loading="lazy">
              <select data-role="${esc(ph.file)}">${Object.entries(meta.roles).map(([k, v]) => `<option value="${k}" ${ph.role === k ? "selected" : ""}>${v}</option>`).join("")}</select>
              <label class="mini"><input type="checkbox" data-usable="${esc(ph.file)}" ${ph.usable ? "checked" : ""}>用于出图</label></figure>`,
          )
          .join("")}</div>
        <label class="btn small"><input type="file" id="more-photos" accept="image/*" multiple hidden>＋ 补充图片</label>
      </section>
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
      <div class="row"><button class="btn primary" id="to-shots">下一步：商品图 →</button></div>`;
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
    $("#to-shots").onclick = () => ((tab = "shots"), render(current));
  }

  /* ---- tab 3: product images ---- */
  function checklist(s) {
    const c = meta.cases.find((x) => x.id === s.caseId);
    const have = new Set(s.photos.filter((p) => p.usable).map((p) => p.role));
    return `<ul class="checklist">${c.photoChecklist.map((x) => `<li class="${have.has(x.role) ? "ok" : ""}">${have.has(x.role) ? "✓" : "○"} ${esc(x.need)}</li>`).join("")}</ul>`;
  }
  function jobResults(job, framesById) {
    if (!job) return "";
    if (["queued", "running"].includes(job.status)) return spinner(job.phase || "生成中", "一张图 1–3 分钟，可以先离开，稍后回来看");
    if (job.status !== "succeeded") return `<section class="card warn"><b>没有成功</b><p>${esc(job.error || "")}</p></section>`;
    const imgs = job.manifest.assets.filter((a) => ["image", "module"].includes(a.role));
    return `<div class="results">${imgs
      .map((a, i) => {
        const check = job.manifest.textCheck?.find((c) => c.frame === i);
        // The newest finished fine-tune of this picture stands in for it.
        const latest = job.tweaks?.find((t) => t.frame === i && t.status === "succeeded" && t.asset);
        const pending = job.tweaks?.find((t) => t.frame === i && ["queued", "running"].includes(t.status));
        const src = latest ? `/api/jobs/${latest.id}/files/${encodeURIComponent(latest.asset)}` : fileUrl(job, a.name);
        const count = job.tweaks?.filter((t) => t.frame === i && t.status === "succeeded").length || 0;
        return `<article class="card result"><a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt=""></a>
          <div class="result-bar"><b>${esc(job.frames?.[i]?.title || framesById?.[i] || "")}</b>${latest ? `<a class="badge" href="#/job/${latest.id}">已微调 ${count} 次</a>` : check ? (check.ok ? `<span class="badge ok">✓ 文字已校对</span>` : check.ok === false ? `<span class="badge bad">⚠ 文字可能有误</span>` : "") : ""}</div>
          ${pending ? `<p class="hint"><a href="#/job/${pending.id}">正在微调…</a></p>` : ""}
          <div class="row"><a class="btn small" href="${latest ? src + "?download=1" : fileUrl(job, a.name, true)}">下载</a><button class="btn small primary-soft" data-tweak="${latest ? `${latest.id}:0` : `${job.id}:${i}`}">微调</button><button class="btn small" data-redo="${job.id}:${i}">重出这张</button></div></article>`;
      })
      .join("")}</div>`;
  }
  function bindRedo(box) {
    $$("[data-tweak]", box).forEach((b) => (b.onclick = () => busy(b, () => tweak(...b.dataset.tweak.split(":").map((x, j) => (j ? Number(x) : x))))));
    $$("[data-redo]", box).forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            const [jobId, i] = b.dataset.redo.split(":");
            const next = await api(`/jobs/${jobId}/retry`, json({ frame: Number(i) }, { "Idempotency-Key": key() }));
            await refresh();
            location.hash = "#/job/" + next.id;
          })),
    );
  }
  function shotsTab(box, s) {
    const ws = getWorkspace();
    const cost = ws.skills.product.cost;
    const shots = s.shots;
    box.innerHTML = `
      ${busyTask(s, "shots") ? spinner("AI 正在规划商品图", "给每张图挑实拍图、写标题和画面（约 1 分钟）") : ""}${failed(s, "shots")}
      <section class="card"><h2>需要的实拍图</h2>${checklist(s)}<p class="muted">缺的那几张图会自动跳过；补拍后在“商品档案”里上传。</p></section>
      ${
        !shots
          ? `<div class="row"><button class="btn primary" id="plan-shots" ${busyTask(s, "shots") ? "disabled" : ""}>AI 规划商品图 →</button><span class="muted">不扣积分</span></div>`
          : `<div class="frames">${shots
              .map(
                (x) => `<article class="card frame ${x.enabled ? "" : "dim"}" data-shot="${x.id}">
                  <header><b>${esc(x.title)}</b><label class="mini"><input type="checkbox" data-en ${x.enabled ? "checked" : ""} ${x.photos.length ? "" : "disabled"}>出这张</label></header>
                  ${x.missing ? `<p class="hint">${esc(x.missing)}</p>` : ""}
                  <div class="ref-row">${x.photos.map((f) => `<div class="ref"><img src="${photoUrl(s, f)}" alt=""></div>`).join("")}</div>
                  ${x.texts.map((t, j) => `<input data-t="${j}" value="${esc(t.text)}" aria-label="${t.role}">`).join("")}
                  <details class="scene-desc"><summary>画面描述</summary><textarea data-scene rows="4">${esc(x.scene)}</textarea></details>
                </article>`,
              )
              .join("")}</div>
            <div class="actionbar"><div class="actionbar-in"><span class="muted">图上的字改好再出；出图后可单张重出</span>
              <div class="row"><button class="link" id="replan-shots">重新规划</button><button class="btn primary" id="gen-shots">生成 ${shots.filter((x) => x.enabled).length} 张 · ${shots.filter((x) => x.enabled).length * cost} 积分</button></div></div></div>`
      }
      ${jobResults(s.jobs?.shots)}
      ${s.jobs?.shots?.status === "succeeded" ? `<div class="row"><button class="btn primary" id="to-detail">下一步：详情页 →</button></div>` : ""}`;
    const collect = () =>
      shots.map((x) => {
        const card = $(`[data-shot="${x.id}"]`, box);
        return { id: x.id, enabled: $("[data-en]", card).checked, scene: $("[data-scene]", card).value, texts: x.texts.map((t, j) => ({ role: t.role, text: $(`[data-t="${j}"]`, card).value })) };
      });
    $("#plan-shots")?.addEventListener("click", (e) => busy(e.currentTarget, async () => (await api(`/suites/${s.id}/shots/plan`, json({})), suitePage(s.id))));
    $("#replan-shots")?.addEventListener("click", (e) => busy(e.currentTarget, async () => (await api(`/suites/${s.id}/shots/plan`, json({})), suitePage(s.id))));
    $("#gen-shots")?.addEventListener("click", (e) =>
      busy(e.currentTarget, async () => {
        await saveSuite({ shots: collect() });
        await api(`/suites/${s.id}/shots/generate`, json({}, { "Idempotency-Key": key() }));
        await refresh();
        suitePage(s.id);
      }),
    );
    $("#to-detail")?.addEventListener("click", () => ((tab = "detail"), render(current)));
    bindRedo(box);
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
      ${v.cards.length ? `<div class="tp-cards">${v.cards.map((c) => `<div><strong>${esc(c.big)}</strong><b>${esc(c.label)}</b><small>${esc(c.sub)}</small></div>`).join("")}</div>` : ""}
      ${v.body ? `<p class="tp-body">${hi(v.body, v.highlight)}</p>` : ""}`;
  }
  function sectionHtml(s, sec, safe) {
    const p = s.profile;
    const t = (x) => (safe ? safeText(x) : x);
    if (sec.mode === "ai") {
      const url = aiImage(s, sec);
      return url ? `<img class="tp-img" src="${url}" alt="">` : `<div class="tp-wait">${esc(meta.sections[sec.type].name)}<small>AI 出图后显示在这里</small></div>`;
    }
    if (sec.mode === "photo") {
      const f = sec.photos[0] || s.photos.find((ph) => ph.usable && meta.sections[sec.type].photo.includes(ph.role))?.file;
      return `${f ? `<img class="tp-img" src="${photoUrl(s, f)}" alt="">` : ""}<div class="tp-caption">${esc(meta.sections[sec.type].name)}</div>`;
    }
    const tpl = {
      why: () => cardsTpl({ ...p.why, headline: t(p.why.headline), body: t(p.why.body) }),
      faq: () => cardsTpl({ ...p.faq, headline: t(p.faq.headline), body: t(p.faq.body) }),
      compare: () => {
        const c = p.compare;
        const pics = s.photos.filter((ph) => ph.usable && ph.role === "compare").slice(0, 2);
        return `<div class="tp-kicker">看得见的差别</div><h3 class="tp-head">${esc(t(c.headline) || `${c.ours} vs ${c.others}`)}</h3>
          ${pics.length ? `<div class="tp-pics">${pics.map((ph) => `<img src="${photoUrl(s, ph.file)}" alt="">`).join("")}</div>` : ""}
          <table class="tp-table"><tr><th></th><th class="ours">${esc(c.ours)}</th><th>${esc(c.others)}</th></tr>${c.rows.map((r) => `<tr><td>${esc(r.aspect)}</td><td class="ours">${esc(t(r.ours))}</td><td>${esc(r.others)}</td></tr>`).join("")}</table>
          ${c.note ? `<p class="tp-body">${esc(t(c.note))}</p>` : ""}`;
      },
      pick: () => `<div class="tp-kicker">买之前看一眼</div><h3 class="tp-head">${esc(t(p.pick.headline) || "怎么挑")}</h3>
        <ol class="tp-points">${p.pick.points.map((x, i) => `<li><span>${String(i + 1).padStart(2, "0")}</span><div><b>${esc(t(x.title))}</b><p>${esc(t(x.detail))}</p></div></li>`).join("")}</ol>`,
      material: () => `<h3 class="tp-head">${esc(p.sellingPoints[0]?.title || "选材")}</h3><ol class="tp-points">${p.sellingPoints.map((x, i) => `<li><span>${String(i + 1).padStart(2, "0")}</span><div><b>${esc(t(x.title))}</b><p>${esc(t(x.detail))}</p></div></li>`).join("")}</ol>`,
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
  function detailTab(box, s) {
    const ws = getWorkspace();
    const cost = ws.skills.detail.cost;
    const pal = s.profile.palette?.length ? s.profile.palette : ["#1d3557", "#e8541e", "#f6efe6"];
    const ai = s.sections.filter((x) => x.mode === "ai");
    const planned = ai.length && ai.every((x) => x.scene);
    const job = s.jobs?.detail;
    box.innerHTML = `
      ${busyTask(s, "detail") ? spinner("AI 正在规划详情页画面", "约 1 分钟") : ""}${failed(s, "detail")}
      <div class="detail-builder">
        <section class="card sections">
          <h2>详情页结构</h2><p class="muted">每一屏都能选“AI 出图 / 文字排版 / 实拍+说明 / 不要”，用箭头调顺序。文字排版那几屏的内容来自“商品档案”，改字免费。</p>
          ${s.sections
            .map(
              (x, i) => `<div class="sec-row ${x.mode === "off" ? "dim" : ""}" data-sec="${x.id}">
                <div class="sec-move"><button class="x" data-up="${i}" aria-label="上移">↑</button><button class="x" data-down="${i}" aria-label="下移">↓</button></div>
                <b>${esc(meta.sections[x.type].name)}</b>
                <select data-mode>${[...meta.sections[x.type].modes, "off"].map((m) => `<option value="${m}" ${x.mode === m ? "selected" : ""}>${meta.modes[m]}</option>`).join("")}</select>
                ${x.mode === "ai" && x.texts?.length ? `<input data-head value="${esc(x.texts[0].text)}" aria-label="标题">` : ""}
              </div>`,
            )
            .join("")}
          <label class="mini"><input type="checkbox" id="safe" ${safeMode ? "checked" : ""}>淘宝合规（自动替换“最、第一、没有之一”等）</label>
          <div class="row wrap">
            <button class="btn" id="plan-detail">${planned ? "重新规划 AI 画面" : "AI 规划画面"}（免费）</button>
            ${planned ? `<button class="btn primary" id="gen-detail">生成 ${ai.length} 屏 AI 图 · ${ai.length * cost} 积分</button>` : ""}
          </div>
          ${job && ["queued", "running"].includes(job.status) ? spinner(job.phase || "生成中", `共 ${job.frames?.length || ai.length} 屏，约 ${ai.length * 2} 分钟`) : ""}
          ${job?.status === "failed" ? `<p class="warn-text">${esc(job.error)}</p>` : ""}
          <button class="btn primary wide" id="export">导出详情长图（750 宽）</button>
          <p class="muted">也可以单独导出每一屏：点预览里那一屏右上角的“↓”。</p>
        </section>
        <section class="preview-col"><div class="dp" id="dp">${s.sections
          .filter((x) => x.mode !== "off")
          .map((x) => `<div class="dp-sec ${x.mode === "tpl" ? "tpl" : ""}" data-pv="${x.id}">${sectionHtml(s, x, safeMode)}<button class="dp-dl" data-dl="${x.id}" title="导出这一屏">↓</button></div>`)
          .join("")}</div></section>
      </div>`;
    const dp = $("#dp");
    dp.style.setProperty("--c1", pal[0]);
    dp.style.setProperty("--c2", pal[1] || pal[0]);
    dp.style.setProperty("--c3", pal[2] || "#f6efe6");
    const collect = () =>
      s.sections.map((x) => {
        const row = $(`[data-sec="${x.id}"]`, box);
        const head = $("[data-head]", row);
        return { id: x.id, mode: $("[data-mode]", row).value, texts: head ? [{ ...x.texts[0], text: head.value }, ...x.texts.slice(1)] : x.texts };
      });
    const persist = async (list) => {
      await saveSuite({ sections: list || collect() });
      detailTab(box, current);
    };
    $$("[data-mode]", box).forEach((el) => (el.onchange = () => persist()));
    $$("[data-head]", box).forEach((el) => (el.onchange = () => persist()));
    const move = (i, d) => {
      const list = collect();
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      persist(list);
    };
    $$("[data-up]", box).forEach((b) => (b.onclick = () => move(+b.dataset.up, -1)));
    $$("[data-down]", box).forEach((b) => (b.onclick = () => move(+b.dataset.down, 1)));
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
    const shoot = (el) => toPng(el, { pixelRatio: 1, cacheBust: true, filter: (n) => !n.classList?.contains("dp-dl") });
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
        if ($$(".tp-wait", dp).length) toast("还有 AI 屏没生成，导出的长图里会是空白占位", true);
        const parts = [];
        for (const el of $$(".dp-sec", dp)) {
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
