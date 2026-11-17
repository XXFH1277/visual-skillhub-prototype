// 食品标签（预包装食品的不干胶标签）：字全部由程序排，一个字都不让 AI 画。
// Shared by browser (live preview) and server (print PNG). Units are millimetres.

export const LABEL_FIELDS = [
  ["name", "产品名称", 30],
  ["ingredients", "配料", 300],
  ["category", "产品类别", 40],
  ["spec", "规格", 40],
  ["origin", "产地", 40],
  ["standard", "执行标准", 60],
  ["license", "生产许可证编号", 40],
  ["storage", "贮存条件", 80],
  ["shelfLife", "保质期", 40],
  ["usage", "食用方法", 120],
  ["allergen", "致敏物质提示", 120],
  ["maker", "生产商", 60],
  ["address", "地址", 100],
  ["phone", "电话", 30],
  ["distributor", "经销商", 80],
];
export const LABEL_SIZES = {
  "100x70": { w: 100, h: 70, name: "横版 100×70" },
  "120x80": { w: 120, h: 80, name: "横版 120×80" },
  "80x120": { w: 80, h: 120, name: "竖版 80×120" },
  "70x100": { w: 70, h: 100, name: "竖版 70×100" },
  "90x90": { w: 90, h: 90, name: "方形 90×90" },
};
// 营养成分表的“4+1”：能量和四种核心营养素，NRV 按 GB 28050。
export const NUTRIENTS = [
  ["energy", "能量", "kJ", 8400],
  ["protein", "蛋白质", "g", 60],
  ["fat", "脂肪", "g", 60],
  ["carb", "碳水化合物", "g", 300],
  ["sodium", "钠", "mg", 2000],
];

const str = (v, max) => (typeof v === "string" ? Array.from(v.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim()).slice(0, max).join("") : "");
export function cleanLabel(raw = {}) {
  const out = {};
  for (const [k, , max] of LABEL_FIELDS) out[k] = str(raw[k], max);
  out.net = str(raw.net, 20);
  out.date = str(raw.date, 30);
  out.barcode = String(raw.barcode || "").replace(/\D/g, "").slice(0, 13);
  out.per = str(raw.per, 12) || "每100克";
  out.nutrition = Object.fromEntries(NUTRIENTS.map(([k]) => [k, str(raw.nutrition?.[k], 10)]));
  out.size = LABEL_SIZES[raw.size] ? raw.size : "100x70";
  out.color = /^#[0-9a-f]{6}$/i.test(raw.color || "") ? raw.color : "#111111";
  out.extra = (Array.isArray(raw.extra) ? raw.extra : [])
    .filter((r) => Array.isArray(r) && str(r[0], 12) && str(r[1], 120))
    .slice(0, 6)
    .map((r) => [str(r[0], 12), str(r[1], 120)]);
  return out;
}

// NRV%：GB 28050 修约到整数；含量写的不是数字就不算。
export function nrv(key, value) {
  const n = NUTRIENTS.find((x) => x[0] === key);
  const digits = String(value).replace(/[^\d.]/g, "");
  const v = Number(digits);
  if (!n || !/\d/.test(digits) || !Number.isFinite(v)) return "";
  return `${Math.round((v / n[3]) * 100)}%`;
}

// GB 7718：净含量的字高按净含量大小来。
export function netHeight(net) {
  const m = String(net).match(/([\d.]+)\s*(kg|千克|公斤|g|克|ml|毫升|l|升)/i);
  if (!m) return 4;
  let v = Number(m[1]);
  if (/kg|千克|公斤|^l$|升/i.test(m[2]) && !/毫升|ml/i.test(m[2])) v *= 1000;
  return v <= 50 ? 2 : v <= 200 ? 3 : v <= 1000 ? 4 : 6;
}

/* ---------- EAN-13 ---------- */
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const R = L.map((p) => [...p].map((b) => (b === "1" ? "0" : "1")).join(""));
const G = R.map((p) => [...p].reverse().join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];
export function eanCheck(d12) {
  const s = [...d12].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
  return String((10 - (s % 10)) % 10);
}
// 12 digits → adds the check digit; 13 digits → must carry the right one.
export function ean13(code) {
  const d = String(code || "").replace(/\D/g, "");
  if (d.length === 12) return d + eanCheck(d);
  if (d.length === 13 && eanCheck(d.slice(0, 12)) === d[12]) return d;
  return null;
}
export function eanBits(code) {
  const d = ean13(code);
  if (!d) return null;
  const p = PARITY[Number(d[0])];
  let bits = "101";
  for (let i = 1; i <= 6; i++) bits += (p[i - 1] === "L" ? L : G)[Number(d[i])];
  bits += "01010";
  for (let i = 7; i <= 12; i++) bits += R[Number(d[i])];
  return bits + "101";
}

/* ---------- layout ---------- */
const FONT = "PingFang SC, Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, sans-serif";
const xml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
// Width in em: CJK and full-width 1, the rest about half.
const em = (ch) => (/[⺀-￯]/.test(ch) ? 1 : /[A-Z0-9%]/.test(ch) ? 0.62 : 0.52);
function wrap(text, width, f, indent = 0) {
  const lines = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    let w = indent;
    for (const ch of para) {
      const cw = em(ch) * f;
      if (w + cw > width && line) {
        lines.push(line);
        line = "";
        w = 0;
      }
      line += ch;
      w += cw;
    }
    lines.push(line);
    indent = 0;
  }
  return lines;
}
const textWidth = (s, f) => [...String(s)].reduce((a, c) => a + em(c) * f, 0);

function infoRows(d) {
  const rows = LABEL_FIELDS.filter(([k]) => k !== "name" && d[k]).map(([k, n]) => [n, d[k]]);
  return [...rows, ...d.extra];
}

// Paragraphs "键：值" stacked in a column; returns svg parts and the height used.
function column(rows, x, y, width, f, ink) {
  const out = [];
  const lh = f * 1.32;
  let cy = y;
  for (const [k, v] of rows) {
    const key = `${k}：`;
    const lines = wrap(v, width, f, textWidth(key, f));
    lines.forEach((t, i) => {
      cy += lh;
      out.push(
        i === 0
          ? `<text x="${x}" y="${cy.toFixed(2)}" font-size="${f}" fill="${ink}"><tspan font-weight="700">${xml(key)}</tspan>${xml(t)}</text>`
          : `<text x="${x}" y="${cy.toFixed(2)}" font-size="${f}" fill="${ink}">${xml(t)}</text>`,
      );
    });
    cy += f * 0.22;
  }
  return { out, height: cy - y };
}

function nutritionTable(d, x, y, width, f, ink) {
  const rows = NUTRIENTS.filter(([k]) => d.nutrition[k]);
  if (!rows.length) return { out: [], height: 0 };
  const rh = f * 1.55;
  const cols = [0.42, 0.33, 0.25].map((c) => c * width);
  const out = [`<text x="${x + width / 2}" y="${y + f * 1.25}" font-size="${f * 1.1}" font-weight="700" fill="${ink}" text-anchor="middle">营养成分表</text>`];
  let cy = y + f * 1.7;
  const head = ["项目", d.per, "NRV%"];
  const all = [head, ...rows.map(([k, n, u]) => [n, `${d.nutrition[k]}${/[a-zA-Z]/.test(d.nutrition[k]) ? "" : " " + u}`, nrv(k, d.nutrition[k])])];
  out.push(`<rect x="${x}" y="${cy}" width="${width}" height="${rh * all.length}" fill="none" stroke="${ink}" stroke-width="0.25"/>`);
  all.forEach((r, i) => {
    if (i) out.push(`<line x1="${x}" y1="${cy}" x2="${x + width}" y2="${cy}" stroke="${ink}" stroke-width="${i === 1 ? 0.25 : 0.12}"/>`);
    let cx = x;
    r.forEach((t, j) => {
      const anchor = j === 0 ? "start" : j === 1 ? "middle" : "end";
      const tx = j === 0 ? cx + f * 0.4 : j === 1 ? cx + cols[j] / 2 : cx + cols[j] - f * 0.4;
      out.push(`<text x="${tx.toFixed(2)}" y="${(cy + rh * 0.7).toFixed(2)}" font-size="${f * 0.95}" ${i === 0 ? 'font-weight="700"' : ""} fill="${ink}" text-anchor="${anchor}">${xml(t)}</text>`);
      cx += cols[j];
    });
    cy += rh;
  });
  return { out, height: cy - y };
}

function barcode(code, x, y, width, height, ink) {
  const bits = eanBits(code);
  if (!bits) return [];
  const m = width / (bits.length + 11);
  const out = [`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#fff"/>`];
  const x0 = x + m * 7;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== "1") continue;
    const guard = i < 3 || (i >= 45 && i < 50) || i >= 92;
    out.push(`<rect x="${(x0 + i * m).toFixed(3)}" y="${y}" width="${m.toFixed(3)}" height="${(height * (guard ? 0.86 : 0.76)).toFixed(2)}" fill="${ink}"/>`);
  }
  const d = ean13(code);
  const f = height * 0.17;
  const ty = y + height * 0.97;
  out.push(`<text x="${x0 - m * 4}" y="${ty}" font-size="${f}" fill="${ink}" text-anchor="middle" font-family="monospace">${d[0]}</text>`);
  out.push(`<text x="${x0 + m * 24}" y="${ty}" font-size="${f}" fill="${ink}" text-anchor="middle" font-family="monospace" letter-spacing="${m * 1.4}">${d.slice(1, 7)}</text>`);
  out.push(`<text x="${x0 + m * 70}" y="${ty}" font-size="${f}" fill="${ink}" text-anchor="middle" font-family="monospace" letter-spacing="${m * 1.4}">${d.slice(7)}</text>`);
  return out;
}

// The whole label. Shrinks the body text (not below 1.8 mm) until it fits; `fits` says whether it did.
export function labelSvg(raw, { pxPerMm = null } = {}) {
  const d = cleanLabel(raw);
  const { w, h } = LABEL_SIZES[d.size];
  const ink = d.color;
  const pad = 3;
  const wide = w >= h * 1.15;
  const netF = netHeight(d.net) * 1.15; // cap height is ~0.87 of the font size
  const titleF = Math.min(6, Math.max(3.6, (w - pad * 2) / Math.max(6, Array.from(d.name || "产品名称").length + 4)));
  const rows = infoRows(d);
  let f = 2.6;
  let parts;
  let fits = false;
  let used = f;
  for (; f >= 1.8 - 1e-9; f -= 0.1) {
    used = f;
    parts = [];
    let top = pad + titleF * 1.05;
    parts.push(`<text x="${pad}" y="${top}" font-size="${titleF}" font-weight="800" fill="${ink}">${xml(d.name || "产品名称")}</text>`);
    const dateText = `生产日期：${d.date || ""}`;
    const dw = Math.max(textWidth(dateText, f * 1.05) + f * 1.2, 26);
    parts.push(`<rect x="${w - pad - dw}" y="${pad}" width="${dw}" height="${f * 2.2}" fill="none" stroke="${ink}" stroke-width="0.25"/>`);
    parts.push(`<text x="${w - pad - dw + f * 0.6}" y="${pad + f * 1.5}" font-size="${f * 1.05}" font-weight="700" fill="${ink}">${xml(dateText)}</text>`);
    top += titleF * 0.45;
    parts.push(`<line x1="${pad}" y1="${top}" x2="${w - pad}" y2="${top}" stroke="${ink}" stroke-width="0.35"/>`);
    const bottomH = Math.max(netF * 1.2, d.barcode ? 14 : 0) + 1;
    const avail = h - pad - bottomH - top;
    if (wide) {
      const rw = (w - pad * 3) * 0.42;
      const lw = w - pad * 3 - rw;
      const left = column(rows, pad, top, lw, f, ink);
      const right = nutritionTable(d, pad * 2 + lw, top + f * 0.4, rw, f, ink);
      parts.push(...left.out, ...right.out);
      fits = left.height <= avail && right.height <= avail;
    } else {
      const left = column(rows, pad, top, w - pad * 2, f, ink);
      const right = nutritionTable(d, pad, top + left.height + f * 0.6, w - pad * 2, f, ink);
      parts.push(...left.out, ...right.out);
      fits = left.height + right.height + f * 0.6 <= avail;
    }
    // Bottom band: net content (legal character height) and the barcode.
    const by = h - pad;
    if (d.net) parts.push(`<text x="${pad}" y="${by - 0.5}" font-size="${netF}" font-weight="800" fill="${ink}">净含量：${xml(d.net)}</text>`);
    if (d.barcode) parts.push(...barcode(d.barcode, w - pad - 34, by - 14, 34, 14, ink));
    if (fits) break;
  }
  const size = pxPerMm ? `width="${Math.round(w * pxPerMm)}" height="${Math.round(h * pxPerMm)}"` : `width="${w}mm" height="${h}mm"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff"/><g font-family="${FONT}">${parts.join("")}</g></svg>`;
  const problems = [];
  if (!fits) problems.push("字太多，标签放不下：删减一些内容，或换大一号的标签");
  if (d.barcode && !ean13(d.barcode)) problems.push("条形码位数或校验位不对（应为 13 位，或填前 12 位自动补校验位）");
  for (const [k, n] of [["name", "产品名称"], ["ingredients", "配料"], ["net", "净含量"], ["maker", "生产商"], ["address", "地址"], ["phone", "电话"], ["storage", "贮存条件"], ["shelfLife", "保质期"]])
    if (!d[k]) problems.push(`没填${n}（预包装食品标签必须有）`);
  return { svg, fits, fontMm: Math.round(used * 10) / 10, problems, w, h };
}
