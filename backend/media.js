import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./store.js";
import { overlayTexts, detailCaption } from "./render.js";
import { canvasSize } from "../shared/scenes.js";

const OPTIONS = { limitInputPixels: 40_000_000, failOn: "warning" };
const xml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );

export async function normalizeUpload(buffer, destination) {
  try {
    const info = await sharp(buffer, OPTIONS).metadata();
    if (!["png", "jpeg", "webp"].includes(info.format) || (info.pages || 1) > 1)
      throw new Error("Unsupported image");
    await sharp(buffer, OPTIONS)
      .rotate()
      .resize({
        width: 2048,
        height: 2048,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toFile(destination);
  } catch {
    throw new AppError(
      "图片无法读取，请上传静态 PNG、JPEG 或 WebP 图片（不超过 40MP）",
    );
  }
}

export async function regularFile(root, name) {
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(name))
    throw new AppError("文件不存在", 404);
  const target = path.join(root, name);
  const stat = await fs.lstat(target);
  const resolved = await fs.realpath(target);
  const base = await fs.realpath(root);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    path.dirname(resolved) !== base ||
    stat.size > 50 * 1024 * 1024
  )
    throw new AppError("无效的输出文件");
  return target;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

const captionTexts = (frame) =>
  frame.textMode === "ai" ? frame.texts.filter((t) => t.role !== "headline") : frame.texts;

export async function deliver(job, dir) {
  // Immutable export revisions: a failed re-layout cannot corrupt the last delivery.
  const p = job.params;
  const exportId = "exports-" + randomUUID();
  const out = path.join(dir, exportId);
  await fs.mkdir(out, { recursive: true });
  const assets = [];
  const warnings = [];
  const accent = p.brandColor || "#e8541e";
  const textCheck = (await readJson(path.join(dir, "text-check.json"))) || [];
  const add = async (name, role, frame = null) => {
    const bytes = await fs.readFile(path.join(out, name));
    const meta = await sharp(bytes, OPTIONS).metadata();
    assets.push({
      name,
      role,
      frame,
      width: meta.width,
      height: meta.height,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  };
  const modules = [];
  for (let i = 0; i < p.count; i++) {
    const source = await regularFile(dir, `result-${i + 1}.png`);
    const meta = await sharp(source, OPTIONS).metadata();
    if (!["png", "jpeg", "webp"].includes(meta.format) || (meta.pages || 1) > 1 || meta.width < 256 || meta.height < 256)
      throw new Error("生成的图片尺寸或格式不符合要求");
    const actual = `${meta.width}x${meta.height}`;
    if (p.requestedSize && actual !== p.requestedSize && p.operation !== "upscale")
      warnings.push(`第 ${i + 1} 张请求 ${p.requestedSize}，实际返回 ${actual}，已保留真实像素。`);
    const frame = p.frames?.[i] || { textMode: "none", texts: [], layout: "none" };
    const name = `image-${i + 1}.png`;
    if (p.skillId === "detail") {
      const square = await sharp(source, OPTIONS).rotate().resize(750, 750, { fit: "cover" }).png().toBuffer();
      await fs.writeFile(path.join(out, name), square);
      const caption = detailCaption(captionTexts(frame), accent);
      const height = 750 + (caption?.height || 0);
      const moduleName = `module-${i + 1}.png`;
      await sharp({ create: { width: 750, height, channels: 3, background: "#ffffff" } })
        .composite([{ input: square, top: 0, left: 0 }, ...(caption ? [{ input: caption.svg, top: 750, left: 0 }] : [])])
        .png()
        .toFile(path.join(out, moduleName));
      await add(moduleName, "module", i);
      modules.push({ name: moduleName, height });
      continue;
    }
    const dims = p.providerMode === "api" || p.operation === "upscale" ? [meta.width, meta.height] : canvasSize(p.size);
    const base = await sharp(source, OPTIONS).rotate().resize(...dims, { fit: "cover" }).png().toBuffer();
    if (frame.textMode === "overlay" && frame.texts.length)
      await overlayTexts(base, { layout: frame.layout, texts: frame.texts, accent }, path.join(out, name));
    else await fs.writeFile(path.join(out, name), base);
    await add(name, "image", i);
  }
  if (p.skillId === "detail") {
    const total = modules.reduce((h, m) => h + m.height, 0);
    let top = 0;
    await sharp({ create: { width: 750, height: total, channels: 3, background: "#ffffff" } })
      .composite(modules.map((m) => { const layer = { input: path.join(out, m.name), left: 0, top }; top += m.height; return layer; }))
      .png()
      .toFile(path.join(out, "detail-long.png"));
    await add("detail-long.png", "long", null);
  }
  const manifest = {
    version: 2,
    exportId,
    jobId: job.id,
    sourceId: job.sourceId,
    productName: p.productName,
    generatedAt: new Date().toISOString(),
    assets,
    frames: p.frames || [],
    textCheck,
    generation: { mode: p.providerMode || "codex", model: p.imageModel || null, requestedSize: p.requestedSize || null },
    warnings,
  };
  await fs.writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
