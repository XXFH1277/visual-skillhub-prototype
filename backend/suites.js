import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { AppError } from "./errors.js";
import { importNote } from "./importers.js";
import { labelPhotos, buildProfile, normalizeProfile, writeNote, planFrames, proposeLooks } from "./suite-ai.js";
import { STYLES } from "../shared/styles.js";
import { noteDocx } from "./docx-note.js";
import { caseById, CASES } from "../shared/cases.js";
import { SECTION_TYPES, SECTION_MODES, PHOTO_ROLES, QUICK, scanRisky } from "../shared/suite.js";

// "商品全套": one product → profile → note → product images → detail page.
// Each AI step is one multimodal call; image generation reuses the job queue.
export function registerSuites({ app, store, users, styles, dataDir, textAI, normalizeUpload, regularFile, admission, createJob, jobsDir }) {
  const root = path.join(dataDir, "suites");
  fs.mkdirSync(root, { recursive: true });
  store.db.exec(`CREATE TABLE IF NOT EXISTS suites (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  users.adopt("suites");
  // Every /api/suites/:id/... route only ever sees the caller's own products.
  app.use("/api/suites/:id", (req, _res, next) => {
    const r = store.db.prepare("SELECT user_id FROM suites WHERE id=?").get(req.params.id);
    if (!r || r.user_id !== req.user.id) throw new AppError("这个商品不存在", 404);
    next();
  });
  const read = (id) => {
    const r = store.db.prepare("SELECT * FROM suites WHERE id=?").get(id);
    if (!r) throw new AppError("这个商品不存在", 404);
    return { id: r.id, ...JSON.parse(r.data), createdAt: r.created_at, updatedAt: r.updated_at };
  };
  const save = (s) => {
    const { id, createdAt, updatedAt, ...data } = s;
    store.db.prepare("UPDATE suites SET data=?, updated_at=? WHERE id=?").run(JSON.stringify(data), new Date().toISOString(), id);
    return read(id);
  };
  // Interrupted AI steps after a restart.
  for (const r of store.db.prepare("SELECT id, data FROM suites").all()) {
    const d = JSON.parse(r.data);
    let changed = false;
    for (const [k, t] of Object.entries(d.tasks || {}))
      if (t.status === "running") {
        d.tasks[k] = { status: "failed", error: "服务重启中断了，请重试" };
        changed = true;
      }
    if (changed) store.db.prepare("UPDATE suites SET data=? WHERE id=?").run(JSON.stringify(d), r.id);
  }
  const dirOf = (id) => path.join(root, id);
  const imgPaths = (s, list) => list.map((p) => path.join(dirOf(s.id), p.file));
  const view = (s) => ({
    ...s,
    palette: s.look?.palette?.length >= 3 ? s.look.palette : s.profile?.palette,
    text: undefined,
    hasText: !!s.text,
    risky: scanRisky([s.note?.text, s.profile?.copy, JSON.stringify(s.profile || {})].join("\n")),
    jobs: Object.fromEntries(Object.entries(s.jobs || {}).map(([k, id]) => [k, id && store.get(id) ? summary(store.get(id)) : null])),
  });
  const summary = (j) => ({ id: j.id, status: j.status, phase: j.phase, error: j.error, cost: j.cost, manifest: j.manifest, updatedAt: j.updatedAt, frames: j.params.frames, tweaks: store.tweaksOf(j.id) });

  // Run one AI step in the background and record its state on the suite.
  let running = 0;
  function task(id, name, fn) {
    if (running >= 3) throw new AppError("AI 正在处理其他商品，请稍后再试", 429);
    const s = read(id);
    if (s.tasks?.[name]?.status === "running") return s;
    s.tasks = { ...(s.tasks || {}), [name]: { status: "running", startedAt: Date.now() } };
    save(s);
    running++;
    (async () => {
      try {
        if (!textAI.describe().ready) throw new Error("未配置 Kimi，请在 .env 填写 KIMI_API_KEY");
        const latest = read(id);
        await fn(latest);
        latest.tasks[name] = { status: "done", at: Date.now() };
        save(latest);
      } catch (error) {
        const latest = read(id);
        latest.tasks[name] = { status: "failed", error: error.message };
        save(latest);
      } finally {
        running--;
      }
    })();
    return read(id);
  }

  const AI_LABEL = "烹饪示意 图片仅供参考";
  // Within a set, prefer photos used least so far: different pictures start from different shots.
  const pickPhotos = (s, roles, n = 2, used = new Map()) => {
    const usable = s.photos.filter((p) => p.usable && p.role !== "design");
    const chosen = [];
    for (const role of roles) {
      const pool = usable.filter((p) => p.role === role && !chosen.includes(p));
      pool.sort((a, b) => (used.get(a.file) || 0) - (used.get(b.file) || 0));
      for (const p of pool) if (chosen.length < n) chosen.push(p);
    }
    for (const p of chosen) used.set(p.file, (used.get(p.file) || 0) + 1);
    return chosen;
  };
  // Builtin and admin-shared styles that fit product shots / detail pages.
  const styleCandidates = () =>
    styles
      .list({ id: "", role: "user" })
      .filter((x) => x.status === "ready" && !x.types.includes("interior") && x.types.some((t) => ["main", "scene", "selling", "detail"].includes(t)));
  async function ensureLooks(s) {
    if (s.looks?.length) return;
    const rep = ["package", "product", "cooked", "origin"].map((r) => s.photos.find((p) => p.role === r && p.usable && !p.ai)).filter(Boolean);
    s.looks = await proposeLooks(textAI, s.profile, styleCandidates(), imgPaths(s, rep));
    if (!s.look && s.looks.length) s.look = s.looks[0];
  }
  const steps = {
    async looks(s) {
      s.looks = null;
      await ensureLooks(s);
    },
    async profile(s) {
      if (s.photos.length) {
        const labels = await labelPhotos(textAI, imgPaths(s, s.photos));
        s.photos = s.photos.map((p, i) => ({ ...p, ...labels[i] }));
        save(s);
      }
      const rep = ["package", "product", "cooked", "origin", "detail", "compare"]
        .map((r) => s.photos.find((p) => p.role === r && p.usable))
        .filter(Boolean)
        .slice(0, 6);
      s.profile = await buildProfile(textAI, { text: s.text, answers: s.answers, photos: s.photos, images: imgPaths(s, rep) });
      if (!s.caseId) s.caseId = s.profile.category === "生鲜水产" ? "seafood-gift" : "general";
      s.sections = defaultSections(s);
      s.shots = null;
    },
    async note(s) {
      s.note = await writeNote(textAI, s.profile, { style: s.noteStyle || "私域" });
    },
    async shots(s) {
      await ensureLooks(s);
      const c = caseById(s.caseId);
      const used = new Map();
      const items = c.shots.map((shot) => {
        const photos = pickPhotos(s, shot.photos, 2, used);
        return { id: shot.id, title: shot.title, brief: shot.brief, photos: photos.map((p) => `${PHOTO_ROLES[p.role]}：${p.desc}`), files: photos.map((p) => p.file) };
      });
      const planned = await planFrames(textAI, s.profile, items.filter((i) => i.files.length).map(({ files, ...rest }) => rest), { kind: "product", look: s.look });
      s.shots = items.map((it) => {
        const f = planned.find((p) => p.id === it.id);
        return { id: it.id, title: it.title, enabled: !!it.files.length, photos: it.files, texts: f?.texts || [], scene: f?.scene || it.brief, missing: it.files.length ? "" : `缺少${it.title}需要的实拍图` };
      });
    },
    async detail(s) {
      await ensureLooks(s);
      const ai = s.sections.filter((x) => x.mode === "ai");
      const used = new Map();
      const items = ai.map((x) => {
        const photos = pickPhotos(s, SECTION_TYPES[x.type].photo.length ? SECTION_TYPES[x.type].photo : ["product"], 2, used);
        x.photos = photos.map((p) => p.file);
        return { id: x.id, title: SECTION_TYPES[x.type].name, brief: sectionBrief(x.type, s.profile), photos: photos.map((p) => `${PHOTO_ROLES[p.role]}：${p.desc}`) };
      });
      const planned = items.length ? await planFrames(textAI, s.profile, items, { kind: "detail", look: s.look }) : [];
      for (const x of ai) {
        const f = planned.find((p) => p.id === x.id);
        x.texts = f?.texts || [];
        x.scene = f?.scene || "";
      }
    },
  };
  function sectionBrief(type, p) {
    return {
      hero: `首屏：${p.name}，包装和实物同框，大标题写品名，副标题一句概念`,
      why: `为什么是${p.origin || "这里"}：产地实景配大标题`,
      origin: `产地/货源实景：${p.shipFrom || p.origin}`,
      compare: "对比：左右对比两种，标注差异",
      pick: "怎么挑：特写关键部位并标注",
      material: "选材与细节：近距离质感特写",
      usage: `吃法/用法：${p.usage?.headline || "成品展示"}`,
      pack: "包装与收货：独立包装 + 礼盒/保温箱，标注包装方式",
    }[type] || "";
  }
  function defaultSections(s) {
    const c = caseById(s.caseId);
    const p = s.profile || {};
    const empty = { why: !p.why?.headline, compare: !p.compare?.rows?.length, pick: !p.pick?.points?.length, faq: !p.faq?.headline, notice: !p.notice?.length };
    return c.sections.map((x, i) => {
      const hasPhoto = SECTION_TYPES[x.type].photo.length === 0 || pickPhotos(s, SECTION_TYPES[x.type].photo, 1).length > 0;
      let mode = x.mode;
      if (mode === "tpl" && empty[x.type]) mode = "off";
      if ((mode === "ai" || mode === "photo") && !hasPhoto) mode = SECTION_TYPES[x.type].modes.includes("tpl") ? "tpl" : "off";
      return { id: `${x.type}-${i}`, type: x.type, mode, photos: [], texts: [], scene: "" };
    });
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024, files: 31, fields: 10, fieldSize: 20000 },
  }).fields([
    { name: "photos", maxCount: 30 },
    { name: "note", maxCount: 1 },
  ]);
  async function addPhotos(s, buffers, source) {
    const dir = dirOf(s.id);
    for (const buf of buffers) {
      if (s.photos.length >= 40) break;
      const file = `photo-${s.photos.length + 1}-${randomUUID().slice(0, 6)}.png`;
      try {
        await normalizeUpload(buf, path.join(dir, file));
        s.photos.push({ file, role: "other", desc: "", usable: true, source });
      } catch {}
    }
  }

  app.get("/api/suite-meta", (_req, res) => res.json({ cases: CASES, sections: SECTION_TYPES, modes: SECTION_MODES, roles: PHOTO_ROLES, quick: QUICK }));
  app.get("/api/suites", (req, res) =>
    res.json({
      suites: store.db
        .prepare("SELECT * FROM suites WHERE user_id=? ORDER BY updated_at DESC LIMIT 100")
        .all(req.user.id)
        .map((r) => {
          const d = JSON.parse(r.data);
          return { id: r.id, name: d.profile?.name || d.name || "未命名商品", cover: d.photos?.[0]?.file || null, updatedAt: r.updated_at, tasks: d.tasks };
        }),
    }),
  );
  app.post("/api/suites", upload, async (req, res) => {
    const photos = req.files?.photos || [];
    const noteFile = req.files?.note?.[0];
    const pasted = typeof req.body?.text === "string" ? req.body.text.slice(0, 20000) : "";
    let answers = {};
    try {
      answers = req.body?.answers ? JSON.parse(req.body.answers) : {};
    } catch {
      throw new AppError("问答格式错误");
    }
    const name = String(answers.name || "").slice(0, 40);
    if (!photos.length && !noteFile) throw new AppError("请至少上传一张实拍图");
    const caseId = CASES.some((c) => c.id === req.body?.caseId) ? req.body.caseId : "";
    const id = randomUUID();
    await fsp.mkdir(dirOf(id), { recursive: true });
    const now = new Date().toISOString();
    const s = { id, name, caseId, hasNote: !!noteFile, answers, text: pasted, photos: [], tasks: {}, jobs: {}, profile: null, note: null, shots: null, sections: [] };
    try {
      if (noteFile) {
        const imported = await importNote(noteFile);
        s.text = [imported.text, pasted].filter(Boolean).join("\n\n").slice(0, 30000);
        await addPhotos(s, imported.images, "note");
      }
      await addPhotos(s, photos.map((f) => f.buffer), "upload");
      if (!s.photos.length) throw new AppError("没有读到可用的图片，请单独上传实拍图");
      const { id: _id, ...data } = s;
      store.db
        .prepare("INSERT INTO suites(id,data,created_at,updated_at,user_id) VALUES(?,?,?,?,?)")
        .run(id, JSON.stringify(data), now, now, req.user.id);
    } catch (error) {
      await fsp.rm(dirOf(id), { recursive: true, force: true });
      throw error;
    }
    task(id, "profile", steps.profile);
    res.status(202).json(view(read(id)));
  });
  app.get("/api/suites/:id", (req, res) => res.json(view(read(req.params.id))));
  app.get("/api/suites/:id/photo/:file", async (req, res) => {
    const s = read(req.params.id);
    if (!s.photos.some((p) => p.file === req.params.file)) throw new AppError("图片不存在", 404);
    res.sendFile(await regularFile(dirOf(s.id), req.params.file), { dotfiles: "allow" });
  });
  app.post("/api/suites/:id/photos", upload, async (req, res) => {
    const s = read(req.params.id);
    await addPhotos(s, (req.files?.photos || []).map((f) => f.buffer), "upload");
    save(s);
    res.json(view(read(s.id)));
  });
  // Merchant edits: profile fields, photo roles, case, note text, shots and sections.
  app.post("/api/suites/:id", (req, res) => {
    const s = read(req.params.id);
    const b = req.body || {};
    if (b.profile) s.profile = normalizeProfile({ ...s.profile, ...b.profile });
    if (Array.isArray(b.photos))
      for (const edit of b.photos) {
        const p = s.photos.find((x) => x.file === edit?.file);
        if (!p) continue;
        if (Object.hasOwn(PHOTO_ROLES, edit.role)) p.role = edit.role;
        if (typeof edit.usable === "boolean") p.usable = edit.usable;
      }
    if (b.caseId && CASES.some((c) => c.id === b.caseId) && b.caseId !== s.caseId) {
      s.caseId = b.caseId;
      s.sections = defaultSections(s);
      s.shots = null;
    }
    if (typeof b.aiLabel === "boolean") s.aiLabel = b.aiLabel;
    if (b.note && typeof b.note.text === "string") s.note = { title: String(b.note.title || "").slice(0, 40), text: b.note.text.slice(0, 3000) };
    if (Array.isArray(b.shots) && s.shots)
      s.shots = s.shots.map((x) => {
        const e = b.shots.find((y) => y?.id === x.id) || {};
        return { ...x, enabled: typeof e.enabled === "boolean" ? e.enabled : x.enabled, texts: Array.isArray(e.texts) ? cleanTexts(e.texts) : x.texts, scene: typeof e.scene === "string" ? e.scene.slice(0, 800) : x.scene };
      });
    if (Array.isArray(b.sections))
      s.sections = b.sections
        .map((e) => {
          const x = s.sections.find((y) => y.id === e?.id);
          if (!x) return null;
          const mode = Object.hasOwn(SECTION_MODES, e.mode) && (e.mode === "off" || SECTION_TYPES[x.type].modes.includes(e.mode)) ? e.mode : x.mode;
          return { ...x, mode, texts: Array.isArray(e.texts) ? cleanTexts(e.texts) : x.texts, scene: typeof e.scene === "string" ? e.scene.slice(0, 800) : x.scene, photos: Array.isArray(e.photos) ? e.photos.filter((f) => s.photos.some((p) => p.file === f)).slice(0, 3) : x.photos };
        })
        .filter(Boolean);
    res.json(view(save(s)));
  });
  const cleanTexts = (list) =>
    list
      .slice(0, 6)
      .map((t) => ({ role: ["headline", "sub", "point"].includes(t?.role) ? t.role : "point", text: String(t?.text || "").trim().slice(0, 20) }))
      .filter((t) => t.text);
  const needProfile = (s) => {
    if (!s.profile) throw new AppError("请等商品档案整理完成");
  };
  app.post("/api/suites/:id/profile", (req, res) => res.json(view(task(req.params.id, "profile", steps.profile))));
  app.post("/api/suites/:id/note", (req, res) => {
    const s = read(req.params.id);
    needProfile(s);
    if (req.body?.style) {
      s.noteStyle = req.body.style === "淘宝" ? "淘宝" : "私域";
      save(s);
    }
    res.json(view(task(s.id, "note", steps.note)));
  });
  app.get("/api/suites/:id/note.docx", async (req, res) => {
    const s = read(req.params.id);
    needProfile(s);
    const buf = await noteDocx({ profile: s.profile, note: s.note || (s.profile.copy ? { title: s.profile.name, text: s.profile.copy } : null), photos: s.photos.filter((p) => !p.ai), dir: dirOf(s.id) });
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent((s.profile.name || "商品笔记") + ".docx")}`);
    res.send(buf);
  });
  app.post("/api/suites/:id/shots/plan", (req, res) => {
    const s = read(req.params.id);
    needProfile(s);
    res.json(view(task(s.id, "shots", steps.shots)));
  });
  app.post("/api/suites/:id/detail/plan", (req, res) => {
    const s = read(req.params.id);
    needProfile(s);
    res.json(view(task(s.id, "detail", steps.detail)));
  });

  // Visual system shared by every image of the suite: the merchant's own colors and photos.
  const direction = (s) => {
    const look = s.look;
    if (!look) return plainDirection(s);
    const recipe = STYLES.find((x) => x.id === look.styleId) || styles.get(look.styleId) || {};
    return {
      conceptName: look.conceptName,
      styleName: recipe.name || "",
      story: look.story,
      palette: look.palette?.length ? look.palette : recipe.palette || plainDirection(s).palette,
      props: `${look.props}。商品与包装以商家实拍为准，不改外观`,
      light: look.light,
      camera: look.camera,
      type: look.type,
      avoid: [recipe.avoid, "商品外观被改变、乱码小字、虚构认证标志"].filter(Boolean).join("；"),
      core: recipe.core || "",
    };
  };
  const plainDirection = (s) => ({
    conceptName: "实拍精修",
    styleName: caseById(s.caseId).name,
    story: "以商家实拍图为主体重新布光、构图和排版，真实可信又有设计感",
    palette: s.profile.palette?.length ? s.profile.palette : ["#1d3557", "#e8541e", "#f6efe6"],
    props: "只用实拍图中的真实商品与真实场景；可添加少量与商品相关的道具（冰粒、葱姜、木桌、亚麻布等），不添加不存在的配件",
    light: "明亮自然的商业摄影光，暖调，质感清晰",
    camera: "商品为主体，构图饱满，留出标题区",
    type: "粗黑体中文大标题 + 细线/波浪装饰 + 小字说明，深色信息条，排版规整，像高端电商详情页",
    avoid: "商品外观被改变、乱码小字、虚构认证标志",
    core: "photorealistic e-commerce product photography based on the merchant's real photos, clean premium Chinese typography, warm natural light",
  });
  async function generate(req, res, s, kind) {
    const frames = kind === "shots"
      ? (s.shots || []).filter((x) => x.enabled)
      : s.sections.filter((x) => x.mode === "ai");
    if (!frames.length) throw new AppError(kind === "shots" ? "请先规划商品图" : "详情页没有需要 AI 出图的屏");
    if (frames.some((f) => !f.scene)) throw new AppError("请先让 AI 规划画面");
    const params = {
      version: 3,
      skillId: kind === "shots" ? "product" : "detail",
      productName: `${s.profile.name || "商品"} · ${kind === "shots" ? "商品图" : "详情页"}`,
      size: kind === "shots" ? (req.body?.size === "3:4" ? "3:4" : "1:1") : "3:4",
      count: frames.length,
      frames: frames.map((f) => {
        // Pictures that use an AI-made dish say so on the image.
        const usesAI = f.photos.some((file) => s.photos.find((p) => p.file === file)?.ai);
        const texts = usesAI && s.aiLabel !== false ? [...f.texts, { role: "tag", text: AI_LABEL }] : f.texts;
        return {
        title: f.title || SECTION_TYPES[f.type]?.name || "",
        textMode: texts.length ? "ai" : "none",
        layout: texts.length ? "free" : "none",
        texts,
        scene: f.scene,
        photos: f.photos,
        photoNotes: f.photos.map((file) => {
          const p = s.photos.find((x) => x.file === file);
          return p ? `${PHOTO_ROLES[p.role]}${p.ai ? "（AI 示意图）" : ""}：${p.desc}` : "";
        }),
        ref: f.id,
        };
      }),
      direction: direction(s),
      hasMainImage: false,
      refCount: 0,
      styleRef: null,
      inputs: [...new Set(frames.flatMap((f) => f.photos))],
      suiteId: s.id,
      brandColor: direction(s).palette[1] || "#e8541e",
    };
    const holder = { status: (code) => ({ json: (job) => (holder.result = { code, job }) }) };
    await createJob(req, holder, params, dirOf(s.id));
    const latest = read(s.id);
    latest.jobs = { ...(latest.jobs || {}), [kind]: holder.result.job.id };
    save(latest);
    res.status(holder.result.code).json(holder.result.job);
  }
  app.post("/api/suites/:id/shots/generate", admission, async (req, res) => generate(req, res, read(req.params.id), "shots"));
  app.post("/api/suites/:id/detail/generate", admission, async (req, res) => generate(req, res, read(req.params.id), "detail"));
  // ---- Visual direction: AI suggests 3 from the style library; merchant picks ----
  app.post("/api/suites/:id/looks", (req, res) => {
    const s = read(req.params.id);
    needProfile(s);
    res.json(view(task(s.id, "looks", steps.looks)));
  });
  app.post("/api/suites/:id/look", (req, res) => {
    const s = read(req.params.id);
    const i = req.body?.index;
    if (i === null) s.look = null; // 实拍精修: no library style
    else if (Number.isInteger(i) && s.looks?.[i]) s.look = s.looks[i];
    else throw new AppError("没有这个风格");
    res.json(view(save(s)));
  });

  // ---- Dish pictures for merchants who haven't cooked the new stock yet ----
  const DISH_PLATES = [
    "白瓷圆盘，家常餐桌，俯拍 45 度，暖色自然光",
    "深色粗陶盘，餐厅质感，侧光，浅景深",
    "木托盘配小碗蘸料，生活感摆拍，正侧面",
  ];
  app.post("/api/suites/:id/dish", admission, async (req, res) => {
    const s = read(req.params.id);
    needProfile(s);
    const method = String(req.body?.method || "").trim().slice(0, 20);
    if (!method) throw new AppError("选一种做法，例如清蒸、红烧");
    const count = Math.min(Math.max(Number(req.body?.count) || 2, 1), 3);
    const refs = ["product", "detail", "package"]
      .flatMap((r) => s.photos.filter((p) => p.role === r && p.usable && !p.ai))
      .slice(0, 2);
    if (!refs.length) throw new AppError("先上传一张生鲜/实物照片，AI 才知道食材长什么样");
    const name = s.profile.name || "这种食材";
    const params = {
      version: 3,
      skillId: "product",
      productName: `${name} · 菜品图（${method}）`,
      size: "1:1",
      count,
      frames: Array.from({ length: count }, (_, i) => ({
        title: `${method} · ${i + 1}`,
        textMode: "none",
        layout: "none",
        texts: [],
        scene: `美食摄影：把实拍图里的${name}做成「${method}」的成品菜。食材的品种、形状、颜色、切法必须和实拍一致（看得出是同一种食材），按${method}的常见做法真实呈现：熟透的质感、酱汁和油光、热气。${DISH_PLATES[i % DISH_PLATES.length]}。只放这道菜和少量相关配料，不要包装、不要文字。`,
        photos: refs.map((p) => p.file),
        photoNotes: refs.map((p) => `生鲜实拍（只用来看食材长什么样）：${p.desc}`),
        ref: `dish-${i}`,
      })),
      direction: {
        conceptName: "家常美味",
        story: "让人一看就想吃的真实菜品照片",
        palette: ["#f4ede2", "#c8572b", "#3b2a20"],
        props: "盘子、筷子、少量葱姜蒜辣椒等配料",
        light: "柔和自然光，食物有光泽",
        camera: "近景，菜品占画面主体",
        type: "无文字",
        avoid: "生的食材、塑料感、夸张特效、文字水印",
        core: "appetizing Chinese home-style dish, realistic food photography, natural light, steam, glossy sauce",
      },
      hasMainImage: false,
      refCount: 0,
      styleRef: null,
      inputs: refs.map((p) => p.file),
      suiteId: s.id,
      dishMethod: method,
    };
    const holder = { status: (code) => ({ json: (job) => (holder.result = { code, job }) }) };
    await createJob(req, holder, params, dirOf(s.id));
    const latest = read(s.id);
    latest.jobs = { ...(latest.jobs || {}), dish: holder.result.job.id };
    save(latest);
    res.status(holder.result.code).json(holder.result.job);
  });
  // Put an AI dish picture into the product's photo library.
  app.post("/api/suites/:id/photos/adopt", async (req, res) => {
    const s = read(req.params.id);
    const job = store.get(String(req.body?.jobId || ""));
    if (!job || job.userId !== req.user.id || job.params.suiteId !== s.id || !job.params.dishMethod || job.status !== "succeeded") throw new AppError("这张图不能加入", 404);
    const asset = job.manifest?.assets?.find((a) => a.name === req.body?.asset && a.role === "image");
    if (!asset) throw new AppError("这张图不能加入", 404);
    if (s.photos.some((p) => p.fromJob === `${job.id}/${asset.name}`)) return res.json(view(s));
    if (s.photos.length >= 40) throw new AppError("照片最多 40 张");
    const file = `photo-${s.photos.length + 1}-${randomUUID().slice(0, 6)}.png`;
    await fsp.copyFile(await regularFile(path.join(jobsDir, job.id, job.manifest.exportId), asset.name), path.join(dirOf(s.id), file));
    s.photos.push({ file, role: "cooked", desc: `AI 示意：${job.params.dishMethod || "成品菜"}`, usable: true, ai: true, source: "ai", fromJob: `${job.id}/${asset.name}` });
    res.json(view(save(s)));
  });
  app.delete("/api/suites/:id", async (req, res) => {
    read(req.params.id);
    store.db.prepare("DELETE FROM suites WHERE id=?").run(req.params.id);
    await fsp.rm(dirOf(req.params.id), { recursive: true, force: true });
    res.json({ ok: true });
  });
}
