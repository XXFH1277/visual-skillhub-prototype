// Shared by browser and server: what each scene asks for and what a plan may contain.

export const SCENES = {
  product: {
    name: "商品图",
    tagline: "主图 · 场景图 · 卖点图",
    mainLabel: "商品原图",
    mainRequired: true,
    copyLabel: "一句话说明（可选）",
    copyPlaceholder:
      "例如：品牌叫栖光，手作陶土香薰蜡烛，主打安静、治愈。不写也行，AI 会先看图分析。",
    unit: "张",
    counts: [1, 2, 3, 4],
    defaultCount: 2,
    sizes: ["1:1", "3:4", "4:3", "16:9"],
    defaultSize: "1:1",
  },
  detail: {
    name: "详情页",
    tagline: "AI 分镜 · 竖版分屏 · 拼长图",
    mainLabel: "商品原图",
    mainRequired: true,
    copyLabel: "商品介绍（可选）",
    copyPlaceholder:
      "知道多少写多少：品牌名、材质、功能、规格、适合谁。不写也行，AI 会先看图分析。",
    unit: "屏",
    counts: [4, 5, 6],
    defaultCount: 6,
    sizes: ["3:4"],
    defaultSize: "3:4",
  },
  poster: {
    name: "海报",
    tagline: "活动 · 促销 · 菜单",
    mainLabel: "主视觉素材（可不传）",
    mainRequired: false,
    copyLabel: "海报内容",
    copyPlaceholder:
      "写清楚要印在海报上的信息。例如：\n秋日咖啡节，全场第二杯半价，11月8日-11月10日，地址：xx路88号",
    unit: "张",
    counts: [1, 2],
    defaultCount: 1,
    sizes: ["3:4", "9:16", "1:1", "16:9"],
    defaultSize: "3:4",
  },
  packaging: {
    name: "包装图",
    tagline: "礼盒 · 袋子 · 罐子 · 外箱",
    mainLabel: "商品照片",
    mainRequired: true,
    copyLabel: "包装上印什么",
    copyPlaceholder:
      "例如：品牌叫海味渔家，舟山冷冻带鱼，净含量 2.5kg，过年送礼用。品牌名、品名和规格会原样印上去，没写的不会编。",
    unit: "款",
    counts: [1, 2, 3],
    defaultCount: 2,
    sizes: ["1:1", "4:3", "3:4"],
    defaultSize: "1:1",
  },
};

// 包装做成什么形式（只用于包装图）。
export const PACK_FORMS = { gift: "礼盒", bag: "手提袋", pouch: "自立袋", can: "罐 / 瓶", carton: "外箱", label: "标签贴纸" };
// 这几种图能选还原度；包装图上的商品是印刷图案，不按实拍还原度来。
export const FIDELITY_SCENES = ["product", "detail", "poster"];

// 一张图“出过了”的判据：画面、文字、还原度、方向和清晰度都没变，整组就直接用它。
// 空白按服务器整理文字的方式归一，免得多敲一个空格就算“改过了”。
const norm = (v) => String(v || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
export function frameSig(frame, chosen, resolution) {
  const texts = (frame.texts || []).map((t) => [t.role, norm(t.text)]).filter((t) => t[1]);
  const mode = texts.length ? frame.textMode : "none";
  return JSON.stringify([chosen, resolution, norm(frame.scene), mode, mode === "overlay" ? frame.layout : "", frame.fidelity || "", texts]);
}

export const SIZE_NAMES = {
  "1:1": "方形 1:1",
  "3:4": "竖版 3:4",
  "4:3": "横版 4:3",
  "16:9": "宽屏 16:9",
  "9:16": "全屏竖版 9:16",
};

// Where text sits in the frame. Boxes are fractions of the canvas: [x, y, w, h].
export const LAYOUTS = {
  top: "文字在上",
  bottom: "文字在下",
  left: "文字在左",
  right: "文字在右",
  center: "文字居中",
  none: "不放文字",
  free: "按风格排版",
};

export const TEXT_MODES = {
  ai: "AI 画进图里（更融合）",
  overlay: "程序排字（100% 准确）",
  none: "不加文字",
};

export const TEXT_ROLES = {
  headline: { name: "主标题", max: 16 },
  sub: { name: "副标题", max: 28 },
  point: { name: "卖点", max: 16 },
  body: { name: "说明", max: 80 },
  tag: { name: "小标/英文", max: 30 },
  price: { name: "价格/优惠", max: 20 },
  cta: { name: "行动号召", max: 12 },
  footer: { name: "落款/时间/地址", max: 40 },
};

export const MAX_TEXTS = 8;

export function layoutBoxes(layout, width, height) {
  const landscape = width > height * 1.2;
  const band = landscape ? 0.3 : 0.26;
  const side = 0.42;
  const full = [0, 0, 1, 1];
  const boxes = {
    top: { text: [0.06, 0.04, 0.88, band], image: [0.04, band + 0.02, 0.92, 0.94 - band] },
    bottom: { text: [0.06, 0.96 - band, 0.88, band], image: [0.04, 0.03, 0.92, 0.92 - band] },
    left: { text: [0.05, 0.12, side - 0.05, 0.76], image: [side, 0.05, 0.98 - side, 0.9] },
    right: { text: [1 - side, 0.12, side - 0.05, 0.76], image: [0.02, 0.05, 0.98 - side, 0.9] },
    center: { text: [0.1, 0.3, 0.8, 0.4], image: full },
    none: { text: null, image: [0.04, 0.04, 0.92, 0.92] },
  };
  const box = boxes[layout] || boxes.none;
  const px = (b) =>
    b && {
      x: Math.round(b[0] * width),
      y: Math.round(b[1] * height),
      w: Math.round(b[2] * width),
      h: Math.round(b[3] * height),
    };
  return { text: px(box.text), image: px(box.image) };
}

export function canvasSize(size) {
  return { "1:1": [1024, 1024], "3:4": [768, 1024], "4:3": [1024, 768], "16:9": [1344, 756], "9:16": [756, 1344] }[size] || [1024, 1024];
}

// Text the image model must draw (and Kimi must proofread).
export function textsForImage(_skillId, frame) {
  return frame.textMode === "ai" ? frame.texts : [];
}
