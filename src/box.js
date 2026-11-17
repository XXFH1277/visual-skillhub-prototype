// 包装盒编辑器：左边刀版图，右边 3D 盒子（拖动旋转、滑块展开合上），下面是盒型、尺寸、各个面和食品标签。
import { BOX_TYPES, FACES, LABEL_FACE, boxParts, cutLines, faceSizes, flatNet, foldLines, partPolygon } from "../shared/boxes.js";
import { mountLabel } from "./label-ui.js";

const KRAFT = "#d9c3a0";
const loadImage = (src) =>
  new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error("图片加载失败"));
    img.src = src;
  });
const hex = (rgb) => "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const lum = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Average colour of a strip along one side of an image: what the neighbouring face continues from.
function edgeColor(img, side) {
  const c = document.createElement("canvas");
  c.width = 40;
  c.height = 40;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, 40, 40);
  const box = { left: [0, 0, 3, 40], right: [37, 0, 3, 40], top: [0, 0, 40, 3], bottom: [0, 37, 40, 3] }[side];
  const d = g.getImageData(...box).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
  return sum.map((v) => v / (d.length / 4));
}
function cover(g, img, x, y, w, h) {
  const r = Math.max(w / img.width, h / img.height);
  const sw = w / r, sh = h / r;
  g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}
function verticalText(g, text, cx, cy, size, color) {
  const chars = Array.from(text);
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${size}px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif`;
  const start = cy - ((chars.length - 1) * size * 1.1) / 2;
  chars.forEach((ch, i) => g.fillText(ch, cx, start + i * size * 1.1));
}

export function initBox(ctx) {
  const { app, api, json, toast, busy, esc, key, refresh, preview } = ctx;
  let b = null;
  let images = {}; // face → loaded <img> for the designed / uploaded / AI faces
  let labelImg = null;
  let edges = null;
  let progress = 1;
  let rx = -18, ry = -32;
  let showLabel = false;

  const present = () => faceSizes(b.type, b.size);
  const mainKey = () => BOX_TYPES[b.type].main;
  const base = () => (edges ? hex(edges.bottom) : b.palette?.[0] || "#1d3b5a");

  // One face as a canvas at `ppm` pixels per millimetre.
  function faceCanvas(face, ppm) {
    const size = present()[face];
    const w = Math.max(8, Math.round(size.w * ppm)), h = Math.max(8, Math.round(size.h * ppm));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    const img = images[face];
    const withLabel = face === LABEL_FACE[b.type] && b.labelOn && labelImg;
    // The label sits on a white panel, as large as the face allows (lower part when the face has its own design).
    const putLabel = (share) => {
      const pad = Math.min(w, h) * 0.08;
      const r = Math.min((w - pad * 2) / labelImg.width, (h * share - pad * 2) / labelImg.height);
      const lw = labelImg.width * r, lh = labelImg.height * r;
      const top = share < 1 ? h - pad - lh : (h - lh) / 2;
      g.fillStyle = "#ffffff";
      g.fillRect((w - lw) / 2 - pad * 0.3, top - pad * 0.3, lw + pad * 0.6, lh + pad * 0.6);
      g.drawImage(labelImg, (w - lw) / 2, top, lw, lh);
    };
    if (img) {
      cover(g, img, 0, 0, w, h);
      if (withLabel) putLabel(0.55);
      return c;
    }
    // Program layout: continue the main design's colours across the fold, typeset the words.
    const main = images[mainKey()];
    const side = { right: "right", left: "left", top: "top", bottom: "bottom", back: "right", front: "bottom" }[face];
    const col = edges ? edges[side] : rgbOf(base());
    const ink = lum(col) > 0.6 ? "#1f1f1f" : "#ffffff";
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, hex(col));
    grd.addColorStop(1, hex(col.map((v) => v * 0.82)));
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    const brand = b.brand || b.name || "";
    if (withLabel) {
      if (main && face === "back") {
        g.save();
        g.filter = "blur(14px) brightness(0.9)";
        cover(g, main, -20, -20, w + 40, h + 40);
        g.restore();
      }
      putLabel(1);
      return c;
    }
    if (face === "back" && main) {
      g.save();
      g.filter = "blur(10px) brightness(0.85)";
      cover(g, main, -20, -20, w + 40, h + 40);
      g.restore();
    }
    if (!brand) return c;
    if (h > w * 1.3) verticalText(g, brand.slice(0, 10), w / 2, h / 2, Math.min(w * 0.42, (h * 0.7) / Math.min(10, brand.length) / 1.1), ink);
    else {
      g.fillStyle = ink;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `800 ${Math.min(h * 0.34, (w * 0.8) / Math.max(2, Array.from(brand).length))}px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif`;
      g.fillText(brand, w / 2, h / 2);
    }
    return c;
  }

  /* ---------- dieline ---------- */
  function drawNet(canvas, ppm, { lines = true, dims = true } = {}) {
    const net = flatNet(b.type, b.size);
    const m = dims ? 26 : 6; // margin in mm for dimension lines
    canvas.width = Math.round((net.w + m * 2) * ppm);
    canvas.height = Math.round((net.h + m * 2) * ppm);
    const g = canvas.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.save();
    g.scale(ppm, ppm);
    g.translate(m, m);
    const faces = {};
    for (const p of net.parts) {
      const poly = partPolygon(p);
      g.save();
      g.beginPath();
      poly.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.clip();
      if (p.face) {
        faces[p.face] ||= faceCanvas(p.face, Math.min(ppm, 8));
        if (p.flip) {
          g.translate(p.x + p.w / 2, p.y + p.h / 2);
          g.rotate(Math.PI);
          g.drawImage(faces[p.face], -p.w / 2, -p.h / 2, p.w, p.h);
        } else g.drawImage(faces[p.face], p.x, p.y, p.w, p.h);
      } else {
        g.fillStyle = base();
        g.fillRect(p.x, p.y, p.w, p.h);
      }
      g.restore();
    }
    if (lines) {
      const lw = Math.max(0.25, 1.2 / ppm);
      g.lineWidth = lw;
      g.strokeStyle = "#e53935";
      g.setLineDash([]);
      for (const [a, c] of cutLines(net)) {
        g.beginPath();
        g.moveTo(...a);
        g.lineTo(...c);
        g.stroke();
      }
      g.strokeStyle = "#2e7d32";
      g.setLineDash([3, 2]);
      for (const [a, c] of foldLines(net)) {
        g.beginPath();
        g.moveTo(...a);
        g.lineTo(...c);
        g.stroke();
      }
      g.setLineDash([]);
      g.fillStyle = "#ffffffcc";
      g.font = `${Math.max(3, Math.min(6, b.size.w * 0.06))}px sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      for (const p of net.parts) if (p.label) g.fillText(p.label, p.x + p.w / 2, p.y + p.h / 2);
    }
    if (dims) {
      const f = Math.max(4, Math.min(9, net.w / 60));
      g.strokeStyle = g.fillStyle = "#1565c0";
      g.lineWidth = Math.max(0.25, 1 / ppm);
      g.font = `${f}px sans-serif`;
      g.textAlign = "center";
      const dim = (x1, y1, x2, y2, label, vertical) => {
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        g.save();
        g.translate((x1 + x2) / 2, (y1 + y2) / 2);
        if (vertical) g.rotate(-Math.PI / 2);
        g.fillText(label, 0, -2);
        g.restore();
      };
      for (const sheet of net.sheets) {
        const root = sheet.parts.find((p) => !p.parent);
        dim(root.x, -m * 0.4, root.x + root.w, -m * 0.4, `${Math.round(root.w)} mm`);
        dim(sheet.x - m * 0.4, root.y, sheet.x - m * 0.4, root.y + root.h, `${Math.round(root.h)} mm`, true);
        const side = sheet.parts.find((p) => p.parent === root.id && p.edge === "right");
        if (side) dim(side.x, -m * 0.4, side.x + side.w, -m * 0.4, `${Math.round(side.w)} mm`);
      }
      g.textAlign = "left";
      g.fillStyle = "#555";
      g.fillText(`${BOX_TYPES[b.type].name} · 成品 ${b.size.l}×${b.size.w}×${b.size.h} mm · 红色实线=裁切 绿色虚线=压痕 · 刀版以印刷厂为准`, 0, net.h + m * 0.62);
    }
    g.restore();
    return canvas;
  }

  /* ---------- 3D ---------- */
  let parts3d = [];
  function build3d(stage) {
    const world = stage.querySelector(".box-world");
    world.textContent = "";
    const all = boxParts(b.type, b.size);
    const maxDim = Math.max(b.size.l, b.size.w, b.size.h) * (b.type === "lid" ? 1.25 : 1);
    const s = (Math.min(stage.clientWidth, stage.clientHeight) * 0.5) / maxDim;
    const tex = {};
    for (const f of Object.keys(present())) tex[f] = faceCanvas(f, Math.min(4, 900 / Math.max(present()[f].w, present()[f].h))).toDataURL("image/jpeg", 0.88);
    const els = new Map();
    parts3d = [];
    for (const p of all) {
      const el = document.createElement("div");
      el.className = "part";
      el.style.width = p.w * s + "px";
      el.style.height = p.h * s + "px";
      const outside = document.createElement("i");
      outside.className = "skin out";
      if (p.face) outside.style.backgroundImage = `url(${tex[p.face]})`;
      else outside.style.background = base();
      if (p.flip) outside.style.transform = "rotate(180deg)";
      const inside = document.createElement("i");
      inside.className = "skin in";
      el.append(outside, inside);
      if (p.taper) {
        const poly = partPolygon({ ...p, x: 0, y: 0 }).map(([x, y]) => `${(x / p.w) * 100}% ${(y / p.h) * 100}%`).join(",");
        outside.style.clipPath = inside.style.clipPath = `polygon(${poly})`;
      }
      if (!p.parent) {
        el.style.left = (-p.w * s) / 2 + "px";
        el.style.top = (-p.h * s) / 2 + "px";
        world.append(el);
      } else {
        const q = els.get(p.parent);
        const pp = all.find((x) => x.id === p.parent);
        const off = (p.offset || 0) * s;
        if (p.edge === "right") Object.assign(el.style, { left: pp.w * s + "px", top: off + "px", transformOrigin: "0 50%" });
        if (p.edge === "left") Object.assign(el.style, { left: -p.w * s + "px", top: off + "px", transformOrigin: "100% 50%" });
        if (p.edge === "top") Object.assign(el.style, { top: -p.h * s + "px", left: off + "px", transformOrigin: "50% 100%" });
        if (p.edge === "bottom") Object.assign(el.style, { top: pp.h * s + "px", left: off + "px", transformOrigin: "50% 0" });
        q.append(el);
      }
      els.set(p.id, el);
      parts3d.push({ p, el, s });
    }
    pose();
  }
  function pose() {
    for (const { p, el, s } of parts3d) {
      const a = p.fold * progress;
      if (!p.parent) {
        if (p.net === "box") el.style.transform = `translateZ(${((b.size.w * s) / 2) * progress}px)`;
        if (p.net === "base") el.style.transform = `translateY(${(b.size.h * s) / 2}px) rotateX(-90deg)`;
        if (p.net === "lid") el.style.transform = `translateY(${-((b.size.h / 2) + 1 + (1 - progress) * b.size.h * 1.1) * s}px) rotateX(90deg)`;
        continue;
      }
      el.style.transform = { right: `rotateY(${a}deg)`, left: `rotateY(${-a}deg)`, top: `rotateX(${a}deg)`, bottom: `rotateX(${-a}deg)` }[p.edge];
    }
    const world = app.querySelector(".box-world");
    if (world) world.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
    const slider = app.querySelector("#fold");
    if (slider) slider.value = Math.round(progress * 100);
  }
  let anim = 0;
  function animateTo(target) {
    cancelAnimationFrame(anim);
    const from = progress, t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 1100);
      progress = from + (target - from) * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
      pose();
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  /* ---------- page ---------- */
  async function loadAssets() {
    images = {};
    await Promise.all(
      Object.entries(b.faces).map(async ([f, v]) => {
        if (v.url && present()[f]) images[f] = await loadImage(v.url).catch(() => null);
      }),
    );
    const main = images[mainKey()];
    edges = main ? { left: edgeColor(main, "left"), right: edgeColor(main, "right"), top: edgeColor(main, "top"), bottom: edgeColor(main, "bottom") } : null;
    labelImg = null;
    if (b.labelOn && present()[LABEL_FACE[b.type]] && b.label?.name) {
      const res = await fetch("/api/labels/png", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "SkillHub" }, body: JSON.stringify({ label: b.label }) }).catch(() => null);
      if (res?.ok) labelImg = await loadImage(URL.createObjectURL(await res.blob())).catch(() => null);
    }
  }
  const going = (f) => f.kind === "ai" && ["queued", "running"].includes(f.status);
  function faceRow(f) {
    const v = b.faces[f];
    const size = present()[f];
    const kind = f === mainKey() && v.url ? "设计稿" : v.kind === "ai" ? (going(v) ? "AI 正在画" : v.status === "succeeded" ? "AI 画的" : "AI 没画成") : v.kind === "upload" ? "自己上传" : f === LABEL_FACE[b.type] && b.labelOn ? "程序排 · 食品标签" : "程序排";
    return `<li class="face-row">
      <canvas data-thumb="${f}" width="64" height="64" aria-hidden="true"></canvas>
      <div><b>${FACES[f]}</b> <small class="muted">${Math.round(size.w)}×${Math.round(size.h)} mm</small><br><small class="${going(v) ? "working-text" : "muted"}">${kind}${v.kind === "ai" && v.status === "failed" ? "，积分已退" : ""}</small></div>
      <label class="btn small">上传替换<input type="file" accept="image/png,image/jpeg,image/webp" hidden data-up="${f}"></label>
      ${v.kind !== "auto" && f !== mainKey() ? `<button class="link" data-reset="${f}">改回程序排</button>` : ""}
    </li>`;
  }
  function render() {
    const faces = Object.keys(present());
    const aiFaces = faces.filter((f) => f !== mainKey() && ["back", "right", "top"].includes(f));
    const anyGoing = faces.some((f) => going(b.faces[f]));
    const cost = ctx.getWorkspace().skills.packaging?.cost || 10;
    app.innerHTML = `
      <a class="back" href="#/new/packaging">← 包装图</a>
      <div class="page-head"><div><h1>${esc(b.name || "包装盒")}</h1><p class="muted">刀版图 + 3D 盒子 · 拖动盒子旋转，拉滑块展开合上</p></div></div>
      <div class="box-layout">
        <section class="card box-net"><h2>刀版图</h2><div class="net-wrap"><canvas id="net"></canvas></div>
          <div class="row wrap"><button class="btn small primary" id="dl-net">下载刀版图（带裁切线和尺寸）</button><button class="btn small" id="dl-art">下载印刷图（不带线）</button></div></section>
        <section class="card box-3d"><div class="stage" id="stage"><div class="box-world"></div></div>
          <div class="fold-bar"><button class="btn small" id="unfold">展开</button><input type="range" id="fold" min="0" max="100" value="${Math.round(progress * 100)}" aria-label="展开或合上"><button class="btn small" id="close">合上</button></div></section>
      </div>
      <section class="card box-controls">
        <div class="box-type pills" role="group" aria-label="盒型">${Object.entries(BOX_TYPES).map(([k, t]) => `<button class="pill ${b.type === k ? "on" : ""}" data-type="${k}" title="${esc(t.hint)}">${t.name}</button>`).join("")}</div>
        <p class="muted">${esc(BOX_TYPES[b.type].hint)}</p>
        <div class="row dims"><label>长<input id="bx-l" inputmode="numeric" value="${b.size.l}"></label><span>×</span><label>宽<input id="bx-w" inputmode="numeric" value="${b.size.w}"></label><span>×</span><label>高<input id="bx-h" inputmode="numeric" value="${b.size.h}"></label><span class="muted">毫米（成品内尺寸）</span><button class="btn small" id="bx-size">改尺寸</button></div>
        <div class="row wrap"><label class="lbl-inline">品牌 / 店名<input id="bx-brand" maxlength="16" value="${esc(b.brand || "")}" placeholder="印在侧面和顶面"></label><button class="btn small" id="bx-brand-save">保存</button></div>
      </section>
      <section class="card"><div class="row spread"><h2>各个面</h2>${anyGoing ? `<span class="hint working"><span class="spin"></span>AI 正在画，好了会自动换上</span>` : ""}</div>
        <p class="muted">没单独设计的面由程序排：底色从正面的边上接过来，几个面是连着的；品牌名由程序排，不会错字。也可以让 AI 照着正面把其余几个面画出来，或者自己上传。</p>
        <ul class="face-list">${faces.map(faceRow).join("")}</ul>
        ${aiFaces.length ? `<button class="btn" id="ai-faces" ${anyGoing ? "disabled" : ""}>让 AI 照正面画其余 ${aiFaces.length} 个面 · ${aiFaces.length * cost} 积分</button>` : ""}
      </section>
      <section class="card"><div class="row spread"><h2>食品标签</h2><label class="switch"><input type="checkbox" id="label-on" ${b.labelOn ? "checked" : ""}> 印在${FACES[LABEL_FACE[b.type]]}</label></div>
        <p class="muted">品名、配料、营养成分表、生产商、条形码这些，字由程序排。也可以单独下载打印成不干胶。</p>
        <button class="btn small" id="label-edit">${showLabel ? "收起" : "填写 / 修改标签"}</button>
        <div id="label-box" ${showLabel ? "" : "hidden"}></div>
      </section>`;
    const stage = app.querySelector("#stage");
    requestAnimationFrame(() => {
      build3d(stage);
      drawNet(app.querySelector("#net"), Math.min(3, 900 / flatNet(b.type, b.size).w));
      app.querySelectorAll("[data-thumb]").forEach((c) => {
        const f = faceCanvas(c.dataset.thumb, 64 / Math.max(present()[c.dataset.thumb].w, present()[c.dataset.thumb].h));
        const g = c.getContext("2d");
        g.fillStyle = "#eef2f5";
        g.fillRect(0, 0, 64, 64);
        g.drawImage(f, (64 - f.width) / 2, (64 - f.height) / 2);
      });
    });
    bind(stage, aiFaces);
  }
  function bind(stage, aiFaces) {
    const $ = (s) => app.querySelector(s);
    let drag = null;
    stage.onpointerdown = (e) => {
      drag = { x: e.clientX, y: e.clientY, rx, ry };
      stage.setPointerCapture(e.pointerId);
    };
    stage.onpointermove = (e) => {
      if (!drag) return;
      ry = drag.ry + (e.clientX - drag.x) * 0.5;
      rx = Math.max(-80, Math.min(80, drag.rx - (e.clientY - drag.y) * 0.4));
      pose();
    };
    stage.onpointerup = stage.onpointercancel = () => (drag = null);
    $("#fold").oninput = (e) => ((progress = e.target.value / 100), pose());
    $("#unfold").onclick = () => animateTo(0);
    $("#close").onclick = () => animateTo(1);
    const update = async (body) => {
      b = await api("/boxes/" + b.id, json(body));
      await loadAssets();
      render();
    };
    app.querySelectorAll("[data-type]").forEach((x) => (x.onclick = () => busy(x, () => update({ type: x.dataset.type }))));
    $("#bx-size").onclick = (e) => busy(e.currentTarget, () => update({ size: { l: $("#bx-l").value, w: $("#bx-w").value, h: $("#bx-h").value } }));
    $("#bx-brand-save").onclick = (e) => busy(e.currentTarget, () => update({ brand: $("#bx-brand").value }));
    app.querySelectorAll("[data-reset]").forEach((x) => (x.onclick = () => busy(x, () => update({ reset: x.dataset.reset }))));
    app.querySelectorAll("[data-up]").forEach(
      (input) =>
        (input.onchange = () => {
          const file = input.files[0];
          if (!file) return;
          if (file.size > 10 * 1024 * 1024) return toast("图片不能超过 10MB", true);
          busy(input.parentElement, async () => {
            const form = new FormData();
            form.append("image", file);
            b = await api(`/boxes/${b.id}/faces/${input.dataset.up}`, { method: "POST", body: form });
            await loadAssets();
            render();
          });
        }),
    );
    $("#ai-faces")?.addEventListener("click", (e) =>
      busy(e.currentTarget, async () => {
        b = await api(`/boxes/${b.id}/ai-faces`, json({ faces: aiFaces }, { "Idempotency-Key": key() }));
        await refresh();
        render();
        poll();
      }),
    );
    $("#label-on").onchange = (e) => busy(e.target.parentElement, () => update({ labelOn: e.target.checked }));
    $("#label-edit").onclick = () => {
      showLabel = !showLabel;
      $("#label-box").hidden = !showLabel;
      $("#label-edit").textContent = showLabel ? "收起" : "填写 / 修改标签";
      if (showLabel && !$("#label-box").childElementCount)
        mountLabel($("#label-box"), { data: b.label, esc, busy, toast, title: "标签内容", onSave: (d) => update({ label: d }) });
    };
    if (showLabel) mountLabel($("#label-box"), { data: b.label, esc, busy, toast, title: "标签内容", onSave: (d) => update({ label: d }) });
    const download = (canvas, name) =>
      new Promise((ok) =>
        canvas.toBlob((blob) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = name;
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 3000);
          ok();
        }, "image/png"),
      );
    // Print size: up to 300 dpi, kept under ~12k pixels wide.
    const printPpm = () => Math.min(300 / 25.4, 12000 / (flatNet(b.type, b.size).w + 52));
    $("#dl-net").onclick = (e) => busy(e.currentTarget, () => download(drawNet(document.createElement("canvas"), printPpm()), `${b.name || "包装"}-刀版图.png`));
    $("#dl-art").onclick = (e) => busy(e.currentTarget, () => download(drawNet(document.createElement("canvas"), printPpm(), { lines: false, dims: false }), `${b.name || "包装"}-印刷图.png`));
  }
  let timer = 0;
  function poll() {
    clearTimeout(timer);
    const id = b.id;
    timer = setTimeout(async () => {
      if (!location.hash.startsWith("#/box/" + id)) return;
      const next = await api("/boxes/" + id).catch(() => null);
      if (!next) return;
      const was = JSON.stringify(b.faces);
      b = next;
      if (JSON.stringify(b.faces) !== was && !document.activeElement?.matches?.("#label-box input, #label-box textarea")) {
        await loadAssets();
        render();
      }
      if (Object.values(b.faces).some(going)) poll();
    }, 4000);
  }

  async function boxPage(id) {
    b = await api("/boxes/" + id);
    progress = 1;
    showLabel = false;
    await loadAssets();
    if (!location.hash.startsWith("#/box/" + id)) return;
    render();
    if (Object.values(b.faces).some(going)) poll();
    return () => clearTimeout(timer);
  }
  // Start (or reopen) the box for one finished design and go there.
  async function openBox(body, button) {
    await busy(button, async () => {
      const box = await api("/boxes", json(body));
      location.hash = "#/box/" + box.id;
    });
  }
  return { boxPage, openBox };
}
