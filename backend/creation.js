import { CREATION_FIELDS, MODULE_ROLES } from "../shared/creation.js";
import { AppError } from "./store.js";

export function parseCreative(skillId, value, { legacy = false } = {}) {
  const fields = CREATION_FIELDS[skillId];
  if (!fields) return undefined;
  let input;
  try {
    input = typeof value === "string" ? JSON.parse(value) : (value ?? {});
  } catch {
    throw new AppError("创作参数格式错误");
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new AppError("创作参数格式错误");
  const result = {};
  for (const f of fields) {
    const v = input[f.key] ?? (f.options ? Object.keys(f.options)[0] : "");
    if (
      typeof v !== "string" ||
      (f.options
        ? !Object.hasOwn(f.options, v)
        : v.length > f.max || (f.required && !legacy && !v.trim()))
    )
      throw new AppError(`请检查${f.label}`);
    result[f.key] = v.trim();
  }
  if (skillId === "product" && result.textMode === "supplied" && !result.copy)
    throw new AppError("请填写确认的图内短文案");
  return result;
}

export function moduleDirection(m, i) {
  const role = m?.role || (i === 0 ? "hero" : "detail");
  if (!Object.hasOwn(MODULE_ROLES, role))
    throw new AppError("模块画面类型无效");
  const visual = m?.visual ?? "";
  if (typeof visual !== "string" || visual.length > 300)
    throw new AppError("模块画面说明不能超过 300 字");
  return { role, visual: visual.trim() };
}
