import sharp from "sharp";

// Packaging for merchants who ship in fixed foam boxes: a printed outer carton (or a
// gift box) sized around the box. The image model designs the main face; the program
// lays out the flat (dieline) at real size with exact text, for the printer to rebuild.

const FONT = "PingFang SC, Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, sans-serif";
const xml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

export const PACK_KINDS = {
  carton: { name: "外箱纸箱（套在泡沫箱外）", allowance: 0.5 },
  gift: { name: "礼盒（天地盖）", allowance: 0.3 },
};

// Box size in cm: the foam box's outer size plus a little room.
export function packSize(kind, box) {
  const n = (v) => Math.round(Number(v) * 10) / 10;
  const l = n(box?.l), w = n(box?.w), h = n(box?.h);
  if (![l, w, h].every((v) => Number.isFinite(v) && v >= 5 && v <= 150)) return null;
  const a = PACK_KINDS[kind]?.allowance ?? 0.5;
  const [L, W] = l >= w ? [l, w] : [w, l];
  return { l: n(L + a), w: n(W + a), h: n(h + a) };
}

// The face the buyer sees first: a carton's long side; a gift box's lid.
export function mainFace(kind, size) {
  return kind === "gift" ? { w: size.l, h: size.w, name: "盒盖正面" } : { w: size.l, h: size.h, name: "长侧面（正面）" };
}

// Nearest image ratio the generator supports.
export function aspectFor(w, h) {
  const r = w / h;
  const options = [["16:9", 16 / 9], ["4:3", 4 / 3], ["1:1", 1], ["3:4", 3 / 4]];
  return options.reduce((best, o) => (Math.abs(Math.log(o[1] / r)) < Math.abs(Math.log(best[1] / r)) ? o : best))[0];
}

function lines(text, perLine) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const chars = Array.from(raw);
    for (let i = 0; i < chars.length; i += perLine) out.push(chars.slice(i, i + perLine).join(""));
    if (!chars.length) out.push("");
  }
  return out;
}

// Side panel: exact product information + handling marks, typeset (never drawn by the model).
function infoPanel(x, y, w, h, { info, brand, color, ink }) {
  const pad = w * 0.08;
  const rows = info.filter((r) => r[1]).slice(0, 9);
  const mark = Math.min(((w - pad * 2) / 4) * 0.84, h * 0.13);
  // Rows share what's left above the handling marks.
  const size = Math.max(10, Math.min(w / 16, (h - pad * 2 - mark * 1.4) / (rows.length * 1.9 + 4)));
  const out = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`];
  out.push(`<text x="${x + w / 2}" y="${y + pad + size * 1.6}" font-size="${size * 1.6}" font-weight="700" fill="${ink}" text-anchor="middle">${xml(brand)}</text>`);
  let ty = y + pad + size * 3.6;
  for (const [k, v] of rows) {
    const vs = lines(v, Math.max(6, Math.floor((w - pad * 2) / size) - 6));
    out.push(`<text x="${x + pad}" y="${ty}" font-size="${size}" font-weight="700" fill="${ink}">${xml(k)}</text>`);
    vs.forEach((t, i) => out.push(`<text x="${x + pad + size * 5}" y="${ty + i * size * 1.35}" font-size="${size}" fill="${ink}">${xml(t)}</text>`));
    ty += Math.max(1, vs.length) * size * 1.35 + size * 0.5;
  }
  // Handling marks as labelled boxes (printers swap in the standard pictograms).
  const marks = ["向上", "怕湿", "小心轻放", "冷冻保存"];
  const mw = (w - pad * 2) / marks.length;
  const my = y + h - pad - mark;
  marks.forEach((m, i) => {
    const cx = x + pad + i * mw + mw / 2;
    out.push(`<rect x="${cx - mark / 2}" y="${my}" width="${mark}" height="${mark}" rx="${mark * 0.1}" fill="none" stroke="${ink}" stroke-width="${Math.max(1, mark * 0.035)}"/>`);
    out.push(`<text x="${cx}" y="${my + mark * 0.58}" font-size="${mark * 0.19}" fill="${ink}" text-anchor="middle">${xml(m)}</text>`);
  });
  return out.join("");
}

function brandPanel(x, y, w, h, { brand, name, color, ink }) {
  const size = Math.max(14, Math.min(w / Math.max(4, Array.from(brand).length + 2), h / 3));
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>
    <text x="${x + w / 2}" y="${y + h / 2}" font-size="${size}" font-weight="800" fill="${ink}" text-anchor="middle">${xml(brand)}</text>
    <text x="${x + w / 2}" y="${y + h / 2 + size * 1.1}" font-size="${size * 0.45}" fill="${ink}" text-anchor="middle">${xml(name)}</text>`;
}

const dim = (x1, y1, x2, y2, label, size, vertical = false) => {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1565c0" stroke-width="1.5" marker-start="url(#a)" marker-end="url(#a)"/>
    <text x="${mx}" y="${my - 6}" font-size="${size}" fill="#1565c0" text-anchor="middle"${vertical ? ` transform="rotate(-90 ${mx} ${my})"` : ""}>${xml(label)}</text>`;
};

// Flat layout at real size. `front` is the chosen main-face artwork (PNG/JPEG buffer).
export async function renderDieline({ kind, size, front, brand, name, info, palette = [], dpcm = 30 }) {
  const color = palette[0] || "#1a3e8c";
  const ink = "#ffffff";
  const px = (cm) => Math.round(cm * dpcm);
  const margin = px(6);
  const label = Math.max(14, px(0.9));
  const fills = [];
  const art = [];
  const cuts = [];
  const folds = [];
  const dims = [];
  let W, H;
  if (kind === "gift") {
    // Lid net: top in the middle, four walls folded down (depth = min(height, 6cm)).
    const d = Math.min(size.h, 6);
    const L = px(size.l), Wd = px(size.w), D = px(d);
    W = L + D * 2 + margin * 2;
    H = Wd + D * 2 + margin * 2;
    const x0 = margin + D, y0 = margin + D;
    art.push({ x: x0, y: y0, w: L, h: Wd });
    for (const [x, y, w, h] of [[x0, margin, L, D], [x0, y0 + Wd, L, D], [margin, y0, D, Wd], [x0 + L, y0, D, Wd]])
      fills.push(brandPanel(x, y, w, h, { brand, name, color, ink }));
    cuts.push(`M${x0} ${margin} H${x0 + L} V${y0} H${x0 + L + D} V${y0 + Wd} H${x0 + L} V${y0 + Wd + D} H${x0} V${y0 + Wd} H${margin} V${y0} H${x0} Z`);
    folds.push(`M${x0} ${y0} H${x0 + L} V${y0 + Wd} H${x0} Z`);
    dims.push(dim(x0, margin - label, x0 + L, margin - label, `${size.l * 10} mm`, label));
    dims.push(dim(x0 + L + D + label, y0, x0 + L + D + label, y0 + Wd, `${size.w * 10} mm`, label, true));
    dims.push(dim(margin - label * 0.6, y0 + Wd, margin - label * 0.6, y0 + Wd + D, `盖高 ${d * 10} mm`, label * 0.8, true));
  } else {
    // Regular slotted carton (0201): front, side, back, side, glue flap; flaps = half the width.
    const L = px(size.l), Wd = px(size.w), Hh = px(size.h), F = px(size.w / 2), G = px(3.5);
    W = L * 2 + Wd * 2 + G + margin * 2;
    H = Hh + F * 2 + margin * 2;
    const y0 = margin + F;
    const xs = [margin, margin + L, margin + L + Wd, margin + L * 2 + Wd, margin + L * 2 + Wd * 2];
    art.push({ x: xs[0], y: y0, w: L, h: Hh }, { x: xs[2], y: y0, w: L, h: Hh });
    fills.push(infoPanel(xs[1], y0, Wd, Hh, { info, brand, color, ink }));
    fills.push(infoPanel(xs[3], y0, Wd, Hh, { info, brand, color, ink }));
    for (const [i, w] of [[0, L], [1, Wd], [2, L], [3, Wd]]) {
      fills.push(brandPanel(xs[i], margin, w, F, { brand, name, color, ink }));
      fills.push(`<rect x="${xs[i]}" y="${y0 + Hh}" width="${w}" height="${F}" fill="${color}"/>`);
    }
    fills.push(`<rect x="${xs[4]}" y="${y0 + Hh * 0.05}" width="${G}" height="${Hh * 0.9}" fill="#d9d4c7"/>`);
    let path = `M${xs[0]} ${margin}`;
    for (const [i, w] of [[0, L], [1, Wd], [2, L], [3, Wd]]) path += ` H${xs[i] + w - 2} V${y0} H${xs[i] + w + 2} V${margin}`;
    path += ` V${y0} H${xs[4] + G} V${y0 + Hh} H${xs[4]}`;
    for (const [i, w] of [[3, Wd], [2, L], [1, Wd], [0, L]]) path += ` V${y0 + Hh + F} H${xs[i]} V${y0 + Hh}`;
    path += ` V${margin} Z`;
    cuts.push(path);
    folds.push(`M${xs[0]} ${y0} H${xs[4]} M${xs[0]} ${y0 + Hh} H${xs[4]}`);
    for (const x of xs.slice(1)) folds.push(`M${x} ${y0} V${y0 + Hh}`);
    dims.push(dim(xs[0], margin - label, xs[1], margin - label, `长 ${size.l * 10} mm`, label));
    dims.push(dim(xs[1], margin - label, xs[2], margin - label, `宽 ${size.w * 10} mm`, label));
    dims.push(dim(margin - label * 0.6, y0, margin - label * 0.6, y0 + Hh, `高 ${size.h * 10} mm`, label, true));
    dims.push(dim(xs[4] + G + label * 0.8, margin, xs[4] + G + label * 0.8, y0, `摇盖 ${(size.w / 2) * 10} mm`, label * 0.8, true));
  }
  const note = `${PACK_KINDS[kind].name} · 成品内尺寸 ${size.l * 10}×${size.w * 10}×${size.h * 10} mm · 红色实线=裁切 虚线=压痕 · 设计参考稿，最终刀版、材质与出血以印刷厂为准`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + label * 3}">
    <defs><marker id="a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1565c0"/></marker></defs>
    <rect width="100%" height="100%" fill="#ffffff"/>
    <g font-family="${FONT}">${fills.join("")}</g>
    <g id="art"></g>
    <path d="${folds.join(" ")}" fill="none" stroke="#2e7d32" stroke-width="2" stroke-dasharray="12 8"/>
    <path d="${cuts.join(" ")}" fill="none" stroke="#d32f2f" stroke-width="2.5"/>
    <g font-family="${FONT}">${dims.join("")}<text x="${margin}" y="${H + label * 1.8}" font-size="${label}" fill="#333">${xml(note)}</text></g>
  </svg>`;
  const base = await sharp(Buffer.from(svg)).png().toBuffer();
  const layers = [];
  for (const a of art) layers.push({ input: await sharp(front).resize(a.w, a.h, { fit: "cover" }).png().toBuffer(), left: a.x, top: a.y });
  // Lines go back on top of the artwork.
  const linesOnly = svg.replace(/<rect width="100%" height="100%" fill="#ffffff"\/>/, "").replace(/<g font-family="[^"]*">[\s\S]*?<\/g>\s*<g id="art"><\/g>/, "");
  layers.push({ input: await sharp(Buffer.from(linesOnly)).png().toBuffer(), left: 0, top: 0 });
  return sharp(base).composite(layers).png().toBuffer();
}
