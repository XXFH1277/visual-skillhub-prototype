import fs from "node:fs/promises";
import path from "node:path";
import { TEXT_ROLES, SIZE_NAMES, textsForImage } from "../shared/scenes.js";

// A short production brief for the image model: who each attachment is,
// the chosen visual system, this frame's scene, and the exact text.
const OPENERS = {
  product: "电商商品视觉设计，商业摄影质感（photorealistic commercial product photography）。",
  detail: "电商详情页中的一屏竖版设计稿：完整的画面 + 排版文字，像高端品牌的详情页。",
  poster: "品牌海报设计，完整的版式与字体设计。",
  interior: "室内装修效果图，真实照片质感（photorealistic interior photograph）。",
};
const AREA = { top: "画面上方约四分之一", bottom: "画面下方约四分之一", left: "画面左侧约四成", right: "画面右侧约四成", center: "画面中央" };

// 生鲜水产、农副产品：买家要看到真货。“实拍保真”时商品来自实拍照片本身，
// 视觉系统只管底色、画框和文字；大片（hero）、菜品（ingredient）、包装等自带用法的图不受影响。
export const realMode = (params, frame) => params.fidelity === "real" && !frame?.photoUse && params.skillId !== "interior";
const realPhoto = (n, note = "") =>
  `图${n}：商家实拍${note}——画面以它为基础：商品和真实场景尽量保留原样（光影、冰碴、反光、鳞片和纹理这些真实细节不要修掉），可以裁切、轻微调色提亮、换掉杂乱的背景、加设计元素；商品/包装的形状、颜色、图案、Logo 和文字保持真实，不重新设计，不要画成 3D 渲染或塑料质感。`;

export function frameInputs(params, index) {
  if (params.operation === "tweak") return [...params.inputs];
  const frame = params.frames[index];
  const files = frame?.photos?.length ? [...frame.photos] : [...params.inputs];
  // A picked reference from the internal library replaces the generic style sample.
  if (frame?.styleRefs?.length) files.push(...frame.styleRefs);
  // An AI-made style sample pulls the product towards a repainted studio look.
  else if (params.styleRef && frame?.textMode !== "overlay" && !realMode(params, frame)) files.push(params.styleRef);
  return files;
}

// Edit a finished image: keep everything, change only what the merchant asked for.
function tweakPrompt(params) {
  const frame = params.frames[0];
  const texts = textsForImage(params.skillId, frame);
  const lines = [
    `图1 是一张已经完成、客户基本满意的${{ product: "电商商品图", detail: "详情页设计稿", poster: "海报", interior: "装修效果图" }[params.skillId] || "图片"}。请在图1 的基础上做局部修改，输出同样画幅（${SIZE_NAMES[params.size] || params.size}）的一张图片。`,
    `【只改这一处】${params.instruction}`,
    "【保持不变】除上面要求的修改外，构图、机位、商品的形状颜色与包装细节、Logo、光线方向、配色、背景与道具都与图1 保持一致；不要重新设计，不要增加或删除其他元素，不要改变画面比例。",
  ];
  if (texts.length)
    lines.push(
      `【文字】画面中的文字最终必须是下面这些，每条逐字照抄（EXACT, verbatim），位置和字体沿用图1 的设计，不增不减；图1 里已有的同样文字保持原样：\n${texts.map((t, i) => `${i + 1}. ${TEXT_ROLES[t.role]?.name || "文字"}："${t.text}"`).join("\n")}`,
    );
  else if (frame.textMode === "overlay" && frame.layout !== "none")
    lines.push(`【留白】${AREA[frame.layout]}继续保持干净，不要出现任何新增文字、水印或 Logo。`);
  else lines.push("【文字】不要新增任何文字、水印或 Logo（商品本身原有的标签保留）。");
  return lines.join("\n\n");
}

export function framePrompt(params, index) {
  if (params.operation === "tweak") return tweakPrompt(params);
  const frame = params.frames[index];
  const d = params.direction || {};
  const texts = textsForImage(params.skillId, frame);
  const files = frameInputs(params, index);
  const real = realMode(params, frame);
  const lines = [(params.opener || OPENERS[params.skillId]) + `画幅 ${SIZE_NAMES[params.size] || params.size}。只输出一张图片。`];

  const roles = [];
  let n = 1;
  if (frame.photos?.length) {
    frame.photos.forEach((_, i) => {
      const note = frame.photoNotes?.[i] ? `（${frame.photoNotes[i]}）` : "";
      roles.push(
        frame.photoUse === "ingredient"
          ? `图${n}：生鲜实拍${note}——只用来看食材本身（品种、大小、颜色、纹理），成品里的食材要和它一致；不要照搬它的背景、容器和构图。`
          : frame.photoUse === "print"
            ? `图${n}：商品实拍${note}——包装上的商品图案以它为准（品种、颜色、形状一致），可以做成干净的摄影抠图或精致插画；不要照搬它的背景和容器。`
            : frame.photoUse === "hero"
              ? `图${n}：商家实拍${note}——只用来确定商品长什么样（品种、外形、颜色、纹理、大小比例），画面里的商品必须是它；场景按下面的画面描述完全重新构图，不要照搬它的背景、容器和摆放。`
            : frame.photoUse === "staged"
              ? `图${n}：商家实拍${note}——商品本身照它来：品种、个头、颜色、纹理和数量感与它一致，不画成 3D 或塑料质感；它周围的背景、台面、容器和陪衬按下面的画面描述重新布置。`
            : frame.photoUse === "artwork"
              ? `图${n}：包装平面设计稿${note}——效果图里包装上的图案、文字、颜色、版式必须和它完全一致，只是贴到立体盒子上，不要重新设计。`
              : realPhoto(n, note),
      );
      n++;
    });
  } else if (params.hasMainImage) {
    roles.push(
      real
        ? realPhoto(n)
        : params.skillId === "interior"
        ? `图${n}：现场照片——保持同一机位、视角、透视、墙体、门窗位置与数量、梁柱和固定设施，只改造软装、饰面与配色。`
        : `图${n}：商品原图——商品的形状、比例、颜色、材质、Logo、标签文字必须完全一致；可以换角度摆放进新场景，但不能重新设计商品、不添加配件、不复制多个（除非画面要求多个）。`,
    );
    n++;
  }
  const refs = frame.photos?.length ? 0 : params.refCount || 0;
  if (refs > 0) {
    roles.push(`图${n}${refs > 1 ? `–图${n + refs - 1}` : ""}：商家给的风格参考——照着它的色调、光线、道具和排版气质做，但不要复制其中的商品、文字和 Logo。`);
    n += refs;
  }
  for (const r of frame.styleRefs || []) {
    roles.push(`图${n}：优秀设计参考——学它的构图张力、字体气质（书法大字、金字、竖排、大小错落）、色调光影和装饰层次，做出同等水准；不要照搬里面的商品、文字、店名、印章、水印和 Logo。`);
    n++;
  }
  if (files.includes(params.styleRef))
    roles.push(`图${n}：风格样图——只借鉴它的视觉系统（色调、光、道具类型、排版气质），里面的商品和文字与本次无关，不要出现。`);
  if (roles.length) lines.push("【附件】\n" + roles.join("\n"));

  const white = frame.ref === "white" || frame.cutout === true;
  if (!white && d.conceptName && real)
    lines.push(
      `【视觉系统 · ${d.conceptName}】只用于底色、画框、标题和标签；商品本身的光线、色泽、容器和摆放以实拍为准。\n色板：${(d.palette || []).join(" ")}\n字体排版：${d.type}${d.layout ? `\n版式元素：${d.layout}` : ""}${d.avoid ? `\n避免：${d.avoid}` : ""}`,
    );
  else if (!white && d.conceptName)
    lines.push(
      `【视觉系统 · ${d.conceptName}】${d.story || ""}\n色板：${(d.palette || []).join(" ")}\n道具与材质：${d.props}\n光线：${d.light}\n机位构图：${d.camera}\n字体排版：${d.type}${d.layout ? `\n版式元素：${d.layout}` : ""}${d.avoid ? `\n避免：${d.avoid}` : ""}${d.core ? `\nStyle: ${d.core}` : ""}`,
    );
  if (frame.grid)
    lines.push("【九宫格预览】这一张不是成品，而是一张 3×3 的预览拼图：正方形画面平均分成 9 个小格，格与格之间留一条细白缝，每格是一张独立的小图，九格属于同一套视觉系统（同一色板、字体气质和造景语言），但构图、机位和景别各不相同。每格里可以有一行很短的大标题（2–6 个字，字要大），不要小字。");
  lines.push("【这一张】" + frame.title + "\n" + (white ? (frame.scene || "").replaceAll("透明背景抠图（之后自动铺纯白）", "纯白背景商品摄影") + "。直接生成不透明的纯白背景，只保留商品本体，无包装、道具、文字或装饰。" : frame.scene));

  if (real && !white)
    lines.push(
      "【真实度】买家要看到真货：商品部分必须就是实拍照片里的样子，不重画、不美化、不磨皮、不加油光，不增减数量；不添加实拍里没有的手、动作、热气、水花和容器。上面的画面描述如果和实拍对不上，以实拍为准。底色、画框、标题、标签这些设计放在照片周围或照片的空白处。",
    );

  if (texts.length) {
    const list = texts.map((t, i) => `${i + 1}. ${TEXT_ROLES[t.role]?.name || "文字"}："${t.text}"`).join("\n");
    lines.push(
      `【文字】画面中只出现下面这些文字，每条逐字照抄（EXACT, verbatim），每条只出现一次，清晰可读，不增不减不改字；不要再加其他文字、水印或乱码小字：\n${list}\n文字的位置、大小和字体按上面的画面描述与字体排版要求设计，作为版式的一部分，不要压住商品主体。`,
    );
  } else if (frame.textMode === "overlay" && frame.layout !== "none") {
    lines.push(`【留白】${AREA[frame.layout]}保持干净（纯色、柔和渐变或虚化背景），后期会在这里排字。整张图不要出现任何新增文字、水印或 Logo（商品本身原有的标签保留）。`);
  } else if (!frame.grid) {
    lines.push("【文字】不要在画面中新增任何文字、水印或 Logo（商品本身原有的标签保留）。");
  }
  if (params.skillId === "detail") lines.push("同一套详情页的各屏保持同一色板、光线方向与字体系统。");
  return lines.join("\n\n");
}

export async function preparePrompts(params, dir) {
  const prompts = params.frames.map((_, i) => framePrompt(params, i));
  for (const [i, prompt] of prompts.entries()) await fs.writeFile(path.join(dir, `prompt-${i + 1}.txt`), prompt);
  return prompts;
}
