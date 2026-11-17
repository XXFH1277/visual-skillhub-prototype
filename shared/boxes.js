// 盒型：插舌盒、天地盖礼盒、外箱纸箱。每种盒子是一棵“面”的树：子面贴在父面的一条边上，
// 合上时绕这条边向里折 `fold` 度。浏览器用它做 3D 折叠，刀版图用它摊平、画裁切线和压痕线。
// Units: millimetres. Edges: "top" | "bottom" | "left" | "right" of the parent.

export const BOX_TYPES = {
  tuck: { name: "插舌盒", hint: "一张纸折成，适合小礼盒、干货、茶叶", main: "front", size: { l: 120, w: 60, h: 180 } },
  lid: { name: "天地盖礼盒", hint: "盖子和底分开，送礼常用", main: "top", size: { l: 300, w: 200, h: 90 } },
  carton: { name: "外箱纸箱", hint: "套在泡沫箱外面，生鲜冷链用", main: "front", size: { l: 420, w: 320, h: 280 } },
};
// Which printed design goes where. Flaps and walls without a face of their own take the base colour.
export const FACES = { front: "正面", back: "背面", left: "左侧", right: "右侧", top: "顶面", bottom: "底面" };

export function cleanSize(type, raw = {}) {
  const def = BOX_TYPES[type]?.size || BOX_TYPES.tuck.size;
  const n = (v, d) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) && x >= 20 && x <= 1500 ? x : d;
  };
  return { l: n(raw.l, def.l), w: n(raw.w, def.w), h: n(raw.h, def.h) };
}

// The face the merchant designs first (and its size), so the AI draws it at the right ratio.
export function mainFace(type, { l, w, h }) {
  return type === "lid" ? { face: "top", w: l, h: w } : { face: "front", w: l, h };
}

// One part: { id, face?, w, h, parent?, edge?, offset?, fold, taper?, net, label }
function tuck({ l, w, h }) {
  const tf = Math.min(18, Math.max(10, w * 0.25)); // tuck flap depth
  const df = Math.min(w * 0.5, l * 0.4); // dust flap depth
  const g = Math.min(15, Math.max(8, w * 0.2)); // glue flap
  return [
    { id: "front", face: "front", w: l, h, fold: 0, net: "box" },
    { id: "right", face: "right", w, h, parent: "front", edge: "right", fold: 90 },
    { id: "back", face: "back", w: l, h, parent: "right", edge: "right", fold: 90 },
    { id: "left", face: "left", w, h, parent: "back", edge: "right", fold: 90 },
    { id: "glue", w: g, h, parent: "left", edge: "right", fold: 92, taper: g * 0.6, label: "粘口" },
    // Hinged on the back, so it is printed upside down to read right way up from the front.
    { id: "top", face: "top", w: l, h: w, parent: "back", edge: "top", fold: 90, flip: true },
    { id: "topTuck", w: l, h: tf, parent: "top", edge: "top", fold: 90, taper: tf * 0.8, label: "插舌" },
    { id: "dustTR", w, h: df, parent: "right", edge: "top", fold: 92, taper: df * 0.6, label: "防尘翼" },
    { id: "dustTL", w, h: df, parent: "left", edge: "top", fold: 92, taper: df * 0.6, label: "防尘翼" },
    { id: "bottom", face: "bottom", w: l, h: w, parent: "front", edge: "bottom", fold: 90 },
    { id: "bottomTuck", w: l, h: tf, parent: "bottom", edge: "bottom", fold: 90, taper: tf * 0.8, label: "插舌" },
    { id: "dustBR", w, h: df, parent: "right", edge: "bottom", fold: 92, taper: df * 0.6, label: "防尘翼" },
    { id: "dustBL", w, h: df, parent: "left", edge: "bottom", fold: 92, taper: df * 0.6, label: "防尘翼" },
  ];
}
function carton({ l, w, h }) {
  const f = w / 2;
  const g = 35;
  const parts = [
    { id: "front", face: "front", w: l, h, fold: 0, net: "box" },
    { id: "right", face: "right", w, h, parent: "front", edge: "right", fold: 90 },
    { id: "back", face: "back", w: l, h, parent: "right", edge: "right", fold: 90 },
    { id: "left", face: "left", w, h, parent: "back", edge: "right", fold: 90 },
    { id: "glue", w: g, h, parent: "left", edge: "right", fold: 92, taper: g * 0.3, label: "粘口" },
  ];
  // Side flaps tuck in first, the long flaps close over them and meet in the middle.
  for (const [p, pw, outer] of [["front", l, true], ["right", w, false], ["back", l, true], ["left", w, false]]) {
    parts.push({ id: `${p}Top`, w: pw, h: f, parent: p, edge: "top", fold: outer ? 90 : 93, label: "摇盖" });
    parts.push({ id: `${p}Bottom`, w: pw, h: f, parent: p, edge: "bottom", fold: outer ? 90 : 93, label: "摇盖" });
  }
  return parts;
}
// 天地盖：盖子（顶 + 四边）和底盒（底 + 四边）两张纸。
function lid({ l, w, h }) {
  const d = Math.round(Math.min(h * 0.45, 60)); // lid wall depth
  const L = l + 4, W = w + 4; // the lid goes over the base
  const t = Math.min(14, d * 0.5); // corner tabs
  const parts = [
    { id: "lidTop", face: "top", w: L, h: W, fold: 0, net: "lid" },
    { id: "lidFront", face: "front", w: L, h: d, parent: "lidTop", edge: "bottom", fold: 90 },
    { id: "lidBack", face: "back", w: L, h: d, parent: "lidTop", edge: "top", fold: 90 },
    { id: "lidLeft", face: "left", w: d, h: W, parent: "lidTop", edge: "left", fold: 90 },
    { id: "lidRight", face: "right", w: d, h: W, parent: "lidTop", edge: "right", fold: 90 },
    { id: "baseBottom", face: "bottom", w: l, h: w, fold: 0, net: "base" },
    { id: "baseFront", w: l, h: h - 2, parent: "baseBottom", edge: "bottom", fold: 90 },
    { id: "baseBack", w: l, h: h - 2, parent: "baseBottom", edge: "top", fold: 90 },
    { id: "baseLeft", w: h - 2, h: w, parent: "baseBottom", edge: "left", fold: 90 },
    { id: "baseRight", w: h - 2, h: w, parent: "baseBottom", edge: "right", fold: 90 },
  ];
  // Corner tabs on the long walls, glued inside the short ones.
  for (const [p, edgeA, edgeB, len] of [["lidFront", "left", "right", d], ["lidBack", "left", "right", d], ["baseFront", "left", "right", h - 2], ["baseBack", "left", "right", h - 2]]) {
    parts.push({ id: `${p}TabA`, w: t, h: len, parent: p, edge: edgeA, fold: 92, taper: t * 0.5, label: "" });
    parts.push({ id: `${p}TabB`, w: t, h: len, parent: p, edge: edgeB, fold: 92, taper: t * 0.5, label: "" });
  }
  return parts;
}

export function boxParts(type, size) {
  const s = cleanSize(type, size);
  return (type === "lid" ? lid : type === "carton" ? carton : tuck)(s);
}

// Faces this box type actually has, with their size in mm (the first part carrying it).
export function faceSizes(type, size) {
  const out = {};
  for (const p of boxParts(type, size)) if (p.face && !out[p.face]) out[p.face] = { w: p.w, h: p.h };
  return out;
}
// Where the food label goes: a face big enough and not the main design.
export const LABEL_FACE = { tuck: "back", carton: "right", lid: "bottom" };

// Flat layout: absolute positions of every part, one group per sheet ("box", or "lid" + "base").
export function flatNet(type, size) {
  const parts = boxParts(type, size);
  const byId = new Map(parts.map((p) => [p.id, { ...p }]));
  const placed = [];
  for (const p of byId.values()) {
    if (!p.parent) {
      p.x = 0;
      p.y = 0;
    } else {
      const q = byId.get(p.parent);
      const off = p.offset || 0;
      if (p.edge === "right") Object.assign(p, { x: q.x + q.w, y: q.y + off });
      if (p.edge === "left") Object.assign(p, { x: q.x - p.w, y: q.y + off });
      if (p.edge === "top") Object.assign(p, { x: q.x + off, y: q.y - p.h });
      if (p.edge === "bottom") Object.assign(p, { x: q.x + off, y: q.y + q.h });
      p.net = q.net;
    }
    placed.push(p);
  }
  // Each sheet starts at its own origin; sheets sit side by side with a gap.
  const sheets = [];
  for (const net of [...new Set(placed.map((p) => p.net))]) {
    const ps = placed.filter((p) => p.net === net);
    const minX = Math.min(...ps.map((p) => p.x)), minY = Math.min(...ps.map((p) => p.y));
    for (const p of ps) Object.assign(p, { x: p.x - minX, y: p.y - minY });
    sheets.push({ net, parts: ps, w: Math.max(...ps.map((p) => p.x + p.w)), h: Math.max(...ps.map((p) => p.y + p.h)) });
  }
  let x = 0;
  for (const s of sheets) {
    for (const p of s.parts) p.x += x;
    s.x = x;
    x += s.w + 30;
  }
  return { sheets, parts: placed, w: x - 30, h: Math.max(...sheets.map((s) => s.h)) };
}

// Outline of one part in flat coordinates; tapered flaps lose their outer corners.
export function partPolygon(p) {
  const t = p.taper || 0;
  const { x, y, w, h } = p;
  if (!t || !p.edge) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const tt = Math.min(t, (p.edge === "left" || p.edge === "right" ? h : w) / 2.2);
  if (p.edge === "top") return [[x + tt, y], [x + w - tt, y], [x + w, y + h], [x, y + h]];
  if (p.edge === "bottom") return [[x, y], [x + w, y], [x + w - tt, y + h], [x + tt, y + h]];
  if (p.edge === "right") return [[x, y], [x + w, y + tt], [x + w, y + h - tt], [x, y + h]];
  return [[x, y + tt], [x + w, y], [x + w, y + h], [x, y + h - tt]];
}

// Fold lines are the hinges; every other edge is cut.
export function foldLines(net) {
  const byId = new Map(net.parts.map((p) => [p.id, p]));
  return net.parts
    .filter((p) => p.parent)
    .map((p) => {
      const q = byId.get(p.parent);
      if (p.edge === "right") return [[p.x, p.y], [p.x, p.y + p.h]];
      if (p.edge === "left") return [[p.x + p.w, p.y], [p.x + p.w, p.y + p.h]];
      if (p.edge === "top") return [[p.x, p.y + p.h], [p.x + p.w, p.y + p.h]];
      return [[p.x, q.y + q.h], [p.x + p.w, q.y + q.h]];
    });
}

// Cut lines: every part outline minus the hinge segments (those are folds, drawn dashed).
export function cutLines(net) {
  const folds = foldLines(net);
  const eq = (a, b) => Math.abs(a - b) < 0.01;
  const out = [];
  for (const p of net.parts) {
    const poly = partPolygon(p);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const vertical = eq(a[0], b[0]), horizontal = eq(a[1], b[1]);
      if (!vertical && !horizontal) {
        out.push([a, b]);
        continue;
      }
      // Work along the edge as [lo, hi] on its axis; remove the stretches that are hinges.
      const axis = vertical ? 1 : 0;
      const fixed = vertical ? a[0] : a[1];
      let pieces = [[Math.min(a[axis], b[axis]), Math.max(a[axis], b[axis])]];
      for (const [f0, f1] of folds) {
        const fv = eq(f0[0], f1[0]);
        if (fv !== vertical || !eq(vertical ? f0[0] : f0[1], fixed)) continue;
        const lo = Math.min(f0[axis], f1[axis]), hi = Math.max(f0[axis], f1[axis]);
        pieces = pieces.flatMap(([s, e]) => {
          if (hi <= s + 0.01 || lo >= e - 0.01) return [[s, e]];
          return [[s, lo], [hi, e]].filter(([x, y]) => y - x > 0.01);
        });
      }
      for (const [s, e] of pieces) out.push(vertical ? [[fixed, s], [fixed, e]] : [[s, fixed], [e, fixed]]);
    }
  }
  return out;
}
