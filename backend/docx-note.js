import fs from "node:fs/promises";
import sharp from "sharp";
import { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType } from "docx";
import { PHOTO_ROLES } from "../shared/suite.js";

// Word version of the product note, laid out like merchants' own notes:
// 【字段】值 … photos … 产品介绍 … 文案 … 售后. Everything stays copyable text.
const FIELDS = [
  ["品名", "name"],
  ["产地", "origin"],
  ["发货地", "shipFrom"],
  ["规格", "spec"],
  ["储存方式", "storage"],
  ["物流快递", "courier"],
  ["是否包邮", "freeShipping"],
  ["发货时效", "dispatch"],
  ["不发货/加价地区", "excludedAreas"],
  ["产品包装", "packaging"],
  ["售后", "afterSales"],
];
const FONT = "Microsoft YaHei";
const run = (text, opts = {}) => new TextRun({ text, font: FONT, size: 24, ...opts });
const para = (children, opts = {}) => new Paragraph({ children: Array.isArray(children) ? children : [children], spacing: { after: 120 }, ...opts });

async function photo(file) {
  const img = sharp(file).rotate().resize(900, 900, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 });
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  const width = 420;
  return new ImageRun({ type: "jpg", data, transformation: { width, height: Math.round((info.height / info.width) * width) } });
}

export async function noteDocx({ profile, note, photos, dir }) {
  const children = [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run(note?.title || profile.name || "商品笔记", { size: 36, bold: true })] })];
  for (const [label, key] of FIELDS) if (profile[key]) children.push(para([run(`【${label}】`, { bold: true }), run(profile[key])]));
  const pick = photos.filter((p) => p.usable && p.role !== "design").slice(0, 6);
  for (const p of pick) {
    try {
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [await photo(`${dir}/${p.file}`)] }));
      children.push(para(run(`${PHOTO_ROLES[p.role] || ""}${p.desc ? "：" + p.desc : ""}`, { size: 20, color: "888888" }), { alignment: AlignmentType.CENTER }));
    } catch {}
  }
  if (profile.intro) {
    children.push(para(run("【产品介绍】", { bold: true })));
    children.push(para(run(profile.intro)));
  }
  if (profile.sellingPoints?.length) {
    children.push(para(run("【卖点】", { bold: true })));
    for (const s of profile.sellingPoints) children.push(para([run(`· ${s.title}：`, { bold: true }), run(s.detail)]));
  }
  if (note?.text) {
    children.push(para(run("【文案】", { bold: true })));
    for (const line of note.text.split("\n")) children.push(para(run(line)));
  }
  if (profile.notice?.length) {
    children.push(para(run("【购物须知】", { bold: true })));
    profile.notice.forEach((n, i) => children.push(para(run(`${i + 1}. ${n}`))));
  }
  const doc = new Document({ styles: { default: { document: { run: { font: FONT } } } }, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}
