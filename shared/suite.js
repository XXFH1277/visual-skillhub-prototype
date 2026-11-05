// "商品全套": one product → profile → note → product images → detail page.

export const PHOTO_ROLES = {
  package: "包装/礼盒",
  product: "实物",
  detail: "细节/切面",
  cooked: "成品/吃法",
  origin: "产地/码头/工厂",
  compare: "对比图",
  usage: "使用/上手",
  design: "旧设计图",
  other: "其他",
};

// Quick answers for merchants without a written note (no typing needed).
export const QUICK = {
  storage: { label: "储存方式", options: ["常温", "冷藏", "冷冻 -18℃"] },
  courier: { label: "快递", options: ["顺丰", "京东", "中通/圆通", "邮政"], multi: true },
  freeShipping: { label: "包邮", options: ["包邮", "不包邮", "部分地区不包邮"] },
  dispatch: { label: "发货时效", options: ["24 小时内", "48 小时内", "72 小时内", "预售"] },
  afterSales: { label: "售后", options: ["签收 6 小时内拍照", "签收 24 小时内", "支持七天无理由", "生鲜不退换"] },
};

// Detail-page sections. Every merchant gets these "环节"; each can be an AI image,
// a typeset (exact-text) screen, a real photo with caption, or hidden.
// Most screens are drawn whole by the image model (it looks like a real detail page);
// text-heavy ones that must be letter-perfect get an AI background with typeset text ("bg").
export const SECTION_TYPES = {
  hero: { name: "首屏主视觉", modes: ["ai"], photo: ["package", "product"] },
  why: { name: "为什么是这个产地", modes: ["ai", "bg", "tpl"], photo: ["origin", "product"] },
  origin: { name: "产地实景", modes: ["ai", "photo"], photo: ["origin"] },
  compare: { name: "对比", modes: ["ai", "bg", "tpl", "photo"], photo: ["compare", "detail", "product"] },
  pick: { name: "怎么挑 / 怎么辨别", modes: ["ai", "bg", "tpl"], photo: ["detail", "product"] },
  material: { name: "选材与细节", modes: ["ai", "bg", "tpl"], photo: ["detail", "product"] },
  usage: { name: "吃法 / 用法", modes: ["ai", "photo"], photo: ["cooked", "usage"] },
  faq: { name: "提前说清楚（答疑）", modes: ["bg", "ai", "tpl"], photo: [] },
  normal: { name: "正常现象说明", modes: ["bg", "ai", "tpl"], photo: ["product", "detail"] },
  pack: { name: "包装与收货", modes: ["ai", "bg", "tpl"], photo: ["package"] },
  info: { name: "商品信息", modes: ["bg", "tpl", "ai"], photo: [] },
  notice: { name: "购物须知", modes: ["bg", "tpl", "ai"], photo: [] },
};
export const SECTION_MODES = { ai: "AI 出图", bg: "AI 底图+排字", tpl: "文字排版", photo: "实拍+说明", off: "不要这屏" };

// Ad-law "极限词" that are fine in a private WeChat group but get listings punished on Taobao.
export const RISKY_WORDS = [
  ["没有之一", "删除"],
  ["最好吃", "口碑好"],
  ["最好", "很好"],
  ["最佳", "很适合"],
  ["最香", "很香"],
  ["最肥", "正当季"],
  ["最厚", "很厚"],
  ["最新鲜", "很新鲜"],
  ["第一", "领先"],
  ["唯一", "独特"],
  ["顶级", "高品质"],
  ["极品", "精选"],
  ["国家级", "（需有证书）"],
  ["全网最低", "实惠"],
  ["史上", "删除"],
  ["百分百", "（需可证明）"],
  ["100%", "（需可证明）"],
  ["假一赔十", "（需确认能兑现，并在店铺规则写明）"],
  ["首选", "推荐"],
  ["极致", "很讲究"],
  ["滋养", "（普通食品不宣称保健作用）"],
  ["滋补", "（普通食品不宣称保健作用）"],
  ["增强免疫", "删除"],
  ["治疗", "删除"],
  ["治愈", "删除"],
  ["药用", "删除"],
  ["无污染", "（广告法不让说，改成具体的产地、海域、深度）"],
  ["不受污染", "（广告法不让说，改成具体的产地、海域、深度）"],
  ["零污染", "（广告法不让说，改成具体的产地、海域、深度）"],
  ["污染", "（别说“无/少/远离污染”，改成具体的产地、海域、深度）"],
  ["营养价值极高", "营养丰富"],
  ["美容", "（普通食品不宣称美容、保健作用）"],
  ["产妇", "（普通食品不针对孕产妇、儿童、老人宣传功效）"],
  ["高钙食品", "（普通食品不针对特定人群宣传功效）"],
];
export function scanRisky(text) {
  // Longer words first are matched and masked so "最好吃" isn't also reported as "最好".
  let rest = String(text || "");
  const hits = [];
  for (const [word, fix] of [...RISKY_WORDS].sort((a, b) => b[0].length - a[0].length))
    if (rest.includes(word)) {
      hits.push({ word, fix });
      rest = rest.split(word).join("\u0000");
    }
  const order = (w) => RISKY_WORDS.findIndex(([x]) => x === w);
  return hits.sort((a, b) => order(a.word) - order(b.word));
}
export function saferText(text) {
  let out = String(text || "");
  for (const [word, fix] of RISKY_WORDS) if (!fix.startsWith("（")) out = out.split(word).join(fix === "删除" ? "" : fix);
  return out.replace(/，，/g, "，").replace(/\s+，/g, "，");
}

// Template screens need [dark text color, accent, light background] whatever order a
// palette comes in; the dark one is darkened until it reads on white.
export function paletteRoles(colors = []) {
  const parse = (h) => (/^#[0-9a-f]{6}$/i.test(h || "") ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) : null);
  const hex = (rgb) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const sat = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  const list = colors.map(parse).filter(Boolean);
  if (list.length < 2) return ["#1d3557", "#e8541e", "#f6efe6"];
  // Accent = the most colorful; of the rest, the darkest carries text and the lightest is the page.
  let accent = [...list].sort((a, b) => sat(b) - sat(a))[0];
  const rest = list.filter((c) => c !== accent);
  const byLum = [...rest].sort((a, b) => lum(a) - lum(b));
  let dark = byLum[0];
  const light = byLum.length > 1 ? byLum[byLum.length - 1] : [246, 239, 230];
  while (lum(dark) > 0.3) {
    // Darken, and pull channels apart a little so a pale tint becomes a deep tone, not grey.
    const mean = (dark[0] + dark[1] + dark[2]) / 3;
    dark = dark.map((v) => (v + (v - mean) * 0.35) * 0.8);
  }
  if (lum(accent) > 0.72) accent = accent.map((v) => v * 0.7);
  const bg = lum(light) > 0.86 ? light : light.map((v) => v + (255 - v) * 0.75);
  return [hex(dark), hex(accent), hex(bg)];
}
