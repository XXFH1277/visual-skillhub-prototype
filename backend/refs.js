import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

// Internal reference library: standout listings (Taobao, Xiaohongshu, designers' work)
// shown to the image model as style references. Never shown to merchants, never copied:
// the model learns composition, type and finish, not the product, words or shop marks.
export const REF_USES = {
  hero: "首屏 / 主图",
  sell: "卖点大图",
  texture: "肉质 / 切面",
  origin: "产地 / 渔船",
  compare: "我们的 vs 普通的",
  quality: "质检宫格",
  usage: "做法菜品卡",
  pack: "包装 / 冷链",
  info: "商品信息",
  poster: "活动海报",
};
// Which reference a picture of a given kind learns from.
const USE_FOR = {
  hero: ["hero", "poster"], sell: ["sell", "hero"], product: ["quality", "sell"], texture: ["texture", "sell"], spec: ["quality"],
  cooked: ["usage"], usage: ["usage"], origin: ["origin", "hero"], pack: ["pack"], service: ["pack", "info"], normal: ["quality"],
  why: ["origin", "sell"], compare: ["compare"], pick: ["quality"], material: ["texture", "quality"], gift: ["hero"],
};

export function createRefs(dataDir) {
  const dir = path.join(dataDir, "refs");
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, "index.json");
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(indexFile, "utf8"));
    } catch {
      return [];
    }
  };
  const write = (list) => fs.writeFileSync(indexFile, JSON.stringify(list, null, 2));
  return {
    dir,
    list: read,
    file: (name) => (/^ref-[a-z0-9-]+\.jpg$/.test(name) && fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : null),
    async add(buffer, { uses = [], category = "生鲜水产", note = "" } = {}) {
      const file = `ref-${randomUUID().slice(0, 8)}.jpg`;
      await sharp(buffer, { limitInputPixels: 60_000_000 }).rotate().resize(1280, 1280, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 86 }).toFile(path.join(dir, file));
      const entry = { file, uses: uses.filter((u) => Object.hasOwn(REF_USES, u)), category: String(category).slice(0, 12), note: String(note).slice(0, 80), at: new Date().toISOString() };
      write([...read(), entry]);
      return entry;
    },
    remove(name) {
      write(read().filter((r) => r.file !== name));
      fs.rmSync(path.join(dir, name), { force: true });
    },
    // One reference per picture; different pictures of a set rotate through what's there.
    pick(category, kind, taken = new Map()) {
      const wants = USE_FOR[kind] || ["hero"];
      const pool = read().filter((r) => r.category === category && fs.existsSync(path.join(dir, r.file)));
      for (const use of wants) {
        const fit = pool.filter((r) => r.uses.includes(use)).sort((a, b) => (taken.get(a.file) || 0) - (taken.get(b.file) || 0));
        if (fit.length) {
          taken.set(fit[0].file, (taken.get(fit[0].file) || 0) + 1);
          return fit[0].file;
        }
      }
      return null;
    },
  };
}
