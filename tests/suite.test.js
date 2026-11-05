import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { Document, Packer, Paragraph, TextRun, ImageRun } from "docx";
import { createWorkspace } from "../backend/app.js";
import { scanRisky, saferText } from "../shared/suite.js";

const ACCESS = "test-only-access-code-123456";
const photo = (color) => sharp({ create: { width: 640, height: 800, channels: 3, background: color } }).jpeg().toBuffer();

// Fake Kimi: answers by looking at which step's system prompt it received.
function fakeAI() {
  const calls = [];
  return {
    calls,
    describe: () => ({ ready: true, via: "kimi", label: "test" }),
    async complete({ system, text, images }) {
      calls.push({ step: system.slice(0, 12), images: images?.length || 0, text, system });
      if (system.includes("美术指导")) {
        return JSON.stringify({
          looks: [
            { styleId: "wabi", conceptName: "渔港晨光", story: "清晨码头的冷暖对比", palette: ["#112233", "#c8572b", "#f4ede2"], props: "冰粒、麻绳", light: "清晨侧光", camera: "低机位", type: "粗宋体竖排", why: "有产地感" },
            { styleId: "not-a-style", conceptName: "编造的", palette: [] },
            { styleId: "oriental", conceptName: "年货礼盒", story: "红金喜庆", palette: ["#7d1f1a", "#c47a3d", "#e8dcc4"], props: "红绸", light: "暖光", camera: "居中", type: "书法标题", why: "适合送礼" },
          ],
        });
      }
      if (system.includes("整理实拍图")) {
        const roles = ["package", "product", "cooked", "origin", "design", "detail", "compare", "other"];
        return JSON.stringify({ photos: images.map((_, i) => ({ i: i + 1, role: roles[i % roles.length], desc: "测试图" + (i + 1), usable: roles[i % roles.length] !== "design" })) });
      }
      if (system.includes("电商美工")) {
        await new Promise((r) => setTimeout(r, 60));
        const items = JSON.parse(text.split("要做的图：")[1]);
        return JSON.stringify({ frames: items.map((it) => ({ id: it.id, texts: [{ role: "headline", text: it.title }], scene: "画面：" + it.brief })) });
      }
      if (system.includes("商品档案")) {
        return JSON.stringify({
          name: "舟山雷达网带鱼", category: "生鲜水产", origin: "浙江舟山", shipFrom: "沈家门渔港", storage: "-18℃冷冻",
          courier: "顺丰 京东", freeShipping: "包邮", dispatch: "48 小时", afterSales: "签收 6 小时内附图",
          intro: "舟山特产小眼睛带鱼。", sellingPoints: [{ title: "鱼肉厚实", detail: "口感绵密" }],
          why: { kicker: "为什么是舟山", headline: "别的带鱼，\n真不是这个味", cards: [{ big: "3大", label: "世界渔港之一", sub: "东海舟山渔场" }], body: "每年冬天……", highlight: "肉最厚" },
          compare: { headline: "对比", ours: "舟山雷达网", others: "其它海域", rows: [{ aspect: "肉质", ours: "厚", others: "薄" }] },
          pick: { headline: "怎么辨别", points: [{ title: "三小", detail: "小头小嘴小眼睛" }] },
          faq: { kicker: "提前打个招呼", headline: "花鳞不是不新鲜", cards: [], body: "说明" },
          notice: ["签收 6 小时内处理"], copy: "国内最好吃的雷达网油带鱼没有之一", palette: ["#1d3557", "#e8541e", "#f6efe6"],
        });
      }
      if (system.includes("私域团购")) return JSON.stringify({ title: "舟山带鱼到货", text: "🐟 舟山带鱼\n顺丰包邮" });
      throw new Error("unexpected step");
    },
    async readTexts() {
      return [];
    },
  };
}

async function setup(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "suite-test-"));
  const ai = fakeAI();
  const generated = [];
  const w = await createWorkspace({
    dataDir: path.join(rootDir, ".data"),
    accessCode: ACCESS,
    provider: { ready: true },
    textAI: ai,
    runner: async (job, dir) => {
      generated.push(job.params);
      for (let i = 1; i <= job.params.count; i++) await fs.writeFile(path.join(dir, `result-${i}.png`), await photo("#557799"));
    },
  });
  const server = w.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const request = (route, init = {}) => fetch(url + route, { ...init, headers: { "X-Requested-With": "SkillHub", Cookie: cookie, ...init.headers } });
  const login = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: ACCESS }) });
  cookie = login.headers.get("set-cookie").split(";")[0];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await w.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const post = (route, body, headers = {}) => request(route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const waitTask = async (id, name) => {
    for (let i = 0; i < 300; i++) {
      const s = await (await request(`/api/suites/${id}`)).json();
      if (s.tasks?.[name]?.status && s.tasks[name].status !== "running") return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("task did not finish: " + name);
  };
  const terminal = async (id) => {
    for (let i = 0; i < 300; i++) {
      const j = await (await request(`/api/jobs/${id}`)).json();
      if (!["queued", "running"].includes(j.status)) return j;
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { request, post, waitTask, terminal, ai, generated };
}

test("merchant with a PDF note: import text + photos → profile → note/Word → shots → detail", async (t) => {
  const s = await setup(t);
  const form = new FormData();
  const pdf = await fs.readFile("/tmp/claude-0/-home-claude/f18d0c63-bfb2-5ace-b3d6-af51ed16b32a/scratchpad/sample-note.pdf").catch(() => null);
  if (!pdf) return t.skip("sample pdf missing");
  form.append("note", new Blob([pdf], { type: "application/pdf" }), "带鱼.pdf");
  const created = await s.request("/api/suites", { method: "POST", body: form });
  assert.equal(created.status, 202, await created.clone().text());
  const id = (await created.json()).id;
  let suite = await s.waitTask(id, "profile");
  assert.equal(suite.tasks.profile.status, "done", JSON.stringify(suite.tasks));
  assert.ok(suite.photos.length >= 20, "photos extracted from the PDF: " + suite.photos.length);
  assert.ok(s.ai.calls.find((c) => c.step.includes("资深电商运营")).text.includes("沈家门"), "PDF text reaches the profile step");
  assert.equal(suite.profile.name, "舟山雷达网带鱼");
  assert.equal(suite.caseId, "seafood-gift");
  assert.ok(suite.sections.some((x) => x.type === "why" && x.mode === "tpl"));
  assert.ok(suite.risky.some((r) => r.word === "没有之一"));
  // note + Word
  suite = await (await s.post(`/api/suites/${id}/note`, {})).json();
  suite = await s.waitTask(id, "note");
  assert.match(suite.note.text, /顺丰包邮/);
  const docx = await s.request(`/api/suites/${id}/note.docx`);
  assert.equal(docx.status, 200);
  assert.ok((await docx.arrayBuffer()).byteLength > 10000);
  // shots
  await s.post(`/api/suites/${id}/shots/plan`, {});
  suite = await s.waitTask(id, "shots");
  assert.equal(suite.shots.length, 6);
  const enabled = suite.shots.filter((x) => x.enabled);
  assert.ok(enabled.length >= 4);
  assert.ok(enabled.every((x) => x.photos.length && x.scene.startsWith("画面")), JSON.stringify(enabled.map((x) => [x.id, x.photos.length, x.scene.slice(0, 20)])));
  const gen = await s.post(`/api/suites/${id}/shots/generate`, {}, { "Idempotency-Key": randomUUID() });
  assert.equal(gen.status, 202, await gen.clone().text());
  const job = await s.terminal((await gen.json()).id);
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.params.frames[0].photos.length > 0, true);
  suite = await (await s.request(`/api/suites/${id}`)).json();
  assert.equal(suite.jobs.shots.status, "succeeded");
  // detail: only AI sections become images; switch one section off
  const sections = suite.sections.map((x) => (x.type === "usage" ? { ...x, mode: "off" } : x));
  suite = await (await s.post(`/api/suites/${id}`, { sections })).json();
  assert.equal(suite.sections.find((x) => x.type === "usage").mode, "off");
  await s.post(`/api/suites/${id}/detail/plan`, {});
  suite = await s.waitTask(id, "detail");
  const ai = suite.sections.filter((x) => x.mode === "ai");
  const dgen = await s.post(`/api/suites/${id}/detail/generate`, {}, { "Idempotency-Key": randomUUID() });
  const djob = await s.terminal((await dgen.json()).id);
  assert.equal(djob.status, "succeeded", djob.error);
  assert.equal(djob.params.count, ai.length);
  assert.equal(djob.params.size, "3:4");
  assert.deepEqual(djob.params.frames.map((f) => f.ref), ai.map((x) => x.id));
});

test("merchant without a note: Word import, quick answers, photo role edits, validation", async (t) => {
  const s = await setup(t);
  assert.equal((await s.request("/api/suites", { method: "POST", body: new FormData() })).status, 400);
  // a Word note with one embedded photo
  const img = await photo("#cc8844");
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("【品名】手工曲奇")] }), new Paragraph({ children: [new ImageRun({ type: "jpg", data: img, transformation: { width: 300, height: 375 } })] })] }] });
  const form = new FormData();
  form.append("note", new Blob([await Packer.toBuffer(doc)]), "note.docx");
  const created = await s.request("/api/suites", { method: "POST", body: form });
  assert.equal(created.status, 202, await created.clone().text());
  let suite = await s.waitTask((await created.json()).id, "profile");
  assert.equal(suite.photos.length, 1);
  assert.ok(s.ai.calls.some((c) => c.text?.includes("手工曲奇")));
  // quick-answer path
  const f2 = new FormData();
  f2.append("answers", JSON.stringify({ name: "手工曲奇", storage: "常温" }));
  f2.append("photos", new Blob([img], { type: "image/jpeg" }), "a.jpg");
  const c2 = await s.request("/api/suites", { method: "POST", body: f2 });
  assert.equal(c2.status, 202);
  suite = await s.waitTask((await c2.json()).id, "profile");
  assert.ok(s.ai.calls.at(-1).text.includes("常温"));
  const file = suite.photos[0].file;
  suite = await (await s.post(`/api/suites/${suite.id}`, { photos: [{ file, role: "cooked" }], profile: { name: "改过的名字" } })).json();
  assert.equal(suite.photos[0].role, "cooked");
  assert.equal(suite.profile.name, "改过的名字");
  assert.equal((await s.request(`/api/suites/${suite.id}/photo/${file}`)).status, 200);
  assert.equal((await s.request(`/api/suites/${suite.id}/photo/..%2Faccess-code.txt`)).status, 404);
});

test("ad-law words are flagged and softened for Taobao", () => {
  const text = "国内最好吃的雷达网油带鱼没有之一，假一赔十";
  assert.deepEqual(scanRisky(text).map((r) => r.word), ["没有之一", "最好吃", "假一赔十"]);
  assert.equal(saferText(text), "国内口碑好的雷达网油带鱼，假一赔十");
});

test("style directions vary the look; AI dish pictures join the photo library and get labelled", async (t) => {
  const s = await setup(t);
  const form = new FormData();
  form.append("text", "舟山带鱼 清蒸好吃");
  for (const c of ["#aa3311", "#3355aa", "#22aa66"]) form.append("photos", new Blob([await photo(c)], { type: "image/jpeg" }), "p.jpg");
  const id = (await (await s.request("/api/suites", { method: "POST", body: form })).json()).id;
  let suite = await s.waitTask(id, "profile");
  assert.equal(suite.profile.category, "生鲜水产");

  // Planning first picks 3 directions from the style library (unknown ids dropped).
  await s.post(`/api/suites/${id}/shots/plan`, {});
  suite = await s.waitTask(id, "shots");
  assert.deepEqual(suite.looks.map((l) => l.styleId), ["wabi", "oriental"]);
  assert.equal(suite.look.conceptName, "渔港晨光");
  assert.deepEqual(suite.palette, ["#112233", "#c8572b", "#f4ede2"]);
  const plan = s.ai.calls.findLast((c) => c.system.includes("电商美工")).system;
  assert.match(plan, /渔港晨光/);
  assert.match(plan, /每项已经指定了版式/);
  // Every planned picture got its own layout, none repeated, sent in parallel chunks of two.
  const sentItems = s.ai.calls.filter((c) => c.system.includes("电商美工")).flatMap((c) => JSON.parse(c.text.split("要做的图：")[1]));
  const layouts = sentItems.slice(-suite.shots.filter((x) => x.photos.length).length).map((it) => it.layout);
  assert.equal(new Set(layouts).size, layouts.length, layouts.join());
  assert.ok(s.ai.calls.filter((c) => c.system.includes("电商美工")).every((c) => JSON.parse(c.text.split("要做的图：")[1]).length <= 2));
  assert.match(plan, /实拍里没有出现的包装形式/);
  assert.doesNotMatch(plan, /粗黑体中文大标题 \+ 细线装饰/);

  // Edits made while a step runs survive it.
  await s.post(`/api/suites/${id}/shots/plan`, {});
  await s.post(`/api/suites/${id}`, { aiLabel: false });
  suite = await s.waitTask(id, "shots");
  assert.equal(suite.aiLabel, false);
  await s.post(`/api/suites/${id}`, { aiLabel: true });
  // Switch to the second direction; the image job carries it.
  suite = await (await s.post(`/api/suites/${id}/look`, { index: 1 })).json();
  assert.equal(suite.look.conceptName, "年货礼盒");
  assert.equal((await s.post(`/api/suites/${id}/look`, { index: 7 })).status, 400);
  const gen = await s.post(`/api/suites/${id}/shots/generate`, {}, { "Idempotency-Key": randomUUID() });
  assert.equal(gen.status, 202, await gen.clone().text());
  const job = await s.terminal((await gen.json()).id);
  assert.equal(job.params.direction.conceptName, "年货礼盒");
  assert.match(job.params.direction.core, /Chinese aesthetic/);
  // "实拍精修" = no library style.
  suite = await (await s.post(`/api/suites/${id}/look`, { index: null })).json();
  assert.equal(suite.look, null);

  // AI dish from the raw photos.
  assert.equal((await s.post(`/api/suites/${id}/dish`, {}, { "Idempotency-Key": randomUUID() })).status, 400);
  const d = await s.post(`/api/suites/${id}/dish`, { method: "清蒸", count: 2 }, { "Idempotency-Key": randomUUID() });
  assert.equal(d.status, 202, await d.clone().text());
  const dish = await s.terminal((await d.json()).id);
  assert.equal(dish.status, "succeeded", dish.error);
  assert.equal(dish.params.count, 2);
  assert.match(dish.params.frames[0].scene, /清蒸/);
  assert.match(dish.params.opener, /手机随手拍/);
  assert.equal(dish.params.frames[0].photoUse, "ingredient");
  assert.match(dish.params.direction.avoid, /影棚布光/);
  assert.ok(dish.params.frames[0].photos.length >= 1);
  assert.ok(dish.params.frames.every((f) => f.texts.length === 0));
  suite = await (await s.request(`/api/suites/${id}`)).json();
  assert.equal(suite.jobs.dish.status, "succeeded");
  const asset = dish.manifest.assets.find((a) => a.role === "image").name;
  assert.equal((await s.post(`/api/suites/${id}/photos/adopt`, { jobId: dish.id, asset: "../x.png" })).status, 404);
  assert.equal((await s.post(`/api/suites/${id}/photos/adopt`, { jobId: job.id, asset })).status, 404);
  suite = await (await s.post(`/api/suites/${id}/photos/adopt`, { jobId: dish.id, asset })).json();
  const added = suite.photos.at(-1);
  assert.equal(added.ai, true);
  assert.equal(added.role, "cooked");
  assert.match(added.desc, /AI 示意：清蒸/);
  assert.equal((await s.request(`/api/suites/${id}/photo/${added.file}`)).status, 200);
  // Adopting twice doesn't duplicate.
  assert.equal((await (await s.post(`/api/suites/${id}/photos/adopt`, { jobId: dish.id, asset })).json()).photos.length, suite.photos.length);

  // Shots using the AI dish carry the disclaimer; turning it off removes it.
  await s.post(`/api/suites/${id}/shots/plan`, {});
  suite = await s.waitTask(id, "shots");
  const cooked = suite.shots.find((x) => x.photos.includes(added.file));
  assert.ok(cooked, "the AI dish is picked for a cooked shot");
  let g = await s.terminal((await (await s.post(`/api/suites/${id}/shots/generate`, {}, { "Idempotency-Key": randomUUID() })).json()).id);
  let frame = g.params.frames.find((f) => f.ref === cooked.id);
  assert.ok(frame.texts.some((x) => x.text === "烹饪示意 图片仅供参考"));
  assert.match(frame.photoNotes.join(), /AI 示意图/);
  await s.post(`/api/suites/${id}`, { aiLabel: false });
  g = await s.terminal((await (await s.post(`/api/suites/${id}/shots/generate`, {}, { "Idempotency-Key": randomUUID() })).json()).id);
  frame = g.params.frames.find((f) => f.ref === cooked.id);
  assert.ok(!frame.texts.some((x) => x.text.includes("仅供参考")));
  // The Word note never shows AI pictures as real photos.
  assert.equal((await s.request(`/api/suites/${id}/note.docx`)).status, 200);
});

test("template palettes always get a readable text color, an accent and a light page", async () => {
  const { paletteRoles } = await import("../shared/suite.js");
  const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
  for (const p of [["#BFDCE8", "#EAF4F8", "#D94F3D"], ["#E8572A", "#8A5A33", "#F5E6D0"], ["#ffffff", "#eeeeee", "#dddddd"], []]) {
    const [dark, , bg] = paletteRoles(p);
    assert.ok(lum(dark) <= 0.32, `${p} → text ${dark}`);
    assert.ok(lum(bg) >= 0.8, `${p} → page ${bg}`);
  }
  assert.equal(paletteRoles(["#BFDCE8", "#EAF4F8", "#D94F3D"])[1], "#d94f3d");
});
