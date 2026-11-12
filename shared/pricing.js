// 定价：一张图（商品图或详情页一屏）10 积分；单买 1 元 = 10 积分，套餐越大单价越低。
export const CREDITS_PER_YUAN = 10;
export const PACKAGES = [
  { price: 39, credits: 600 },
  { price: 99, credits: 1800 },
  { price: 299, credits: 6600 },
  { price: 999, credits: 30000 },
];
// 签到：每天 5 积分，连续签到每 7 天一轮，第 1、3、5 天多送 5。签到积分 30 天过期。
export const CHECKIN_WEEK = [10, 5, 10, 5, 10, 5, 5];
export const CHECKIN_EXPIRE_DAYS = 30;
export const SIGNUP_CREDITS = 40;
// 没充过值的账号每天最多新建几个商品（建档和写笔记不收积分，但有模型成本）。
export const FREE_DAILY_PRODUCTS = 3;
