import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import sharp from "sharp";
import { AppError } from "./errors.js";
import { sendImage } from "./preview.js";
import { BOX_TYPES, FACES, cleanSize, mainFace, faceSizes } from "../shared/boxes.js";
import { cleanLabel, labelSvg } from "../shared/label.js";
import { aspectFor } from "./packaging.js";

// 包装盒：一个正面设计 + 盒型和尺寸 + 其余各面（程序排 / AI 画 / 商家上传）+ 食品标签。
// The 3D preview and the dieline are drawn in the browser from shared/boxes.js.
const FACE_BRIEF = {
  back: "包装背面的平面设计稿。中间偏下留出一块干净的浅色矩形区域（约占画面 45%），之后由程序把食品标签排进去，这块区域里不要放任何文字和图案；区域外延续正面的底纹和图形。",
  right: "包装侧面的平面设计稿（窄长的一面）。竖排品牌名或品名，配少量正面里的图形元素，底色和底纹与正面连贯。",
  top: "包装顶面的平面设计稿。品牌名或品名居中，配一个小图形，底色和底纹与正面连贯。",
};

export function registerBoxes({ app, store, dataDir, jobsDir, normalizeUpload, regularFile, admission, createJob }) {
  const root = path.join(dataDir, "boxes");
  fs.mkdirSync(root, { recursive: true });
  store.db.exec("CREATE TABLE IF NOT EXISTS boxes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source_key TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  store.db.exec("CREATE INDEX IF NOT EXISTS boxes_user ON boxes(user_id, source_key)");
  const dirOf = (id) => path.join(root, id);
  const read = (id, user) => {
    const r = store.db.prepare("SELECT * FROM boxes WHERE id=?").get(id);
    if (!r || r.user_id !== user.id) throw new AppError("这个包装不存在", 404);
    return { id: r.id, ...JSON.parse(r.data), createdAt: r.created_at, updatedAt: r.updated_at };
  };
  const save = (b) => {
    const { id, createdAt, updatedAt, ...data } = b;
    store.db.prepare("UPDATE boxes SET data=?, updated_at=? WHERE id=?").run(JSON.stringify(data), new Date().toISOString(), id);
    return b;
  };
  const fileUrl = (b, name) => `/api/boxes/${b.id}/files/${encodeURIComponent(name)}?v=${encodeURIComponent(b.updatedAt || "")}`;
  const jobImage = (job) => {
    const asset = job?.status === "succeeded" && job.manifest?.assets?.find((a) => a.role === "image");
    return asset ? path.join(jobsDir, job.id, job.manifest.exportId, asset.name) : null;
  };
  // What each face shows right now.
  function view(b) {
    const faces = {};
    for (const k of Object.keys(FACES)) {
      const f = b.faces?.[k] || { kind: "auto" };
      if (f.kind === "ai") {
        const job = store.get(f.jobId);
        const done = job?.status === "succeeded" && job.manifest?.assets?.find((a) => a.role === "image");
        faces[k] = { kind: "ai", status: job?.status || "failed", error: job?.status === "failed" ? job.error : null, url: done ? `/api/jobs/${job.id}/files/${encodeURIComponent(done.name)}` : null, jobId: f.jobId };
      } else if (f.file) faces[k] = { kind: f.kind, url: fileUrl(b, f.file) };
      else faces[k] = { kind: "auto" };
    }
    return { ...b, faces, typeName: BOX_TYPES[b.type].name, main: mainFace(b.type, b.size) };
  }

  // Start a box from a finished design (a picture of a packaging job, or a product's chosen front).
  app.post("/api/boxes", async (req, res) => {
    const body = req.body || {};
    let file, key, defaults = {};
    if (body.jobId) {
      const job = store.get(String(body.jobId));
      if (!job || job.userId !== req.user.id) throw new AppError("作品不存在", 404);
      const asset = job.manifest?.assets?.find((a) => a.name === body.asset && ["image", "module"].includes(a.role));
      if (!asset) throw new AppError("这张图还没出好");
      file = path.join(jobsDir, job.id, job.manifest.exportId, asset.name);
      key = `job:${job.id}/${asset.name}`;
      const form = job.params.packForm;
      defaults = { type: BOX_TYPES[form] ? form : "tuck", size: job.params.packSize, name: job.params.analysis?.product || job.params.productName, palette: job.params.direction?.palette };
    } else if (body.suiteId) {
      const r = store.db.prepare("SELECT user_id, data FROM suites WHERE id=?").get(String(body.suiteId));
      if (!r || r.user_id !== req.user.id) throw new AppError("这个商品不存在", 404);
      const s = JSON.parse(r.data);
      file = path.join(dataDir, "suites", String(body.suiteId), "pack-front.png");
      if (!s.packaging?.front || !fs.existsSync(file)) throw new AppError("先选一个包装正面");
      key = `suite:${body.suiteId}/${s.packaging.front}`;
      const box = s.packaging.box || {};
      const cm = (v) => Math.round(Number(v) * 10 + 5);
      defaults = {
        type: s.packaging.kind === "gift" ? "lid" : "carton",
        size: box.l ? { l: cm(Math.max(box.l, box.w)), w: cm(Math.min(box.l, box.w)), h: cm(box.h) } : null,
        name: s.profile?.name,
        palette: s.look?.palette || s.profile?.palette,
        label: s.label || { name: s.profile?.name, spec: s.profile?.spec, origin: s.profile?.origin, storage: s.profile?.storage },
        brand: s.packaging.brand,
      };
    } else throw new AppError("从哪张设计开始？");
    const old = store.db.prepare("SELECT id FROM boxes WHERE user_id=? AND source_key=?").get(req.user.id, key);
    if (old) return res.json(view(read(old.id, req.user)));
    const id = randomUUID();
    await fsp.mkdir(dirOf(id), { recursive: true });
    await fsp.copyFile(file, path.join(dirOf(id), "front.png"));
    const type = BOX_TYPES[body.type] ? body.type : defaults.type;
    const main = BOX_TYPES[type].main;
    const data = {
      type,
      size: cleanSize(type, body.size || defaults.size || {}),
      name: String(defaults.name || "").slice(0, 30),
      brand: String(defaults.brand || "").slice(0, 16),
      palette: Array.isArray(defaults.palette) ? defaults.palette.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 4) : [],
      faces: { [main]: { kind: "design", file: "front.png" } },
      label: cleanLabel({ ...(defaults.label || {}), name: defaults.label?.name || defaults.name || "" }),
      labelOn: true,
    };
    const now = new Date().toISOString();
    store.db.prepare("INSERT INTO boxes(id,user_id,source_key,data,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, req.user.id, key, JSON.stringify(data), now, now);
    res.status(201).json(view(read(id, req.user)));
  });
  app.get("/api/boxes", (req, res) => {
    const rows = store.db.prepare("SELECT id, data, updated_at FROM boxes WHERE user_id=? ORDER BY updated_at DESC LIMIT 30").all(req.user.id);
    res.json({ boxes: rows.map((r) => ({ id: r.id, ...(({ type, name }) => ({ type, name, typeName: BOX_TYPES[type].name }))(JSON.parse(r.data)), updatedAt: r.updated_at })) });
  });
  app.get("/api/boxes/:id", (req, res) => res.json(view(read(req.params.id, req.user))));
  app.post("/api/boxes/:id", (req, res) => {
    const b = read(req.params.id, req.user);
    const body = req.body || {};
    if (BOX_TYPES[body.type] && body.type !== b.type) {
      // The designed face moves to the new box's main face.
      const design = Object.entries(b.faces).find(([, f]) => f.kind === "design");
      if (design) {
        delete b.faces[design[0]];
        b.faces[BOX_TYPES[body.type].main] = design[1];
      }
      b.type = body.type;
      b.size = cleanSize(b.type, body.size || BOX_TYPES[b.type].size);
    } else if (body.size) b.size = cleanSize(b.type, body.size);
    if (typeof body.name === "string") b.name = body.name.trim().slice(0, 30);
    if (typeof body.brand === "string") b.brand = body.brand.trim().slice(0, 16);
    if (Array.isArray(body.palette)) b.palette = body.palette.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 4);
    if (body.label) b.label = cleanLabel(body.label);
    if (typeof body.labelOn === "boolean") b.labelOn = body.labelOn;
    // A face back to the program's layout.
    if (FACES[body.reset] && b.faces[body.reset]?.kind !== "design") delete b.faces[body.reset];
    res.json(view(read(save(b).id, req.user)));
  });
  const faceUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2 },
    fileFilter: (_req, file, done) => done(["image/png", "image/jpeg", "image/webp"].includes(file.mimetype) ? null : new AppError("只支持 PNG、JPEG 和 WebP"), true),
  }).single("image");
  app.post("/api/boxes/:id/faces/:face", faceUpload, async (req, res) => {
    const b = read(req.params.id, req.user);
    const face = req.params.face;
    if (!FACES[face]) throw new AppError("没有这个面");
    if (!req.file) throw new AppError("请选一张图");
    const name = `face-${face}-${Date.now()}.png`;
    await normalizeUpload(req.file.buffer, path.join(dirOf(b.id), name));
    b.faces[face] = { kind: b.faces[face]?.kind === "design" ? "design" : "upload", file: name };
    res.json(view(read(save(b).id, req.user)));
  });
  app.get("/api/boxes/:id/files/:name", async (req, res) => {
    const b = read(req.params.id, req.user);
    await sendImage(req, res, await regularFile(dirOf(b.id), req.params.name), dataDir);
  });
  // AI draws the other faces from the chosen front, one picture each at that face's own ratio.
  app.post("/api/boxes/:id/ai-faces", admission, async (req, res) => {
    const b = read(req.params.id, req.user);
    const main = BOX_TYPES[b.type].main;
    const sizes = faceSizes(b.type, b.size);
    const dims = Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, [v.w, v.h]]));
    const wanted = (Array.isArray(req.body?.faces) ? req.body.faces : Object.keys(FACE_BRIEF)).filter((f) => FACE_BRIEF[f] && f !== main && dims[f]);
    if (!wanted.length) throw new AppError("没有要画的面");
    const design = b.faces[main]?.file || "front.png";
    const made = [];
    for (const face of wanted) {
      const [fw, fh] = dims[face];
      const params = {
        version: 3,
        skillId: "packaging",
        productName: `${b.name || "包装"} · ${FACES[face]}`,
        size: aspectFor(fw, fh),
        count: 1,
        frames: [{ title: FACES[face], layout: "none", textMode: "none", texts: [], scene: `${FACE_BRIEF[face]}这个面的实际比例约 ${fw}:${fh}（宽:高），设计要能裁成这个比例。${b.brand ? `品牌名：${b.brand}。` : ""}${b.name ? `品名：${b.name}。` : ""}`, photos: [design], photoUse: "packface" }],
        opener: "包装盒其中一个面的平面设计稿（不是立体效果图）：满版铺满画面，画面边缘就是这个面的边缘，四周 3 毫米内不放文字。",
        hasMainImage: false,
        refCount: 0,
        styleRef: null,
        inputs: [design],
        boxId: b.id,
        brandColor: b.palette?.[0] || "#e8541e",
      };
      const holder = { status: (code) => ({ json: (job) => (holder.result = { code, job }) }) };
      // One request, several jobs: each face gets its own submission key.
      const one = { body: req.body, user: req.user, get: (h) => (/idempotency-key/i.test(h) && req.get(h) ? `${req.get(h)}:${face}` : req.get(h)) };
      await createJob(one, holder, params, dirOf(b.id));
      made.push([face, holder.result.job.id]);
    }
    const latest = read(b.id, req.user);
    for (const [face, jobId] of made) {
      latest.faces[face] = { kind: "ai", jobId };
      // Both long sides of a box share one design.
      if (face === "right") latest.faces.left = { kind: "ai", jobId };
    }
    res.status(202).json(view(read(save(latest).id, req.user)));
  });

  // 食品标签：打印用 300dpi PNG。
  app.post("/api/labels/png", async (req, res) => {
    const { svg } = labelSvg(req.body?.label || {}, { pxPerMm: 300 / 25.4 });
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    res.set({ "Content-Type": "image/png", "Content-Disposition": 'attachment; filename="label.png"', "Cache-Control": "no-store" });
    res.send(png);
  });
  return { jobImage };
}
