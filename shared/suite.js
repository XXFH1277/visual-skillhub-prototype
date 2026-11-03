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
export const SECTION_TYPES = {
  hero: { name: "首屏主视觉", modes: ["ai"], photo: ["package", "product"] },
  why: { name: "为什么是这个产地", modes: ["tpl", "ai"], photo: ["origin"] },
  origin: { name: "产地实景", modes: ["ai", "photo"], photo: ["origin"] },
  compare: { name: "对比", modes: ["tpl", "photo", "ai"], photo: ["compare", "detail"] },
  pick: { name: "怎么挑 / 怎么辨别", modes: ["tpl", "ai"], photo: ["detail", "product"] },
  material: { name: "选材与细节", modes: ["ai", "tpl"], photo: ["detail", "product"] },
  usage: { name: "吃法 / 用法", modes: ["ai", "photo"], photo: ["cooked", "usage"] },
  faq: { name: "提前说清楚（答疑）", modes: ["tpl"], photo: [] },
  pack: { name: "包装与收货", modes: ["ai", "tpl"], photo: ["package"] },
  info: { name: "商品信息", modes: ["tpl"], photo: [] },
  notice: { name: "购物须知", modes: ["tpl"], photo: [] },
};
export const SECTION_MODES = { ai: "AI 出图", tpl: "文字排版", photo: "实拍+说明", off: "不要这屏" };

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
  ["治疗", "删除"],
  ["治愈", "删除"],
  ["药用", "删除"],
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
