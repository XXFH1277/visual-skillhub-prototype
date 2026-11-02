import { LAYOUTS, TEXT_ROLES, SIZE_NAMES, textsForImage } from "../shared/scenes.js";

// Short, concrete production brief for the image model (no methodology text).
const AREA = {
  top: "画面上方约四分之一",
  bottom: "画面下方约四分之一",
  left: "画面左侧约四成",
  right: "画面右侧约四成",
  center: "画面中央",
};
const OPENERS = {
  product: "电商商品图，真实商业摄影质感（photorealistic commercial product photography）。",
  detail: "电商详情页配图，方形，真实商业摄影质感（photorealistic commercial product photography）。",
  poster: "平面海报设计，完整的版式与字体设计。",
  interior: "室内装修效果图，真实照片质感（photorealistic interior photograph）。",
};

// Files attached to the image request for this frame, in order.
export function frameInputs(params, index) {
  const frame = params.frames[index];
  const files = [...params.inputs];
  if (textsForImage(params.skillId, frame).length && params.layoutFiles?.[index])
    files.push(params.layoutFiles[index]);
  return files;
}

export function framePrompt(params, index) {
  const frame = params.frames[index];
  const texts = textsForImage(params.skillId, frame);
  const files = frameInputs(params, index);
  const refs = params.inputs.length - (params.hasMainImage ? 1 : 0);
  const lines = [OPENERS[params.skillId] + `画幅 ${SIZE_NAMES[params.size] || params.size}。只输出一张图片。`];

  const roles = [];
  let n = 1;
  if (params.hasMainImage) {
    roles.push(
      params.skillId === "interior"
        ? `图${n}：现场照片——保持同一机位、视角、透视、墙体、门窗位置与数量、梁柱和固定设施，只按下方要求改造。`
        : `图${n}：商品原图——商品的形状、比例、颜色、材质、Logo、标签文字必须完全一致，不重新设计、不添加配件、不复制多个。`,
    );
    n++;
  }
  if (refs > 0) {
    roles.push(`图${n}${refs > 1 ? `–图${n + refs - 1}` : ""}：风格参考——只借鉴色调、光线、氛围和构图感觉，不要复制其中的商品、文字、Logo 或户型。`);
    n += refs;
  }
  if (files.length > params.inputs.length)
    roles.push(`图${n}：版式稿——只用来参考文字内容、字形和摆放位置；背景、配色、字体风格请按本次风格重新设计，不要照搬版式稿的灰底和排版。`);
  if (roles.length) lines.push("【附件】\n" + roles.join("\n"));

  lines.push("【画面】\n" + frame.scene);
  const style = [...(params.styleTags || []), params.styleNote].filter(Boolean).join("，");
  if (style) lines.push("【风格】" + style);

  if (texts.length) {
    const list = texts
      .map((t, i) => `${i + 1}. ${TEXT_ROLES[t.role]?.name || "文字"}："${t.text}"`)
      .join("\n");
    lines.push(
      `【文字】画面中只出现下面这些文字，每条逐字照抄（EXACT, verbatim），每条只出现一次，清晰可读，不增不减不改字，不加任何其他字、标签、水印或英文：\n${list}\n文字放在${AREA[frame.layout] || "合适的留白处"}，主标题最大最醒目，层级按上面顺序；文字不要压住商品。`,
    );
  } else if (frame.textMode === "overlay" && frame.layout !== "none") {
    lines.push(
      `【留白】${AREA[frame.layout]}保持干净简洁（纯色、柔和渐变或虚化背景），不放商品、道具或图案，后期会在这里排字。整张图不要出现任何新增文字、标语、水印或 Logo（商品本身原有的标签保留）。`,
    );
  } else {
    lines.push("【文字】不要在画面中新增任何文字、标语、水印或 Logo（商品本身原有的标签保留）。");
  }
  if (params.skillId === "detail")
    lines.push("这是一组详情页中的一屏：光线方向、色温、背景色系与同组其他屏保持一致。");
  return lines.join("\n\n");
}

export const layoutName = (layout) => LAYOUTS[layout];

export async function preparePrompts(params, dir) {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const prompts = params.frames.map((_, i) => framePrompt(params, i));
  for (const [i, prompt] of prompts.entries())
    await writeFile(join(dir, `prompt-${i + 1}.txt`), prompt);
  return prompts;
}
