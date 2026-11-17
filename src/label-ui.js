// 食品标签编辑器：左边填，右边实时看；字全部由程序排，下载 300dpi 打印图。
import { LABEL_FIELDS, LABEL_SIZES, NUTRIENTS, cleanLabel, labelSvg, nrv } from "../shared/label.js";

const svgUrl = (svg) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
export const labelPreviewUrl = (data) => svgUrl(labelSvg(data).svg);

const LONG = new Set(["ingredients", "usage", "allergen", "address", "distributor"]);
const HINTS = {
  name: "如 小鱼印象 · 香辣小鱼干",
  ingredients: "按用量从多到少，如 鳀鱼、白砂糖、食用盐…",
  category: "如 熟制动物性水产制品",
  standard: "如 SB/T 10673",
  license: "SC 开头的 14 位",
  storage: "如 常温避光保存，开封后冷藏",
  shelfLife: "如 12个月",
};

// `onSave(data)` persists; without it the editor keeps its data where the caller tells it to.
export function mountLabel(box, { data, onSave, onChange, esc, busy, toast, title = "食品标签", note = "" }) {
  let d = cleanLabel(data || {});
  const field = ([k, n, max]) =>
    LONG.has(k)
      ? `<label class="lbl-f wide">${n}<textarea data-k="${k}" maxlength="${max}" rows="2" placeholder="${esc(HINTS[k] || "")}">${esc(d[k])}</textarea></label>`
      : `<label class="lbl-f">${n}<input data-k="${k}" maxlength="${max}" value="${esc(d[k])}" placeholder="${esc(HINTS[k] || "")}"></label>`;
  box.innerHTML = `<div class="label-editor">
    <section class="card label-form">
      <div class="row spread"><h2>${esc(title)}</h2><span class="muted">字由程序排，不会错字</span></div>
      ${note ? `<p class="muted">${note}</p>` : ""}
      <div class="lbl-grid">
        ${field(LABEL_FIELDS[0])}
        <label class="lbl-f">净含量<input data-k="net" maxlength="20" value="${esc(d.net)}" placeholder="如 200克、2.5kg"></label>
        <label class="lbl-f">生产日期<input data-k="date" maxlength="30" value="${esc(d.date)}" placeholder="可留空，印好后再打码"></label>
        <label class="lbl-f">条形码<input data-k="barcode" inputmode="numeric" maxlength="13" value="${esc(d.barcode)}" placeholder="13 位，或前 12 位"></label>
        ${LABEL_FIELDS.slice(1).map(field).join("")}
      </div>
      <h3 class="lbl-h">营养成分表 <small class="muted">只填含量，NRV% 自动算</small></h3>
      <div class="lbl-nutri">
        <label class="lbl-f">每<input data-k="per" maxlength="12" value="${esc(d.per)}"></label>
        ${NUTRIENTS.map(([k, n, u]) => `<label class="lbl-f">${n}（${u}）<input data-n="${k}" inputmode="decimal" maxlength="10" value="${esc(d.nutrition[k])}"><small class="muted" data-nrv="${k}">${nrv(k, d.nutrition[k])}</small></label>`).join("")}
      </div>
      <h3 class="lbl-h">尺寸与颜色</h3>
      <div class="pills" role="group" aria-label="标签尺寸">${Object.entries(LABEL_SIZES).map(([k, s]) => `<button class="pill ${d.size === k ? "on" : ""}" data-size="${k}">${s.name} mm</button>`).join("")}</div>
      <label class="lbl-f color">文字颜色<input type="color" data-k="color" value="${esc(d.color)}"></label>
    </section>
    <section class="card label-view">
      <img id="lbl-img" alt="标签预览">
      <div id="lbl-problems"></div>
      <div class="row wrap">${onSave ? `<button class="btn" id="lbl-save">保存</button>` : ""}<button class="btn primary" id="lbl-png">下载打印图（300dpi）</button></div>
      <p class="muted">按 GB 7718 的要求自动调字号：正文不小于 1.8 毫米，净含量的字高按净含量大小来。最终印刷请以当地市场监管要求为准。</p>
    </section></div>`;
  const $ = (s) => box.querySelector(s);
  const draw = () => {
    const r = labelSvg(d);
    $("#lbl-img").src = svgUrl(r.svg);
    $("#lbl-img").className = LABEL_SIZES[d.size].h > LABEL_SIZES[d.size].w ? "tall" : "";
    $("#lbl-problems").innerHTML = r.problems.length
      ? `<ul class="lbl-problems">${r.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
      : `<p class="ok-text">必填项齐了，正文字号 ${r.fontMm} 毫米</p>`;
    onChange?.(d);
  };
  let t;
  const later = () => (clearTimeout(t), (t = setTimeout(draw, 150)));
  box.querySelectorAll("[data-k]").forEach((el) =>
    el.addEventListener("input", () => {
      d = cleanLabel({ ...d, [el.dataset.k]: el.value });
      later();
    }),
  );
  box.querySelectorAll("[data-n]").forEach((el) =>
    el.addEventListener("input", () => {
      d = cleanLabel({ ...d, nutrition: { ...d.nutrition, [el.dataset.n]: el.value } });
      box.querySelector(`[data-nrv="${el.dataset.n}"]`).textContent = nrv(el.dataset.n, el.value);
      later();
    }),
  );
  box.querySelectorAll("[data-size]").forEach(
    (b) =>
      (b.onclick = () => {
        d = cleanLabel({ ...d, size: b.dataset.size });
        box.querySelectorAll("[data-size]").forEach((x) => x.classList.toggle("on", x === b));
        draw();
      }),
  );
  $("#lbl-save")?.addEventListener("click", (e) => busy(e.currentTarget, async () => (await onSave(d), toast("标签已保存"))));
  $("#lbl-png").onclick = (e) =>
    busy(e.currentTarget, async () => {
      const res = await fetch("/api/labels/png", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "SkillHub" }, body: JSON.stringify({ label: d }) });
      if (!res.ok) throw new Error("没能生成打印图，请重试");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${d.name || "标签"}-${d.size}.png`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  draw();
  return { get: () => d };
}
