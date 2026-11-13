import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./store.js";
import { overlayTexts } from "./render.js";
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


// Return validated, original frame indexes. Never match files from another job.
export async function partialDelivery(job, dir) {
  if (job.params.providerMode !== "api" || !job.params.frames || job.params.count < 2) return null;
  const available = [];
  for (let i = 0; i < job.params.count; i++) {
    try {
      const file = await regularFile(dir, `result-${i + 1}.png`);
      await sharp(file, OPTIONS).stats();
      available.push(i);
    } catch { /* Missing or incomplete output must be regenerated. */ }
  }
  if (!available.length || available.length === job.params.count) return null;
  return deliver(job, dir, available);
}

export async function deliver(job, dir, available = null) {
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
    if (available && !available.includes(i)) continue;
    const source = await regularFile(dir, `result-${i + 1}.png`);
    const meta = await sharp(source, OPTIONS).metadata();
    if (!["png", "jpeg", "webp"].includes(meta.format) || (meta.pages || 1) > 1 || meta.width < 256 || meta.height < 256)
      throw new Error("生成的图片尺寸或格式不符合要求");
    const actual = `${meta.width}x${meta.height}`;
    const native = [meta.width, meta.height];
    const requested = p.requestedSize?.split("x").map(Number);
    const finish4K = p.resolution === "4K" && requested && Math.max(...native) > 2048
      && Math.abs(native[0] * requested[1] / (native[1] * requested[0]) - 1) <= 0.02;
    if (p.requestedSize && actual !== p.requestedSize) {
      const from = actual.replace("x", "×");
      const to = p.requestedSize.replace("x", "×");
      const adjustment = finish4K && requested.some((value, axis) => value > native[axis]) ? "放大导出" : "导出";
      warnings.push(finish4K
        ? `第 ${i + 1} 张原生像素 ${from}，已${adjustment}为 ${to}。`
        : `第 ${i + 1} 张请求 ${to}，实际返回 ${from}，已保留原始像素。`);
    }
    const frame = p.frames?.[i] || { textMode: "none", texts: [], layout: "none" };
    const detail = p.skillId === "detail";
    const dims = finish4K ? requested : p.providerMode === "api" ? native
      : detail ? [750, Math.round(meta.height / meta.width * 750)] : canvasSize(p.size);
    const name = `${detail ? "module" : "image"}-${i + 1}.png`;
    const base = await sharp(source, OPTIONS).rotate().resize(...dims, { fit: "cover" }).png().toBuffer();
    if (frame.textMode === "overlay" && frame.texts.length)
      await overlayTexts(base, { layout: frame.layout, texts: frame.texts, accent }, path.join(out, name));
    else await fs.writeFile(path.join(out, name), base);
    await add(name, detail ? "module" : "image", i);
    if (detail && !available) {
      const file = path.join(out, name);
      const height = Math.round(dims[1] / dims[0] * 750);
      const input = dims[0] === 750 ? file : await sharp(file, OPTIONS).resize(750, height).png().toBuffer();
      modules.push({ input, height });
    }
  }
  if (!available && p.skillId === "detail") {
    const total = modules.reduce((h, m) => h + m.height, 0);
    let top = 0;
    await sharp({ create: { width: 750, height: total, channels: 3, background: "#ffffff" } })
      .composite(modules.map((m) => { const layer = { input: m.input, left: 0, top }; top += m.height; return layer; }))
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
    ...(available ? { missing: Array.from({ length: p.count }, (_, i) => i).filter(i => !available.includes(i)) } : {}),
    warnings,
  };
  await fs.writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
