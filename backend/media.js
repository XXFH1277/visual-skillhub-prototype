import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./store.js";

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

function textSvg(title, body, color) {
  // Conservative character wrapping leaves generous room for CJK and Latin text.
  const wrap = (s, n) =>
    Array.from(s).reduce((a, c, i) => {
      if (i % n === 0) a.push("");
      a[a.length - 1] += c;
      return a;
    }, []);
  const titles = wrap(title, 16);
  const lines = wrap(body, 28);
  if (titles.length > 2 || lines.length > 4)
    throw new AppError("模块文案过长，请缩短标题或卖点");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="750" height="300"><rect width="750" height="300" fill="#ffffff"/><rect x="42" y="36" width="6" height="42" fill="${color}"/><g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" fill="#17202c">${titles.map((s, i) => `<text x="68" y="${70 + i * 46}" font-size="36" font-weight="600">${xml(s)}</text>`).join("")}${lines.map((s, i) => `<text x="48" y="${titles.length * 46 + 70 + i * 32}" font-size="23">${xml(s)}</text>`).join("")}</g></svg>`,
  );
}

export async function deliver(job, dir) {
  // Immutable export revisions: a failed re-layout cannot corrupt the last delivery.
  const exportId = "exports-" + randomUUID();
  const out = path.join(dir, exportId);
  await fs.mkdir(out, { recursive: true });
  const assets = [];
  const warnings = [];
  const sourceDimensions = [];
  const add = async (name, role) => {
    const file = path.join(out, name),
      bytes = await fs.readFile(file);
    const meta = await sharp(bytes, OPTIONS).metadata();
    assets.push({
      name,
      role,
      width: meta.width,
      height: meta.height,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  };
  for (let i = 0; i < job.params.count; i++) {
    const source = await regularFile(dir, `result-${i + 1}.png`);
    const meta = await sharp(source, OPTIONS).metadata();
    if (
      !["png", "jpeg", "webp"].includes(meta.format) ||
      (meta.pages || 1) > 1 ||
      meta.width < 256 ||
      meta.height < 256
    )
      throw new Error("生成的图片尺寸或格式不符合要求");
    const actualSize = `${meta.width}x${meta.height}`;
    sourceDimensions.push(actualSize);
    if (job.params.requestedSize && actualSize !== job.params.requestedSize)
      warnings.push(
        `第 ${i + 1} 张请求 ${job.params.requestedSize}，实际返回 ${actualSize}。已保留真实像素，未放大为请求尺寸。`,
      );
    const name = `image-${i + 1}.png`;
    const dimensions =
      job.params.skillId === "detail"
        ? [750, 750]
        : job.params.providerMode === "api"
          ? [meta.width, meta.height]
          : { "1:1": [1024, 1024], "3:4": [768, 1024], "16:9": [1344, 756] }[
              job.params.size
            ];
    await sharp(source, OPTIONS)
      .rotate()
      .resize(...dimensions, { fit: "contain", background: "#ffffff" })
      .png()
      .toFile(path.join(out, name));
    if (job.params.skillId === "detail") {
      if (job.params.providerMode === "api") {
        const originalName = `original-${i + 1}.png`;
        await fs.copyFile(source, path.join(out, originalName));
        await add(originalName, "original");
      }
      const module = job.params.modules[i];
      const panel = textSvg(module.title, module.body, job.params.brandColor);
      const image = await fs.readFile(path.join(out, name));
      const moduleName = `module-${i + 1}.png`;
      await sharp({
        create: {
          width: 750,
          height: 1050,
          channels: 3,
          background: "#ffffff",
        },
      })
        .composite([
          { input: image, top: 0, left: 0 },
          { input: panel, top: 750, left: 0 },
        ])
        .png()
        .toFile(path.join(out, moduleName));
      await add(moduleName, "module");
    } else await add(name, "image");
  }
  if (job.params.skillId === "detail") {
    const moduleAssets = assets.filter((a) => a.role === "module");
    await sharp({
      create: {
        width: 750,
        height: 1050 * moduleAssets.length,
        channels: 3,
        background: "#ffffff",
      },
    })
      .composite(
        moduleAssets.map((a, i) => ({
          input: path.join(out, a.name),
          left: 0,
          top: i * 1050,
        })),
      )
      .png()
      .toFile(path.join(out, "detail-long.png"));
    await add("detail-long.png", "long-preview");
  }
  const manifest = {
    version: 1,
    exportId,
    jobId: job.id,
    sourceId: job.sourceId,
    sourceAsset: job.params.sourceAsset || null,
    sourceExportId: job.params.sourceExportId || null,
    productName: job.params.productName,
    poster: job.params.poster || null,
    platform: job.params.platform,
    generatedAt: new Date().toISOString(),
    assets,
    generation: {
      mode: job.params.providerMode || "codex",
      model: job.params.imageModel || null,
      requestedSize: job.params.requestedSize || null,
      sourceDimensions,
    },
    workflow: job.params.workflow || null,
    warnings,
    checks: { decodable: true, exactCount: true, dimensions: true },
    reviewRequired: [
      ...(job.params.skillId === "interior"
        ? [
            "请核对建筑结构、门窗、梁柱、透视、保留对象与改造范围；效果图不是施工图",
          ]
        : [
            "请核对商品外观、Logo 和细节是否与原图一致",
            "请按实际发布平台确认尺寸与图片规则",
          ]),
      ...(job.params.skillId === "poster"
        ? [
            "请逐项核对海报中文字、价格、日期与联系方式，图片解码检查不代表文字校对通过",
          ]
        : []),
    ],
    modules: job.params.modules || [],
  };
  await fs.writeFile(
    path.join(out, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}
