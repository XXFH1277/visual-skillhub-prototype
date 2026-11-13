import { sendImage } from "./preview.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";

// Merchants' Word notes carry dozens of full-size phone photos; 40MB+ is normal.
export const SUITE_FILE_MB = 100;
import { AppError } from "./errors.js";
import { importNote } from "./importers.js";
import { labelPhotos, buildProfile, normalizeProfile, writeNote, planFrames, proposeLooks } from "./suite-ai.js";
import { STYLES, FARM_CATEGORIES, SAFE_LAYOUT, FIRST_LAYOUT } from "../shared/styles.js";
import { PACK_KINDS, packSize, mainFace, aspectFor, renderDieline } from "./packaging.js";
import { withUsage } from "./usage.js";
import { createRefs, REF_USES } from "./refs.js";
import { noteDocx } from "./docx-note.js";
import { caseById, CASES } from "../shared/cases.js";
import { FREE_DAILY_PRODUCTS } from "../shared/pricing.js";
import { SECTION_TYPES, SECTION_MODES, PHOTO_ROLES, QUICK, scanRisky, paletteRoles } from "../shared/suite.js";

// "商品全套": one product → profile → note → product images → detail page.
// Each AI step is one multimodal call; image generation reuses the job queue.
export function registerSuites({ app, store, users, styles, dataDir, textAI, normalizeUpload, regularFile, admission, createJob, jobsDir }) {
  const refs = createRefs(dataDir);
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
    palette: paletteRoles(s.look?.palette?.length >= 3 ? s.look.palette : s.profile?.palette),
    text: undefined,
    hasText: !!s.text,
    risky: scanRisky([s.note?.text, s.profile?.copy, JSON.stringify(s.profile || {})].join("\n")),
    packaging: s.packaging ? packState(s) : null,
    jobs: Object.fromEntries(Object.entries(s.jobs || {}).map(([k, id]) => [k, id && store.get(id) ? summary(store.get(id)) : null])),
    madeShots: s.profile && s.shots ? madeShots(s).map((m) => m.shot.id) : [],
  });
  const summary = (j) => {
    const tweaks = store.tweaksOf(j.id);
    const ahead = j.status === "queued" ? store.ahead(j) : 0;
    return { id: j.id, skillId: j.params.skillId, resolution: j.params.resolution, status: j.status, phase: j.status === "queued" ? (ahead ? `排队中，前面还有 ${ahead} 个任务` : "排队中，马上开始") : j.phase, error: j.error, cost: j.cost, manifest: j.manifest, updatedAt: j.updatedAt, frames: j.params.frames, tweaks, upscales: j.params.skillId === "product" ? store.upscalesOf([j.id, ...tweaks.map((t) => t.id)]) : [] };
  };
  // Pictures made one at a time (“单独出这张”). The full set takes each of them over as long as
  // nothing about that picture changed since: same words, scene, photos and look.
  const sameList = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
  const tryKey = (shotId) => "try:" + shotId;
  function madeShots(s, resolution = "2K") {
    const made = [];
    const legacy = s.jobs?.shotTrial && store.get(s.jobs.shotTrial);
    for (const shot of (s.shots || []).filter((x) => x.enabled)) {
      const id = s.jobs?.[tryKey(shot.id)];
      const job = id ? store.get(id) : legacy;
      const f = job?.status === "succeeded" && job.params.frames?.[0];
      if (!f || f.ref !== shot.id || f.scene !== shot.scene || !sameList(f.photos, shot.photos)) continue;
      if ((job.params.resolution || "2K") !== resolution) continue;
      if (!sameList(f.texts.filter((t) => t.text !== AI_LABEL).map((t) => [t.role, t.text]), shot.texts.map((t) => [t.role, t.text]))) continue;
      if (JSON.stringify(job.params.direction) !== JSON.stringify(direction(s))) continue;
      // If the merchant fine-tuned or redrew it, the newest version is the one that counts.
      const newer = store.tweaksOf(job.id).find((t) => t.status === "succeeded" && t.asset);
      const from = newer ? store.get(newer.id) : job;
      const asset = from?.manifest?.assets?.find((a) => a.role === "image");
      const file = asset && path.join(jobsDir, from.id, from.manifest.exportId, asset.name);
      if (file && fs.existsSync(file)) made.push({ job, shot, file });
    }
    return made;
  }

  // Run one AI step in the background and record its state on the suite.
  let running = 0;
  const TASK_LIMIT = Number(process.env.TEXT_TASK_LIMIT) || 8; // AI planning steps at once, all accounts together
  function task(id, name, fn) {
    if (running >= TASK_LIMIT) throw new AppError("现在用的人比较多，AI 正在处理其他商品，请过一会儿再试", 429);
    const s = read(id);
    if (s.tasks?.[name]?.status === "running") return s;
    s.tasks = { ...(s.tasks || {}), [name]: { status: "running", startedAt: Date.now() } };
    save(s);
    running++;
    withUsage({ suiteId: id, userId: s.userId || null, purpose: name }, async () => {
      try {
        if (!textAI.describe().ready) throw new Error("未配置 Kimi，请在 .env 填写 KIMI_API_KEY");
        const latest = read(id);
        const before = JSON.parse(JSON.stringify(latest));
        await fn(latest);
        // Steps run for minutes while the merchant (or another step) edits the product:
        // write back only what this step changed, on top of the current state.
        const fresh = read(id);
        for (const k of Object.keys(latest))
          if (k !== "tasks" && JSON.stringify(latest[k]) !== JSON.stringify(before[k])) fresh[k] = latest[k];
        fresh.tasks = { ...(fresh.tasks || {}), [name]: { status: "done", at: Date.now() } };
        save(fresh);
      } catch (error) {
        const latest = read(id);
        latest.tasks[name] = { status: "failed", error: error.message };
        save(latest);
      } finally {
        running--;
      }
    });
    return read(id);
  }

  const AI_LABEL = "烹饪示意 图片仅供参考";
  // Within a set, prefer photos used least so far: different pictures start from different shots.
  const pickPhotos = (s, roles, n = 2, used = new Map()) => {
    const usable = s.photos.filter((p) => p.usable && p.role !== "design");
    const chosen = [];
    // Once the merchant adopts a newly designed box, it stands in for the old package photos.
    const designed = usable.some((p) => p.packDesign);
    for (const role of roles) {
      const pool = usable.filter((p) => p.role === role && !chosen.includes(p) && !(role === "package" && designed && !p.packDesign));
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
    // Farm produce and seafood choose among listing layouts, with the proven best-seller first.
    const farm = FARM_CATEGORIES.includes(s.profile.category);
    const pool = farm ? styleCandidates().filter((x) => x.layout && x.categories.includes(s.profile.category)) : styleCandidates();
    s.looks = await proposeLooks(textAI, s.profile, pool.length >= 3 ? pool : styleCandidates(), imgPaths(s, rep), farm ? { must: FIRST_LAYOUT[s.profile.category] || SAFE_LAYOUT } : {});
    if (!s.look && s.looks.length) s.look = s.looks[0];
  }
  const steps = {
    async looks(s) {
      // "换一批" replaces the AI's suggestions; a reference the merchant uploaded stays.
      const own = (s.looks || []).filter((l) => l.own);
      s.looks = null;
      await ensureLooks(s);
      s.looks = [...own, ...s.looks];
    },
    async profile(s) {
      // AI dish pictures keep their own label; only real photos are (re)read.
      const real = s.photos.filter((p) => !p.ai && !p.desc?.trim());
      if (real.length) {
        const labels = await labelPhotos(textAI, imgPaths(s, real));
        const byFile = new Map(real.map((p, i) => [p.file, labels[i]]));
        s.photos = s.photos.map((p) => (byFile.has(p.file) ? { ...p, ...byFile.get(p.file) } : p));
        const fresh = read(s.id);
        fresh.photos = fresh.photos.map((p) => (byFile.has(p.file) && !p.desc?.trim() ? { ...p, ...byFile.get(p.file) } : p));
        save(fresh);
      }
      s.profile = await buildProfile(textAI, { text: s.text, answers: s.answers, photos: s.photos });
      if (!s.caseId) s.caseId = { 生鲜水产: "seafood-gift", 农副产品: "farm-produce" }[s.profile.category] || "general";
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
        const photos = pickPhotos(s, shot.photos, shot.noText ? 1 : 2, used);
        // A shot that needs facts the merchant hasn't given (e.g. weight for the size shot) waits.
        const optional = shot.optional || (shot.needs && !s.profile[shot.needs]);
        return { id: shot.id, title: shot.title, brief: shot.brief, content: shotContent(shot.id, s.profile), photos: photos.map((p) => `${PHOTO_ROLES[p.role]}：${p.desc}`), files: photos.map((p) => p.file), noText: shot.noText, optional, ...(shot.cinematic ? { cinematic: true } : {}) };
      });
      // The white-background picture has no words and no styling: nothing to plan.
      const planned = await planFrames(textAI, s.profile, items.filter((i) => i.files.length && !i.noText).map(({ files, noText, optional, ...rest }) => rest), { kind: "product", look: s.look });
      s.shots = items.map((it) => {
        const f = planned.find((p) => p.id === it.id);
        return { id: it.id, title: it.title, ...(it.cinematic ? { cinematic: true } : {}), enabled: !!it.files.length && !it.optional, photos: it.files, texts: it.noText ? [] : f?.texts || [], scene: it.noText ? it.brief : f?.scene || it.brief, missing: it.files.length ? "" : `缺少${it.title}需要的实拍图` };
      });
    },
    async detail(s) {
      await ensureLooks(s);
      const ai = s.sections.filter((x) => x.mode === "ai");
      const used = new Map();
      const items = ai.map((x) => {
        const roles = SECTION_TYPES[x.type].photo.length ? SECTION_TYPES[x.type].photo : ["product"];
        // No photo of the right kind (e.g. no packaging shot): use the product itself
        // rather than letting the image model invent it.
        let photos = pickPhotos(s, roles, 2, used);
        if (!photos.length) photos = pickPhotos(s, ["product", "detail"], 1, used);
        x.photos = photos.map((p) => p.file);
        return { id: x.id, title: SECTION_TYPES[x.type].name, brief: sectionBrief(x.type, s.profile), content: sectionContent(x.type, s.profile), photos: photos.map((p) => `${PHOTO_ROLES[p.role]}：${p.desc}`), ...(x.cinematic ? { cinematic: true } : {}) };
      });
      // Background screens: the text is typeset on top, so the picture only sets the mood.
      for (const x of s.sections.filter((y) => y.mode === "bg")) {
        const photo = pickPhotos(s, ["product", "detail", "package"], 1, used);
        x.photos = photo.map((p) => p.file);
        x.texts = [];
        x.scene = bgScene(x.type, s);
      }
      const planned = items.length ? await planFrames(textAI, s.profile, items, { kind: "detail", look: s.look }) : [];
      for (const x of ai) {
        const f = planned.find((p) => p.id === x.id);
        x.texts = f?.texts || [];
        x.scene = f?.scene || "";
      }
    },
  };
  // The planner quotes each line inside the scene ("竖条写「…」"): when the merchant edits a
  // line, the old wording in the scene would otherwise still get drawn.
  function syncScene(scene, before = [], after = []) {
    let out = scene || "";
    before.forEach((t, i) => {
      const next = after[i]?.text;
      if (t?.text && next && next !== t.text && t.text.length >= 2) out = out.split(t.text).join(next);
    });
    return out;
  }
  // Facts a product image may print (shots that answer buyers' doubts need them spelled out).
  function shotContent(id, p) {
    return {
      spec: { spec: p.spec, packaging: p.packaging },
      service: { service: p.service, courier: p.courier, dispatch: p.dispatch, freeShipping: p.freeShipping, afterSales: p.afterSales },
      normal: p.normal,
      pack: { packaging: p.packaging, storage: p.storage, courier: p.courier, dispatch: p.dispatch },
      origin: { origin: p.origin, shipFrom: p.shipFrom },
    }[id] || undefined;
  }
  function sectionContent(type, p) {
    return {
      hero: { name: p.name, points: p.sellingPoints.slice(0, 3).map((x) => x.title) },
      why: p.why && { kicker: p.why.kicker, headline: p.why.headline, cards: p.why.cards, highlight: p.why.highlight },
      compare: p.compare && { ours: p.compare.ours, others: p.compare.others, rows: p.compare.rows.slice(0, 4) },
      pick: p.pick,
      material: p.sellingPoints,
      usage: p.usage,
      pack: { packaging: p.packaging, storage: p.storage, courier: p.courier, dispatch: p.dispatch },
      faq: p.faq && { headline: p.faq.headline, cards: p.faq.cards },
      normal: p.normal,
      info: { name: p.name, origin: p.origin, spec: p.spec, storage: p.storage, courier: p.courier, dispatch: p.dispatch },
      notice: p.notice.slice(0, 4),
    }[type] || null;
  }
  function bgScene(type, s) {
    const l = s.look;
    const mood = l ? `${l.conceptName}：${l.props}；${l.light}；色板 ${(l.palette || []).join(" ")}` : `色板 ${(s.profile.palette || []).join(" ")}，干净的商业质感`;
    return `详情页里一屏“${SECTION_TYPES[type].name}”的背景画面，和整套风格一致（${mood}）。画面中央约 70% 的大块区域保持干净、明亮、平整（浅色纸面、柔和渐变或虚化的台面），之后要在上面放一大段文字；只在四周边缘点缀少量道具，商品（图1）最多在角落露出一小部分。不要任何文字、数字、图标和边框。`;
  }
  function sectionBrief(type, p) {
    return {
      hero: `首屏：${p.name}，包装和实物同框，大标题写品名，副标题一句概念`,
      why: `为什么是${p.origin || "这里"}：大标题 + 3 个关键数字/关键词（来自 content.cards），配产地或商品实拍`,
      origin: `产地/货源实景：${p.shipFrom || p.origin}`,
      compare: "对比：左右或上下分屏，我们 vs 对方，2-3 个差异点用短词标注（来自 content.rows）。“普通的”一侧画同类普通货（不出现任何品牌、店名、包装），左右两张卡片各配打勾/打叉列表",
      pick: "怎么挑：商品特写，用引线标注 2-3 个看点（来自 content.points）",
      material: "选材与细节：近距离质感特写",
      usage: `吃法/用法：${p.usage?.headline || "成品展示"}`,
      pack: "包装与收货：独立包装 + 礼盒/保温箱，标注包装方式",
      normal: "正常现象说明：实物特写，圆圈和引线标出 content.items 里的现象，标题安抚（收到别担心）",
    }[type] || "";
  }
  function defaultSections(s) {
    const c = caseById(s.caseId);
    const p = s.profile || {};
    const empty = { why: !p.why?.headline, compare: !p.compare?.rows?.length, pick: !p.pick?.points?.length, faq: !p.faq?.headline, normal: !p.normal?.items?.length, notice: !p.notice?.length };
    return c.sections.map((x, i) => {
      const modes = SECTION_TYPES[x.type].modes;
      // Cinematic screens rebuild the scene (sea, boat, splash) around the real product.
      const roles = x.cinematic ? [...SECTION_TYPES[x.type].photo, "product"] : SECTION_TYPES[x.type].photo;
      const hasPhoto = roles.length === 0 || pickPhotos(s, roles, 1).length > 0;
      let mode = x.mode;
      if (empty[x.type]) mode = "off";
      // No matching photo: never let the image model invent it — typeset over an AI background instead.
      if ((mode === "ai" || mode === "photo") && !hasPhoto) mode = modes.includes("bg") ? "bg" : modes.includes("tpl") ? "tpl" : "off";
      return { id: `${x.type}-${i}`, type: x.type, mode, ...(x.cinematic ? { cinematic: true } : {}), photos: [], texts: [], scene: "" };
    });
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: SUITE_FILE_MB * 1024 * 1024, files: 31, fields: 10, fieldSize: 20000 },
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
          return { id: r.id, name: d.profile?.name || d.name || "未命名商品", cover: d.photos?.[0]?.file || null, updatedAt: r.updated_at, tasks: d.tasks, steps: { profile: !!d.profile, note: !!d.note, shots: !!d.jobs?.shots, detail: !!d.jobs?.detail } };
        }),
    }),
  );
  app.post("/api/suites", upload, async (req, res) => {
    // Profiles and notes cost model calls but no credits: accounts that never topped up get a few a day.
    if (req.user.role !== "admin" && !store.users.paid(req.user.id)) {
      const since = new Date(Date.now() - 86400000).toISOString();
      const n = store.db.prepare("SELECT count(*) AS n FROM suites WHERE user_id=? AND created_at > ?").get(req.user.id, since).n;
      if (n >= FREE_DAILY_PRODUCTS) throw new AppError(`体验账号每天最多新建 ${FREE_DAILY_PRODUCTS} 个商品，充值后不限`, 429);
    }
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
    await sendImage(req, res, await regularFile(dirOf(s.id), req.params.file), dataDir);
  });
  app.post("/api/suites/:id/photos", upload, async (req, res) => {
    const s = read(req.params.id);
    await addPhotos(s, (req.files?.photos || []).map((f) => f.buffer), "upload");
    save(s);
    res.json(view(read(s.id)));
  });
  // A new real photo added from a product-picture card: stored with the product, described by the
  // vision model (so the brief can say what it shows) and used for that picture right away.
  const onePhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: SUITE_FILE_MB * 1024 * 1024, files: 1 } }).single("photo");
  app.post("/api/suites/:id/shots/:shot/photo", onePhoto, async (req, res) => {
    const s = read(req.params.id);
    const shot = (s.shots || []).find((x) => x.id === req.params.shot);
    if (!shot) throw new AppError("没有这张商品图");
    if (!req.file) throw new AppError("请选一张实拍图");
    if (s.photos.length >= 40) throw new AppError("一个商品最多 40 张实拍图，先在“商品档案”里删掉不用的");
    const before = s.photos.length;
    await addPhotos(s, [req.file.buffer], "upload");
    const added = s.photos[before];
    if (!added) throw new AppError("这张图读不出来，换一张 JPG 或 PNG 再试");
    try {
      Object.assign(added, (await labelPhotos(textAI, imgPaths(s, [added])))[0]);
    } catch {
      added.desc = "商家补充的实拍图"; // usable even when the vision model is busy; the role can be set in 商品档案
    }
    added.usable = true;
    const fresh = read(s.id);
    fresh.photos = [...fresh.photos, added];
    fresh.shots = (fresh.shots || []).map((x) => (x.id === shot.id ? { ...x, photos: [added.file, ...x.photos.filter((f) => f !== added.file)].slice(0, 3), missing: "" } : x));
    res.json(view(save(fresh)));
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
        const texts = Array.isArray(e.texts) ? cleanTexts(e.texts) : x.texts;
        const scene = typeof e.scene === "string" ? e.scene.slice(0, 800) : x.scene;
        // Which real photos this picture is built from: the merchant can swap them.
        const photos = Array.isArray(e.photos) ? [...new Set(e.photos)].filter((f) => s.photos.some((p) => p.file === f)).slice(0, 3) : x.photos;
        const enabled = (typeof e.enabled === "boolean" ? e.enabled : x.enabled) && photos.length > 0;
        return { ...x, enabled, photos, missing: photos.length ? "" : x.missing || `缺少${x.title}需要的实拍图`, texts, scene: syncScene(scene, x.texts, texts) };
      });
    if (Array.isArray(b.sections))
      s.sections = b.sections
        .map((e) => {
          const x = s.sections.find((y) => y.id === e?.id);
          if (!x) return null;
          const mode = Object.hasOwn(SECTION_MODES, e.mode) && (e.mode === "off" || SECTION_TYPES[x.type].modes.includes(e.mode)) ? e.mode : x.mode;
          const texts = Array.isArray(e.texts) ? cleanTexts(e.texts) : x.texts;
          return { ...x, mode, texts, scene: syncScene(typeof e.scene === "string" ? e.scene.slice(0, 800) : x.scene, x.texts, texts), photos: Array.isArray(e.photos) ? e.photos.filter((f) => s.photos.some((p) => p.file === f)).slice(0, 3) : x.photos };
        })
        .filter(Boolean);
    res.json(view(save(s)));
  });
  // Put finished product pictures into the detail page as screens of their own (free: no new picture is made).
  app.post("/api/suites/:id/sections/shots", (req, res) => {
    const s = read(req.params.id);
    needProfile(s);
    const ids = Array.isArray(req.body?.shots) ? req.body.shots.filter((x) => typeof x === "string") : [];
    const add = (s.shots || []).filter((x) => ids.includes(x.id) && !s.sections.some((y) => y.type === "shot" && y.shot === x.id));
    if (!add.length) throw new AppError("选一张还没放进详情页的商品图");
    if (s.sections.length + add.length > 30) throw new AppError("详情页最多 30 屏");
    const fresh = add.map((x) => ({ id: `shot-${x.id}-${randomUUID().slice(0, 4)}`, type: "shot", mode: "shot", shot: x.id, name: x.title, texts: [], scene: "", photos: [] }));
    const after = s.sections.findIndex((y) => y.id === req.body?.after);
    s.sections = after >= 0 ? [...s.sections.slice(0, after + 1), ...fresh, ...s.sections.slice(after + 1)] : [...s.sections, ...fresh];
    res.json(view(save(s)));
  });
  const cleanTexts = (list) =>
    list
      .slice(0, 6)
      .map((t) => ({ role: ["headline", "sub", "point", "tag"].includes(t?.role) ? t.role : "point", text: String(t?.text || "").trim().slice(0, t?.role === "tag" ? 30 : 20) }))
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
      layout: look.layout || recipe.layout || "",
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
    // "先出一张试试": one shot on its own, so the look can be judged before paying for the set.
    const only = kind === "shots" && typeof req.body?.only === "string" ? req.body.only : null;
    const frames = kind === "shots"
      ? (s.shots || []).filter((x) => (only ? x.id === only && x.photos.length : x.enabled))
      : s.sections.filter((x) => x.mode === "ai" || x.mode === "bg");
    if (only && !frames.length) throw new AppError("这张图缺少实拍图，先试别的一张");
    if (!frames.length) throw new AppError(kind === "shots" ? "请先规划商品图" : "详情页没有需要 AI 出图的屏");
    if (frames.some((f) => !f.scene)) throw new AppError("请先让 AI 规划画面");
    const set = only && s.jobs?.shots ? store.get(s.jobs.shots) : null;
    const at = set && ["succeeded", "partial"].includes(set.status) ? set.params.frames.findIndex((f) => f.ref === only) : -1;
    const inSet = at >= 0 && set.manifest?.assets?.some((a, pos) => a.role === "image" && (a.frame ?? pos) === at);
    const refTaken = new Map();
    // A look the merchant uploaded: that picture is the design reference for every frame.
    const ownFile = s.look?.own ? styles.coverFile(s.look.styleId) : null;
    const ownRef = ownFile ? `own-style-${s.look.styleId}.png` : null;
    const params = {
      version: 3,
      skillId: kind === "shots" ? "product" : "detail",
      productName: `${s.profile.name || "商品"} · ${kind === "shots" ? "商品图" : "详情页"}`,
      size: kind === "shots" ? (inSet ? set.params.size : req.body?.size === "3:4" ? "3:4" : "1:1") : "3:4",
      count: frames.length,
      frames: frames.map((f) => {
        // Pictures that use an AI-made dish say so on the image.
        const bg = f.mode === "bg";
        const usesAI = f.photos.some((file) => s.photos.find((p) => p.file === file)?.ai);
        const texts = bg ? [] : usesAI && s.aiLabel !== false ? [...f.texts, { role: "tag", text: AI_LABEL }] : f.texts;
        const kindId = f.type || f.id;
        const ref = bg || f.id === "white" ? null : ownRef || refs.pick(s.profile.category, kindId, refTaken);
        return {
        ...(ref ? { styleRefs: [ref] } : {}),
        ...(f.cinematic ? { photoUse: "hero" } : {}),
        title: f.title || SECTION_TYPES[f.type]?.name || "",
        textMode: bg ? "overlay" : texts.length ? "ai" : "none",
        layout: bg ? "center" : texts.length ? "free" : "none",
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
      ...(FARM_CATEGORIES.includes(s.profile.category) ? { fidelity: "real" } : {}),
    };
    // Reference images live in the internal library, not with the product's photos.
    const extra = {};
    for (const f of params.frames) for (const r of f.styleRefs || []) extra[r] = r === ownRef ? ownFile : refs.file(r);
    params.inputs = [...new Set([...params.inputs, ...Object.keys(extra)])];
    // The full set takes over the pictures already made one by one instead of drawing (and charging) them again.
    const reuse = {};
    if (kind === "shots" && !only)
      for (const made of madeShots(s, req.body?.resolution || "2K")) {
        const at = frames.findIndex((f) => f.id === made.shot.id);
        if (at < 0 || made.job.params.size !== params.size) continue;
        params.frames[at] = { ...made.job.params.frames[0] };
        (params.reusedFrames ||= []).push(at);
        reuse[at] = made.file;
      }
    // One picture of a set that already exists: made from the plan as it stands now (words, scene,
    // real photos, look) and filed as the newest version of that picture in the set.
    if (inSet) Object.assign(params, { tweakOf: { jobId: set.id, frame: at }, redo: true, rootName: set.params.productName, productName: `${String(set.params.productName).slice(0, 30)} · 第${at + 1}张重出` });
    const holder = { status: (code) => ({ json: (job) => (holder.result = { code, job }) }) };
    await createJob(req, holder, params, dirOf(s.id), inSet ? set.id : null, extra, reuse);
    const latest = read(s.id);
    if (!inSet) latest.jobs = { ...(latest.jobs || {}), [only ? tryKey(only) : kind]: holder.result.job.id };
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
  // The merchant's own reference picture as the look: AI breaks it down into a recipe,
  // and every picture gets the upload itself as a design reference.
  const lookUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: SUITE_FILE_MB * 1024 * 1024, files: 1 } }).single("image");
  app.post("/api/suites/:id/look/upload", lookUpload, async (req, res) => {
    const s = read(req.params.id);
    needProfile(s);
    if (!req.file) throw new AppError("请选一张你喜欢的风格图");
    if (s.tasks?.looks?.status === "running") throw new AppError("AI 正在挑风格，稍等一下再传", 409);
    const styleId = styles.create({ name: "我的参考", prompt: "" }, req.user.id);
    const file = path.join(styles.dir, `${styleId}.png`);
    try {
      await normalizeUpload(req.file.buffer, file);
    } catch (error) {
      await styles.remove(styleId, req.user).catch(() => {});
      throw error;
    }
    res.json(view(task(s.id, "looks", async (s) => {
      try {
        styles.finish(styleId, await textAI.extractStyle(file, ""));
      } catch (error) {
        styles.finish(styleId, null, "风格拆解失败：" + error.message);
        throw new Error("这张图没能拆解出风格，换一张更清楚的再试：" + error.message);
      }
      const r = styles.get(styleId);
      const look = { styleId, conceptName: r.name, story: r.tagline, palette: r.palette, props: r.props, light: r.light, camera: r.camera, type: r.type, layout: "", why: "照你上传的这张图来做", own: true };
      s.looks = [look, ...(s.looks || []).filter((l) => !l.own)];
      s.look = look;
    })));
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
  // "家常随手拍" looks like a real customer's phone photo (the AI-studio look reads as fake);
  // "餐厅精致" is the polished option.
  const DISH_LOOKS = {
    home: {
      opener: "一张普通人在家用手机随手拍的真实菜品照片（生活照，不是商业广告图、不是影棚摄影）。",
      plates: [
        "家里常见的白瓷盘或印花盘，放在略旧的餐桌上，旁边随手放着一小碟酱油、半瓶调料或筷子；手机从斜上方俯拍，室内顶灯加窗边自然光",
        "家常搪瓷碗或不锈钢盘，饭桌上有一碗米饭和另一道家常菜的一角；手机正上方俯拍，光线普通、略偏暖",
        "刚出锅装在家用大圆盘里，摆得不讲究、汤汁随意，桌上有纸巾或碗边入镜；手机近距离拍，背景是家里的厨房或餐桌",
      ],
      look: "像小红书网友晒的家常菜：颜色自然、不过饱和，摆盘随意不对称，有生活杂物入镜，轻微的手机拍摄感（自动曝光、景深不夸张）",
      avoid: "影棚布光、完美对称摆盘、夸张热气烟雾、过度光泽和磨皮、过饱和的红色、CG/塑料质感、文字水印",
      core: "casual smartphone photo of a home-cooked Chinese dish, natural indoor light, everyday plate, slightly messy table, realistic colors, not a commercial shoot",
    },
    shop: {
      opener: "餐厅菜品摄影：真实、有食欲的成品菜照片。",
      plates: ["白瓷圆盘，餐厅餐桌，俯拍 45 度，柔和自然光", "深色粗陶盘，侧光，浅景深", "木托盘配小碗蘸料，正侧面"],
      look: "干净精致但真实，颜色自然不过饱和",
      avoid: "塑料感、CG 质感、夸张特效、文字水印",
      core: "realistic restaurant food photography, natural light, appetizing, true-to-life colors",
    },
  };
  app.post("/api/suites/:id/dish", admission, async (req, res) => {
    const s = read(req.params.id);
    needProfile(s);
    const method = String(req.body?.method || "").trim().slice(0, 20);
    if (!method) throw new AppError("选一种做法，例如清蒸、红烧");
    const count = Math.min(Math.max(Number(req.body?.count) || 2, 1), 3);
    const looks = DISH_LOOKS[req.body?.look === "shop" ? "shop" : "home"];
    const refs = ["product", "detail", "package"]
      .flatMap((r) => s.photos.filter((p) => p.role === r && p.usable && !p.ai))
      .slice(0, 2);
    if (!refs.length) throw new AppError("先上传一张生鲜/实物照片，AI 才知道食材长什么样");
    const name = s.profile.name || "这种食材";
    const params = {
      version: 3,
      skillId: "product",
      opener: looks.opener,
      productName: `${name} · 菜品图（${method}）`,
      size: "1:1",
      count,
      frames: Array.from({ length: count }, (_, i) => ({
        title: `${method} · ${i + 1}`,
        textMode: "none",
        layout: "none",
        texts: [],
        scene: `把实拍图里的${name}做成「${method}」，就是普通人家里做出来的样子。食材的品种、大小、形状、颜色必须和实拍一致（看得出是同一种食材），熟度、汤汁按${method}的家常做法如实呈现，不要美化成别的样子。${looks.plates[i % looks.plates.length]}。${looks.look}。只拍这道菜，不要包装、不要任何文字。`,
        photos: refs.map((p) => p.file),
        photoNotes: refs.map((p) => p.desc),
        photoUse: "ingredient",
        ref: `dish-${i}`,
      })),
      direction: {
        conceptName: req.body?.look === "shop" ? "餐厅精致" : "家常随手拍",
        story: "看起来就是真的有人做了这道菜、拍下来的照片",
        palette: ["#f4ede2", "#c8572b", "#3b2a20"],
        props: "家用盘碗、筷子、调料碟等生活物件",
        light: "室内自然光/顶灯，不打影棚光",
        camera: "手机视角，俯拍或斜上方",
        type: "无文字",
        avoid: looks.avoid,
        core: looks.core,
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
  // ---- Internal reference library (admin only) ----
  const refUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 20 } });
  const adminOnlyHere = (req) => {
    if (req.user?.role !== "admin") throw new AppError("只有管理员可以管理素材库", 403);
  };
  app.get("/api/admin/refs", (req, res) => {
    adminOnlyHere(req);
    res.json({ refs: refs.list(), uses: REF_USES });
  });
  app.post("/api/admin/refs", refUpload.array("images", 20), async (req, res) => {
    adminOnlyHere(req);
    if (!req.files?.length) throw new AppError("请选择图片");
    const uses = String(req.body?.uses || "").split(/[,，\s]+/).filter(Boolean);
    const added = [];
    for (const f of req.files) added.push(await refs.add(f.buffer, { uses, category: req.body?.category || "生鲜水产", note: req.body?.note || "" }));
    res.json({ added, refs: refs.list() });
  });
  app.get("/api/admin/refs/:file", async (req, res) => {
    adminOnlyHere(req);
    const f = refs.file(req.params.file);
    if (!f) throw new AppError("没有这张参考图", 404);
    res.sendFile(f, { dotfiles: "allow" });
  });
  app.delete("/api/admin/refs/:file", (req, res) => {
    adminOnlyHere(req);
    refs.remove(req.params.file);
    res.json({ refs: refs.list() });
  });
  // ---- Packaging: an outer carton / gift box printed around the merchant's foam box ----
  // Designed before product shots and the detail page, which then show the new box.
  const packInfo = (s) => {
    const p = s.profile || {};
    return [["品名", p.name], ["规格", p.spec], ["贮存", p.storage], ["产地", p.origin], ["发货地", p.shipFrom], ...(s.packaging?.extra || [])];
  };
  const packState = (s) => {
    const pk = s.packaging || {};
    const size = pk.need ? packSize(pk.kind, pk.box) : null;
    return { ...pk, size, face: size ? mainFace(pk.kind, size) : null };
  };
  app.post("/api/suites/:id/packaging", (req, res) => {
    const s = read(req.params.id);
    needProfile(s);
    const b = req.body || {};
    const pk = { ...(s.packaging || {}) };
    if (typeof b.need === "boolean") pk.need = b.need;
    if (b.kind && PACK_KINDS[b.kind]) pk.kind = b.kind;
    if (b.box) {
      const box = { l: Number(b.box.l), w: Number(b.box.w), h: Number(b.box.h) };
      if (!packSize(pk.kind || "carton", box)) throw new AppError("泡沫箱尺寸要填长、宽、高（厘米，5–150）");
      pk.box = box;
    }
    if (typeof b.brand === "string") pk.brand = b.brand.trim().slice(0, 16);
    if (Array.isArray(b.extra))
      pk.extra = b.extra
        .filter((r) => Array.isArray(r) && typeof r[0] === "string" && typeof r[1] === "string" && r[0].trim() && r[1].trim())
        .slice(0, 4)
        .map(([k, v]) => [k.trim().slice(0, 6), v.trim().slice(0, 40)]);
    if (pk.need && !pk.kind) pk.kind = "carton";
    s.packaging = pk;
    res.json(view(save(s)));
  });
  app.post("/api/suites/:id/packaging/art", admission, async (req, res) => {
    const s = read(req.params.id);
    needProfile(s);
    const pk = packState(s);
    if (!pk.need || !pk.size) throw new AppError("先填好包装类型和泡沫箱尺寸");
    const refs = ["product", "detail", "cooked"].flatMap((r) => s.photos.filter((p) => p.role === r && p.usable && !p.packDesign)).slice(0, 2);
    if (!refs.length) throw new AppError("先上传一张商品实拍，包装上的商品图案要照着它画");
    const p = s.profile;
    const brand = pk.brand || p.name;
    const d = direction(s);
    const points = p.sellingPoints.slice(0, 3).map((x) => x.title).filter(Boolean);
    const variants = [
      "大字报式：品名超大字为视觉中心，品牌色大色块，商品图案在一侧，底部一条色带排 2–3 个卖点",
      "图案主导：商品图案大而饱满占画面 50% 以上，品名和品牌压在图案上方留白处，卖点做成小圆标",
    ];
    const params = {
      version: 3,
      skillId: "product",
      opener: "包装印刷设计：画一张纸箱/礼盒某一面的平面印刷稿（正视、无透视、满版铺色），不是商品摄影，也不是立体效果图。",
      productName: `${p.name || "商品"} · 包装正面`,
      size: aspectFor(pk.face.w, pk.face.h),
      count: variants.length,
      frames: variants.map((v, i) => ({
        title: `${pk.face.name} · 方案 ${i + 1}`,
        textMode: "ai",
        layout: "free",
        texts: [{ role: "headline", text: p.name.slice(0, 12) }, ...(pk.brand ? [{ role: "sub", text: pk.brand }] : []), ...points.map((t) => ({ role: "point", text: t }))],
        scene: `${PACK_KINDS[pk.kind].name}的${pk.face.name}印刷平面稿，实际尺寸 ${pk.face.w}×${pk.face.h} cm。${v}。画面就是印刷面本身：铺满整个画幅、没有桌面背景、没有阴影和透视，不要画成盒子。四周留约 1 cm 安全边，文字不要贴边。商品图案照图1的真实样子画。`,
        photos: refs.map((x) => x.file),
        photoNotes: refs.map((x) => x.desc),
        photoUse: "print",
        ref: `pack-${i}`,
      })),
      direction: { ...d, props: "只有印刷面上的图形元素（色块、线条、纹样、商品图案），没有实物道具", light: "平面印刷稿，均匀无光影", camera: "正视平面，无透视" },
      hasMainImage: false,
      refCount: 0,
      styleRef: null,
      inputs: refs.map((x) => x.file),
      suiteId: s.id,
      packStep: "art",
    };
    const holder = { status: (code) => ({ json: (job) => (holder.result = { code, job }) }) };
    await createJob(req, holder, params, dirOf(s.id));
    const latest = read(s.id);
    latest.jobs = { ...(latest.jobs || {}), packArt: holder.result.job.id, packMock: null };
    latest.packaging = { ...(latest.packaging || {}), front: null, dieline: false };
    save(latest);
    res.status(holder.result.code).json(holder.result.job);
  });
  // Merchant picks one front: lay out the flat at real size and draw the 3D mock-up from it.
  app.post("/api/suites/:id/packaging/choose", admission, async (req, res) => {
    const s = read(req.params.id);
    const pk = packState(s);
    const job = s.jobs?.packArt && store.get(s.jobs.packArt);
    if (!job || job.status !== "succeeded" || !pk.size) throw new AppError("包装正面还没生成好");
    const asset = job.manifest.assets.find((a) => a.name === req.body?.asset && a.role === "image");
    if (!asset) throw new AppError("没有这张图", 404);
    const dir = dirOf(s.id);
    const front = await fsp.readFile(await regularFile(path.join(jobsDir, job.id, job.manifest.exportId), asset.name));
    await fsp.writeFile(path.join(dir, "pack-front.png"), front);
    const p = s.profile;
    const dieline = await renderDieline({ kind: pk.kind, size: pk.size, front, brand: pk.brand || p.name, name: p.name, info: packInfo(s), palette: direction(s).palette });
    await fsp.writeFile(path.join(dir, "pack-dieline.png"), dieline);
    const d = direction(s);
    const params = {
      version: 3,
      skillId: "product",
      productName: `${p.name || "商品"} · 包装效果图`,
      size: "1:1",
      count: 1,
      frames: [
        {
          title: "包装立体效果图",
          textMode: "none",
          layout: "none",
          texts: [],
          scene: `一个做好的${PACK_KINDS[pk.kind].name}，外尺寸约 ${pk.size.l}×${pk.size.w}×${pk.size.h} cm（长×宽×高，比例要对）。45° 斜俯视，能看到${pk.kind === "gift" ? "盒盖正面和一侧盒壁" : "正面长侧面、一个短侧面和顶部"}；${pk.face.name}贴的就是图1 的设计，图案和文字与图1 完全一致；其余面用图1 的主色。纸箱放在干净明亮的${pk.kind === "gift" ? "居家桌面" : "仓库/发货台"}上，真实纸张质感和自然阴影，像实拍的成品样箱。不要出现图1 以外的新文字。`,
          photos: ["pack-front.png"],
          photoNotes: [pk.face.name],
          photoUse: "artwork",
          ref: "pack-mock",
        },
      ],
      direction: { ...d, props: "纸箱/礼盒成品样箱，干净台面", camera: "45° 斜俯视，盒子居中占画面 60%" },
      hasMainImage: false,
      refCount: 0,
      styleRef: null,
      inputs: ["pack-front.png"],
      suiteId: s.id,
      packStep: "mock",
    };
    const holder = { status: (code) => ({ json: (job2) => (holder.result = { code, job: job2 }) }) };
    await createJob(req, holder, params, dir);
    const latest = read(s.id);
    latest.jobs = { ...(latest.jobs || {}), packMock: holder.result.job.id };
    latest.packaging = { ...(latest.packaging || {}), front: `${job.id}/${asset.name}`, dieline: true };
    save(latest);
    res.status(holder.result.code).json(view(read(s.id)));
  });
  app.get("/api/suites/:id/packaging/:file", async (req, res) => {
    const s = read(req.params.id);
    const name = { "dieline.png": "pack-dieline.png", "front.png": "pack-front.png" }[req.params.file];
    if (!name || !s.packaging?.dieline) throw new AppError("还没有包装稿", 404);
    if (req.query.thumb && req.query.download !== "1") return sendImage(req,res,await regularFile(dirOf(s.id), name),dataDir,{mutable:true});
    res.attachment(`${s.profile?.name || "包装"}-${req.params.file === "dieline.png" ? "展开图" : "正面设计稿"}.png`);
    res.sendFile(await regularFile(dirOf(s.id), name), { dotfiles: "allow" });
  });
  // The mock-up becomes the package photo every later picture uses.
  app.post("/api/suites/:id/packaging/adopt", async (req, res) => {
    const s = read(req.params.id);
    const job = s.jobs?.packMock && store.get(s.jobs.packMock);
    if (!job || job.status !== "succeeded") throw new AppError("效果图还没生成好");
    const asset = job.manifest.assets.find((a) => a.role === "image");
    const from = `${job.id}/${asset.name}`;
    if (!s.photos.some((p) => p.fromJob === from)) {
      if (s.photos.length >= 40) throw new AppError("照片最多 40 张");
      const file = `photo-${s.photos.length + 1}-${randomUUID().slice(0, 6)}.png`;
      await fsp.copyFile(await regularFile(path.join(jobsDir, job.id, job.manifest.exportId), asset.name), path.join(dirOf(s.id), file));
      for (const p of s.photos) if (p.packDesign) p.usable = false;
      s.photos.push({ file, role: "package", desc: "新设计的包装效果图", usable: true, packDesign: true, source: "ai", fromJob: from });
    }
    s.packaging = { ...(s.packaging || {}), adopted: true };
    // Later pictures should be re-planned around the new box.
    s.shots = null;
    s.sections = (s.sections || []).map((x) => ({ ...x, scene: "", photos: [] }));
    res.json(view(save(s)));
  });
  app.delete("/api/suites/:id", async (req, res) => {
    read(req.params.id);
    store.db.prepare("DELETE FROM suites WHERE id=?").run(req.params.id);
    await fsp.rm(dirOf(req.params.id), { recursive: true, force: true });
    res.json({ ok: true });
  });
}
