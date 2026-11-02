export const POSTER_KINDS = {
  promotion: "促销海报",
  event: "活动宣传",
  brand: "品牌海报",
  menu: "菜单 / 价目表",
};
export const POSTER_LAYOUTS = {
  auto: "自动设计",
  top: "上方标题 · 下方主视觉",
  side: "图文左右分区",
  typography: "文字为主 · 字体海报",
};
export const POSTER_FIELDS = [
  {
    key: "title",
    label: "主标题",
    max: 32,
    required: true,
    placeholder: "例如：秋日新品上市",
  },
  {
    key: "subtitle",
    label: "副标题",
    max: 60,
    placeholder: "例如：把温暖随身携带",
  },
  {
    key: "body",
    label: "正文 / 卖点 / 菜单条目",
    max: 400,
    multiline: true,
    placeholder: "每行一项。菜单请写明名称与真实价格，例如：美式咖啡 18元",
  },
  {
    key: "offer",
    label: "价格 / 优惠信息",
    max: 60,
    placeholder: "仅填写已确认的价格或优惠，可留空",
  },
  {
    key: "cta",
    label: "行动文案",
    max: 24,
    placeholder: "例如：到店体验 / 立即预约（印在海报上）",
  },
  {
    key: "footer",
    label: "品牌落款 / 时间 / 地址",
    max: 120,
    multiline: true,
    placeholder: "需要展示的品牌、活动日期、地址或联系方式，可留空",
  },
];
