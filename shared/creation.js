export const MODULE_ROLES = {
  hero: "整体展示",
  detail: "可见细节",
  context: "使用场景",
  benefit: "已确认卖点",
  closing: "收尾展示",
};
export const CREATION_FIELDS = {
  product: [
    {
      key: "recipe",
      label: "图片用途",
      options: {
        set: "套图：主图 → 细节 → 场景",
        hero: "干净主图",
        detail: "可见细节特写",
        context: "使用场景",
      },
    },
    {
      key: "audience",
      label: "面向人群",
      max: 100,
      placeholder: "例如：办公室日常使用者；不确定可留空",
    },
    {
      key: "scene",
      label: "使用场景",
      max: 200,
      placeholder: "例如：浅木色办公桌，避免出现未包含的配件",
    },
    {
      key: "preserve",
      label: "必须保留的商品细节",
      max: 200,
      placeholder: "例如：瓶盖形状、蓝色渐变、正面标签",
    },
    {
      key: "textMode",
      label: "画面新增文案",
      options: {
        none: "不加营销文字（保留原标签）",
        supplied: "仅使用下方确认文案",
      },
    },
    {
      key: "copy",
      label: "确认的图内短文案",
      max: 80,
      placeholder: "仅在选择加入文案时生效，不会自动编写价格或功效",
    },
  ],
  detail: [
    {
      key: "category",
      label: "商品类别",
      options: {
        general: "通用",
        home: "家居 / 厨房",
        electronics: "数码 / 家电",
        apparel: "服装 / 配饰",
        beauty: "美妆 / 个护",
        food: "食品 / 饮品",
      },
    },
    {
      key: "audience",
      label: "面向人群",
      max: 100,
      placeholder: "例如：喜欢手冲咖啡的人",
    },
    {
      key: "scene",
      label: "真实使用场景",
      max: 200,
      placeholder: "用于规划场景模块，不作为新增商品事实",
    },
    {
      key: "preserve",
      label: "必须保留的商品细节",
      max: 200,
      placeholder: "例如：正面标识、材质外观与颜色",
    },
  ],
  interior: [
    {
      key: "room",
      label: "空间类型",
      options: {
        living: "客厅",
        bedroom: "卧室",
        kitchen: "厨房",
        bath: "卫生间",
        study: "书房 / 办公室",
        commercial: "商业空间",
        other: "其他空间",
      },
    },
    {
      key: "scope",
      label: "改造范围",
      options: {
        soft: "仅软装（保留硬装与固定设施）",
        finishes: "饰面与软装（保留建筑结构）",
      },
    },
    {
      key: "style",
      label: "装修风格",
      options: {
        modern: "现代简约",
        warm: "自然原木",
        minimal: "极简",
        chinese: "现代中式",
        vintage: "复古",
        custom: "自定义（见风格说明）",
      },
    },
    {
      key: "preserve",
      label: "额外必须保留",
      max: 300,
      placeholder: "例如：沙发、电视柜、原地板、空调位置",
    },
    {
      key: "changes",
      label: "允许改动的内容",
      max: 400,
      required: true,
      placeholder: "例如：更换窗帘、地毯和沙发；不调整布局",
    },
    {
      key: "materials",
      label: "期望材质与配色",
      max: 300,
      placeholder: "例如：米色布艺、浅木色家具；仅在允许范围内使用",
    },
    {
      key: "lighting",
      label: "光照方向",
      options: {
        daylight: "保留原窗采光，柔和日光",
        evening: "保留原灯位，暖色夜景",
        original: "接近原图光照",
      },
    },
    {
      key: "constraints",
      label: "其他限制",
      max: 300,
      placeholder: "例如：保留通道，不增加家具，不出现尺寸标注",
    },
  ],
};

// Suggestions use supplied copy only. They are editable before any generation.
export function suggestModules(facts = "", scene = "") {
  const lines = facts
    .split(/[\n；;]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (lines.some((x) => x.length > 100))
    throw new Error("请将每条已确认卖点缩短至 100 字以内，建议不会截断原文");
  return [
    {
      title: "商品展示",
      body: "",
      role: "hero",
      visual: "完整展示商品，保持原参考角度",
    },
    ...lines.map((body, i) => ({
      title: `特点 ${i + 1}`,
      body,
      role: "benefit",
      visual: "以可见外观支持已确认的卖点；不可见性能不画成效果证明",
    })),
    {
      title: "细节展示",
      body: "",
      role: "detail",
      visual: "展示原图中可见的细节，不补画未知背面或内部",
    },
    ...(scene.trim()
      ? [{ title: "使用场景", body: "", role: "context", visual: scene.trim() }]
      : []),
  ].slice(0, 6);
}
