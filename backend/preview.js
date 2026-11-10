import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { AppError } from "./errors.js";

const pending = new Map();
const lanes = [Promise.resolve(), Promise.resolve()];
let nextLane = 0;

// Call only after authenticating the request and authorizing the original file.
export async function sendImage(req, res, file, dataDir, { mutable = false } = {}) {
  const size = req.query.thumb;
  if (!size || req.query.download === "1") return res.sendFile(file, { dotfiles: "allow" });
  if (!["320", "720"].includes(size)) throw new AppError("缩略图尺寸无效");
  const stat = await fs.stat(file);
  const tag = createHash("sha256").update(JSON.stringify([1, file, stat.size, stat.mtimeMs, size])).digest("hex");
  const folder = path.join(dataDir, "previews", tag.slice(0, 2));
  const dest = path.join(folder, tag + ".webp");
  if (!(await fs.stat(dest).catch(() => null))) {
    if (!pending.has(dest)) {
      const lane = nextLane++ % lanes.length;
      const work = lanes[lane].then(async () => {
        await fs.mkdir(folder, { recursive: true });
        const tmp = dest + "." + randomUUID() + ".tmp";
        try {
          await sharp(file, { limitInputPixels: 40000000 }).rotate()
            .resize({ width: Number(size), height: Number(size) * 2, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 74, effort: 3 }).toFile(tmp);
          await fs.rename(tmp, dest);
        } finally { await fs.rm(tmp, { force: true }); }
      });
      pending.set(dest, work);
      lanes[lane] = work.catch(() => {}).finally(() => pending.delete(dest));
    }
    await pending.get(dest);
  }
  res.vary("Cookie");
  res.set("Cache-Control", mutable ? "private, no-cache" : "private, max-age=86400");
  res.set("ETag", '"' + tag + '"');
  return res.sendFile(dest, { dotfiles: "allow", cacheControl: false });
}
