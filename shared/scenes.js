// Shared by browser and server: what each scene asks for and what a plan may contain.

export const SCENES = {
  product: {
    name: "商品图",
    tagline: "主图 · 场景图 · 卖点图",
    mainLabel: "商品原图",
    mainRequired: true,
    copyLabel: "商品文案 / 卖点",
    copyPlaceholder:
      "随便写，AI 会帮你整理。例如：\n316 不锈钢保温杯，保温 12 小时，一键开盖，500ml，适合通勤和健身",
    unit: "张",
    counts: [1, 2, 3, 4],
    defaultCount: 2,
    sizes: ["1:1", "3:4"],
    defaultSize: "1:1",
    styles: ["干净白底", "高级质感", "温馨生活", "清新自然", "科技感", "国潮", "极简", "节日氛围"],
  },
  detail: {
    name: "详情页",
    tagline: "AI 拆屏 · 长图 + 切片",
    mainLabel: "商品原图",
    mainRequired: true,
    copyLabel: "商品介绍 / 卖点",
    copyPlaceholder:
      "把你知道的都写上：材质、功能、规格、适合谁、怎么用。AI 会拆成每一屏的标题和说明。",
    unit: "屏",
    counts: [3, 4, 5, 6],
    defaultCount: 4,
    sizes: ["1:1"],
    defaultSize: "1:1",
    styles: ["干净白底", "高级质感", "温馨生活", "清新自然", "科技感", "国潮", "极简", "母婴柔和"],
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
    sizes: ["3:4", "1:1", "16:9"],
    defaultSize: "3:4",
    styles: ["复古", "大字报", "清新插画", "高级极简", "国潮", "节日喜庆", "潮流撞色", "手绘"],
  },
  interior: {
    name: "装修效果",
    tagline: "原空间 · 换风格",
    mainLabel: "现场照片",
    mainRequired: true,
    copyLabel: "改造想法",
    copyPlaceholder:
      "例如：保留沙发和地板，换掉窗帘和地毯，墙面刷成暖白色，想要温馨一点的原木风",
    unit: "张",
    counts: [1, 2, 3],
    defaultCount: 1,
    sizes: ["16:9", "3:4", "1:1"],
    defaultSize: "16:9",
    styles: ["原木风", "奶油风", "现代简约", "侘寂风", "新中式", "法式复古", "工业风", "轻奢"],
  },
};

export const SIZE_NAMES = { "1:1": "方形 1:1", "3:4": "竖版 3:4", "16:9": "横版 16:9" };

// Where text sits in the frame. Boxes are fractions of the canvas: [x, y, w, h].
export const LAYOUTS = {
  top: "文字在上",
  bottom: "文字在下",
  left: "文字在左",
  right: "文字在右",
  center: "文字居中",
  none: "不放文字",
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
  body: { name: "说明", max: 60 },
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
  return { "1:1": [1024, 1024], "3:4": [768, 1024], "16:9": [1344, 756] }[size] || [1024, 1024];
}

// Detail pages: the image model only draws the headline; the body is typeset below the image.
export function textsForImage(skillId, frame) {
  if (frame.textMode !== "ai") return [];
  return skillId === "detail"
    ? frame.texts.filter((t) => t.role === "headline")
    : frame.texts;
}

export function frameCost(skillId, costs) {
  return costs[skillId]?.cost ?? 10;
}
