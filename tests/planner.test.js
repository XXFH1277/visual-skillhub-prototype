import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { normalizeAnalysis, normalizeStoryboard, sanitizeFrames, analyzeMessages, storyboardMessages, sceneGuide, candidatesFor } from "../backend/planner.js";
import { STYLES } from "../shared/styles.js";
import { compareTexts, confirmProblems, createTextAI } from "../backend/text-ai.js";
import { framePrompt, frameInputs } from "../backend/prompts.js";
import { renderLayoutSketch, overlayTexts, wrap } from "../backend/render.js";
const lib = STYLES.map((x) => ({ ...x, status: "ready" }));

test("skills and the style library feed the planner, not the image model", () => {
  for (const id of ["product", "detail", "poster", "interior"]) assert.ok(sceneGuide(id).length > 400, id);
  const candidates = candidatesFor(lib, "product");
  assert.ok(candidates.length > 20 && candidates.every((c) => !c.types.includes("interior")));
  const m = analyzeMessages({ skillId: "product", count: 2, size: "1:1", copy: "保温杯", hasMain: true, hasReference: true }, candidates);
  assert.match(m.system, /wabi｜侘寂自然/);
  assert.match(m.system, /styleId="ref"/);
  const result = normalizeAnalysis({ directions: [{ styleId: "wabi", conceptName: "一日三刻" }] }, { skillId: "product" }, candidates);
  const sb = storyboardMessages({ skillId: "detail", count: 6, copy: "" }, result, result.directions[0]);
  assert.match(sb.system, /一日三刻/);
  assert.match(sb.system, /恰好 6 个 frames/);
  const prompt = framePrompt(
    { skillId: "product", size: "1:1", hasMainImage: true, refCount: 0, inputs: ["input-0.png"], styleRef: null, direction: result.directions[0], frames: [{ title: "主图", layout: "none", textMode: "none", texts: [], scene: "浅木桌面" }] },
    0,
  );
  assert.ok(prompt.length < 1400, prompt.length);
  assert.match(prompt, /陶/);
  assert.doesNotMatch(prompt, /五要素|光照三要素|Skill/);
});

test("AI output is repaired: unknown styles dropped, directions topped up, frames sanitized", () => {
  const candidates = candidatesFor(lib, "product");
  const r = normalizeAnalysis(
    `好的 {"analysis":{"product":"杯子","category":"乱写"},"directions":[{"styleId":"nope"},{"styleId":"dark","palette":["#000000","bad"]},{"styleId":"dark"}]}`,
    { skillId: "product", styleId: "" },
    candidates,
  );
  assert.equal(r.directions.length, 3);
  assert.equal(r.directions[0].styleId, "dark");
  assert.deepEqual(r.directions[0].palette, ["#000000"]);
  assert.equal(new Set(r.directions.map((d) => d.styleId)).size, 3);
  assert.equal(r.analysis.category, "");
  const frames = normalizeStoryboard({ frames: [{ title: "a", scene: "s", textMode: "ai", texts: [{ role: "x", text: "长".repeat(100) }] }] }, { skillId: "product", count: 2 });
  assert.equal(frames, null, "missing scene for frame 2 is rejected");
  const ok = normalizeStoryboard({ frames: [{ scene: "s", texts: [{ role: "headline", text: "超".repeat(30) }] }, { scene: "t" }] }, { skillId: "product", count: 2 });
  assert.equal(Array.from(ok[0].texts[0].text).length, 16);
  assert.equal(ok[0].layout, "free");
  assert.equal(ok[1].textMode, "none");
  const interior = normalizeStoryboard({ frames: [{ scene: "s", texts: [{ role: "headline", text: "x" }], textMode: "ai" }] }, { skillId: "interior", count: 1 });
  assert.deepEqual(interior[0].texts, []);
  assert.throws(() => sanitizeFrames([{ scene: "s", texts: [{ role: "headline", text: "长".repeat(17) }] }], "product", 1, { strict: true }), /不能超过/);
});

test("proofreading compares exact text, tolerant of spacing and punctuation", () => {
  const ok = compareTexts([{ role: "headline", text: "保温 12 小时！" }], ["保温12小时", "THERMOS"]);
  assert.equal(ok.ok, true);
  const bad = compareTexts([{ role: "headline", text: "一键开盖" }, { role: "price", text: "¥99" }], ["一键开羔", "99"]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems.map((p) => p.text), ["一键开盖"]);
  // Big number and small label on separate lines, read out of order.
  const split = compareTexts([{ role: "point", text: "60米深海生长" }, { role: "point", text: "-196℃液氮锁鲜" }, { role: "point", text: "深冷链全程冷链" }], ["深海生长", "液氮锁鲜", "全程冷链", "60米", "-196℃", "深冷链"]);
  assert.equal(split.ok, true);
  assert.equal(compareTexts([{ role: "point", text: "60米深海生长" }], ["深海生长", "80米"]).ok, false);
  assert.equal(compareTexts([{ role: "point", text: "深冷链全程冷链" }], ["深冷链", "全程冷琏"]).ok, false);
});

test("Kimi client sends images, falls back to common styles on failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-"));
  const file = path.join(dir, "a.png");
  await sharp({ create: { width: 300, height: 300, channels: 3, background: "#fff" } }).png().toFile(file);
  const candidates = candidatesFor(lib, "product");
  let body;
  const ai = createTextAI({
    env: { KIMI_API_KEY: "k", KIMI_MODEL: "kimi-test" },
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      assert.equal(url.href, "https://api.moonshot.cn/v1/chat/completions");
      return Response.json({ choices: [{ message: { content: JSON.stringify({ analysis: { product: "杯子" }, directions: [{ styleId: "wabi", conceptName: "一日三刻" }] }) } }] });
    },
  });
  const r = await ai.analyze({ skillId: "product", count: 1, size: "1:1", copy: "杯子", hasMain: true }, [file], candidates);
  assert.equal(r.via, "kimi");
  assert.equal(r.result.directions[0].conceptName, "一日三刻");
  assert.equal(body.model, "kimi-test");
  assert.match(body.messages[1].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  const broken = createTextAI({ env: { KIMI_API_KEY: "k" }, fetchImpl: async () => new Response("{}", { status: 500 }) });
  const f = await broken.analyze({ skillId: "product", count: 1, size: "1:1", copy: "杯子" }, [], candidates);
  assert.equal(f.via, "rules");
  assert.match(f.warning, /500/);
  assert.equal(f.result.directions.length, 3);
  assert.equal(createTextAI({ env: {} }).describe().ready, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("DeepSeek detail planning sends the direction and frame schemas alongside the photo", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "detail-plan-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "photo.png");
  await sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } }).png().toFile(file);
  const input = { skillId: "detail", count: 4, size: "3:4", copy: "水瓶", hasMain: true };
  const candidates = candidatesFor(lib, "detail");
  const ai = createTextAI({
    env: { TEXT_API_KEY: "test", TEXT_API_MODEL: "deepseek-test" },
    fetchImpl: async (_url, init) => {
      const user = JSON.parse(init.body).messages.find(m => m.role === "user");
      const prompt = user.content.find(p => p.type === "text").text;
      let answer = "这是一份详情页建议";
      if (prompt.includes('"directions"') && prompt.includes(candidates[0].id)) {
        answer = JSON.stringify({ directions: [{ styleId: candidates[0].id, conceptName: "水瓶展示" }] });
      } else if (prompt.includes('"frames"')) {
        answer = JSON.stringify({ frames: Array.from({ length: 4 }, () => ({ scene: "水瓶实拍" })) });
      }
      return Response.json({ choices: [{ message: { content: answer } }] });
    },
  });
  const plan = await ai.analyze(input, [file], candidates);
  assert.equal(plan.via, "deepseek");
  assert.equal(plan.result.directions[0].conceptName, "水瓶展示");
  const board = await ai.storyboard(input, [file], plan.result, plan.result.directions[0]);
  assert.equal(board.via, "deepseek");
  assert.equal(board.frames.length, 4);
});

test("program typesetting renders sketches and overlays", async () => {
  assert.deepEqual(wrap("一二三四五", 10, 30), ["一二三", "四五"]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "render-"));
  const photo = await sharp({ create: { width: 500, height: 400, channels: 3, background: "#88aacc" } }).png().toBuffer();
  const out = path.join(dir, "s.png");
  await renderLayoutSketch({ width: 768, height: 1024, layout: "top", texts: [{ role: "headline", text: "秋日新品" }, { role: "cta", text: "立即购买" }], mainImage: photo, accent: "#e8541e" }, out);
  assert.equal((await sharp(out).metadata()).height, 1024);
  const over = path.join(dir, "o.png");
  await overlayTexts(photo, { layout: "left", texts: [{ role: "headline", text: "这是一个很长很长的标题需要换行显示" }], accent: "#e8541e" }, over);
  assert.equal((await sharp(over).metadata()).width, 500);
  await fs.rm(dir, { recursive: true, force: true });
});

test("relay model check switches to an available Kimi model", async () => {
  const ai = createTextAI({
    env: { KIMI_API_KEY: "k", KIMI_API_BASE_URL: "https://relay.example", KIMI_MODEL: "kimi-k3" },
    fetchImpl: async (url) => {
      assert.equal(url.href, "https://relay.example/v1/models");
      return Response.json({ data: [{ id: "gpt-image-2.5" }, { id: "kimi-k2.6" }, { id: "kimi-k2.5" }] });
    },
  });
  const state = await ai.check();
  assert.equal(state.model, "kimi-k2.6");
  assert.deepEqual(state.models, ["kimi-k2.6", "kimi-k2.5"]);
});

test("proofreading accepts the shapes models actually answer in", async () => {
  const { readLines } = await import("../backend/text-ai.js");
  assert.deepEqual(readLines('{"lines":["舟山樱花虾","250g/包"]}'), ["舟山樱花虾", "250g/包"]);
  assert.deepEqual(readLines('["舟山樱花虾"]'), ["舟山樱花虾"]);
  assert.deepEqual(readLines('```json\n{"texts":[{"text":"白灼"}]}\n```'), ["白灼"]);
  assert.deepEqual(readLines('{"lines":"清蒸\\n白灼"}'), ["清蒸", "白灼"]);
  assert.deepEqual(readLines("清蒸\n白灼"), ["清蒸", "白灼"]);
});

test("image probe reports what a relay model returns (SVG, error) without leaking the key", async () => {
  const { probeImageModel } = await import("../backend/image-api.js");
  const config = { base: "https://relay.example/v1/", key: "sk-secret" };
  let sent;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>';
  const ok = await probeImageModel(config, { model: "gpt-image-2.6-sunburst", prompt: "logo", format: "svg", background: "transparent" }, async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(svg).toString("base64") }] }), { status: 200 });
  });
  assert.equal(sent.output_format, "svg");
  assert.equal(sent.background, "transparent");
  assert.equal(ok.kind, "svg");
  const bad = await probeImageModel(config, { model: "nope", prompt: "x" }, async () => new Response("model nope not found for sk-secret", { status: 404 }));
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 404);
  assert.doesNotMatch(bad.message, /sk-secret/);
});

test("usage records carry the product and step they were made for", async () => {
  const { setUsageSink, recordUsage, withUsage } = await import("../backend/usage.js");
  const seen = [];
  setUsageSink((u) => seen.push(u));
  await withUsage({ suiteId: "s1", purpose: "profile" }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    recordUsage({ kind: "text", promptTokens: 1200, completionTokens: 300 });
    await withUsage({ purpose: "proofread", jobId: "j1" }, async () => recordUsage({ kind: "text", promptTokens: 2000 }));
  });
  recordUsage({ kind: "image" });
  setUsageSink(null);
  assert.deepEqual(seen.map((u) => [u.suiteId, u.purpose, u.jobId]), [["s1", "profile", undefined], ["s1", "proofread", "j1"], [undefined, undefined, undefined]]);
});

test("JSON from the model survives plain quotes inside values and trailing commas", async () => {
  const { parseJsonObject } = await import("../backend/json.js");
  const bad = '好的：{"looks":[{"conceptName":"金鳞宴","layout":"顶部写"深海大黄鱼"四个字，右上角胶囊","why":"大字醒目",}]}';
  const d = parseJsonObject(bad);
  assert.equal(d.looks[0].layout, '顶部写"深海大黄鱼"四个字，右上角胶囊');
  assert.equal(d.looks[0].why, "大字醒目");
  assert.deepEqual(parseJsonObject('{"a":"x\ny"}'), { a: "x\ny" });
  assert.throws(() => parseJsonObject("没有 JSON"), /无法解析/);
});

test("fresh seafood and farm produce keep the merchant's real photo as the product", () => {
  const candidates = candidatesFor(lib, "poster");
  const result = normalizeAnalysis({ analysis: { category: "生鲜水产" }, directions: [{ styleId: candidates[0].id, conceptName: "木桌热鲜饭", props: "白瓷浅盘、竹筷", light: "窗侧暖光，虾身油润反光", camera: "手入画一角" }] }, { skillId: "poster" }, candidates);
  const chosen = result.directions[0];
  const sb = storyboardMessages({ skillId: "poster", count: 1, copy: "", hasMain: true }, result, chosen);
  assert.match(sb.system, /主体就是商家实拍照片本身/);
  assert.doesNotMatch(sb.system, /油润反光|手入画一角|大胆造景/);
  // No photo uploaded, or another category: the creative brief stays as it was.
  assert.match(storyboardMessages({ skillId: "poster", count: 1, copy: "", hasMain: false }, result, chosen).system, /大胆造景/);
  const other = { ...result, analysis: { ...result.analysis, category: "美妆护肤" } };
  assert.match(storyboardMessages({ skillId: "poster", count: 1, copy: "", hasMain: true }, other, chosen).system, /油润反光/);

  const base = { skillId: "poster", size: "3:4", hasMainImage: true, refCount: 0, inputs: ["input-0.png"], styleRef: "style-ref.png", direction: chosen, frames: [{ title: "海报", layout: "free", textMode: "ai", texts: [{ role: "headline", text: "海中樱花" }], scene: "虾仁特写" }] };
  const real = { ...base, fidelity: "real" };
  const prompt = framePrompt(real, 0);
  assert.match(prompt, /真实细节不要修掉/);
  assert.match(prompt, /【真实度】/);
  assert.doesNotMatch(prompt, /油润反光|手入画一角|可以换角度摆放进新场景|风格样图|Style:/);
  assert.match(prompt, /色板/);
  assert.deepEqual(frameInputs(real, 0), ["input-0.png"], "no AI-made style sample next to a real photo");
  assert.deepEqual(frameInputs(base, 0), ["input-0.png", "style-ref.png"]);
  assert.match(framePrompt(base, 0), /可以换角度摆放进新场景/);
  // Cinematic shots and dish pictures keep their own way of using the photo.
  const hero = { ...real, hasMainImage: false, frames: [{ ...base.frames[0], photos: ["p.png"], photoUse: "hero" }] };
  assert.match(framePrompt(hero, 0), /场景完全重新构图/);
  assert.doesNotMatch(framePrompt(hero, 0), /【真实度】/);
});

test("a line is only called wrong when two reads agree; one good read clears it, unreadable lettering is 'unsure'", () => {
  const want = [{ role: "headline", text: "源头产地" }, { role: "point", text: "舟山直发" }, { role: "point", text: "顺丰冷链" }];
  const read = (lines) => compareTexts(want, lines);
  // Both reads see the same typo → wrong, with what the picture seems to say.
  const typo = confirmProblems(read(["源头产地", "丹山直发", "顺丰冷链"]), read(["源头产地", "丹山直发", "顺丰冷链"]));
  assert.equal(typo.ok, false);
  assert.deepEqual(typo.problems.map((p) => [p.text, p.kind, p.near]), [["舟山直发", "typo", "丹山直发"]]);
  // The second read gets it right → the first was a misread.
  assert.equal(confirmProblems(read(["源头产地", "丹山直发", "顺丰冷链"]), read(["源头产地", "舟山直发", "顺丰冷链"])).ok, true);
  // Brush-lettered headline neither read can make out → unsure, not an error.
  const brush = confirmProblems(read(["舟山直发", "顺丰冷链"]), read(["舟山直发", "顺丰冷链", "乱"]));
  assert.equal(brush.ok, null);
  assert.deepEqual(brush.unsure.map((p) => p.text), ["源头产地"]);
  // A selling point missing from both reads → wrong.
  const missing = confirmProblems(read(["源头产地", "舟山直发"]), read(["源头产地", "舟山直发"]));
  assert.deepEqual(missing.problems.map((p) => [p.text, p.kind]), [["顺丰冷链", "missing"]]);
});
