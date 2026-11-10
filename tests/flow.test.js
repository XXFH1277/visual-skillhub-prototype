import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createWorkspace } from "../backend/app.js";
import { createProviders } from "../backend/providers.js";
import { fallbackAnalysis, fallbackStoryboard } from "../backend/planner.js";

const ACCESS = "test-only-access-code-123456";
const image = await sharp({ create: { width: 640, height: 640, channels: 3, background: "#6677aa" } }).png().toBuffer();

// Fake Kimi: rule-based directions/storyboard, configurable text read-back.
function fakeAI({ seen = null, ready = true } = {}) {
  const calls = { analyze: 0, storyboard: 0, read: 0, extract: 0 };
  return {
    calls,
    describe: () => (ready ? { ready: true, via: "kimi", label: "test" } : { ready: false, via: "rules", label: "off" }),
    async analyze(input, images, candidates) {
      calls.analyze++;
      calls.images = images.length;
      calls.candidates = candidates.map((c) => c.id);
      const result = fallbackAnalysis(input, candidates);
      result.analysis.product = "测试商品";
      return { result, via: ready ? "kimi" : "rules" };
    },
    async storyboard(input, images, result, chosen) {
      calls.storyboard++;
      calls.chosen = chosen.styleId;
      return { frames: fallbackStoryboard(input, chosen), via: ready ? "kimi" : "rules" };
    },
    async readTexts() {
      calls.read++;
      return seen || [];
    },
    async extractStyle() {
      calls.extract++;
      return { name: "测试风格", tagline: "t", categories: ["美妆护肤"], types: ["main"], tone: "清新", palette: ["#112233"], props: "p", light: "l", camera: "c", type: "t", core: "core" };
    },
  };
}
const writeResults = async (job, dir) => {
  for (let i = 1; i <= job.params.count; i++) await fs.writeFile(path.join(dir, `result-${i}.png`), image);
};

async function setup(t, runner = writeResults, options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-test-"));
  const ai = options.textAI || fakeAI();
  const w = await createWorkspace({
    dataDir: path.join(rootDir, ".data"),
    accessCode: ACCESS,
    runner,
    provider: { ready: true },
    textAI: ai,
    ...options,
  });
  const server = w.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const request = (route, init = {}) =>
    fetch(url + route, { ...init, headers: { "X-Requested-With": "SkillHub", Cookie: cookie, ...init.headers } });
  const login = await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: ACCESS }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await w.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const post = (route, body, headers = {}) =>
    request(route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const draft = async ({ fields = {}, main = image, mime = "image/png", refs = 0 } = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ skillId: "product", copy: "保温杯\n保温12小时\n一键开盖", count: "1", size: "1:1", ...fields }))
      form.append(k, v);
    if (main) form.append("main", new Blob([main], { type: mime }), "main.png");
    for (let i = 0; i < refs; i++) form.append("reference", new Blob([image], { type: "image/png" }), "ref.png");
    return request("/api/drafts", { method: "POST", body: form });
  };
  const settle = async (id) => {
    for (let i = 0; i < 200; i++) {
      const d = await (await request("/api/drafts/" + id)).json();
      if (!["analyzing", "storyboarding"].includes(d.status)) return d;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("draft did not settle");
  };
  const ready = async (id, index = 0) => {
    const d = await settle(id);
    assert.equal(d.status, "directions", JSON.stringify(d));
    const chosen = await post(`/api/drafts/${id}/choose`, { index });
    assert.equal(chosen.status, 200, await chosen.clone().text());
    return settle(id);
  };
  const submit = async ({ fields, edit, key = randomUUID(), extra = {}, main } = {}) => {
    const created = await draft({ fields, main });
    assert.equal(created.status, 202, await created.clone().text());
    const d = await ready((await created.json()).id);
    const frames = structuredClone(d.frames);
    edit?.(frames);
    return post("/api/jobs", { draftId: d.id, frames, ...extra }, { "Idempotency-Key": key });
  };
  const terminal = async (id) => {
    for (let i = 0; i < 300; i++) {
      const job = await (await request(`/api/jobs/${id}`)).json();
      if (!["queued", "running"].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("job did not finish");
  };
  const balance = async () => (await (await request("/api/workspace")).json()).account.balance;
  return { request, post, draft, ready, settle, submit, terminal, balance, url, w, ai };
}

test("upload → directions → choose → storyboard → confirm → generate → proofread", async (t) => {
  const ai = fakeAI({ seen: ["保温杯", "保温12小时"] });
  const s = await setup(t, writeResults, { textAI: ai });
  const created = await s.draft({ refs: 1, fields: { count: "2" } });
  assert.equal(created.status, 202);
  const id = (await created.json()).id;
  const d = await s.settle(id);
  assert.equal(d.status, "directions");
  assert.equal(d.directions.length, 3);
  assert.equal(d.analysis.product, "测试商品");
  assert.equal(ai.calls.images, 2);
  assert.ok(ai.calls.candidates.includes("wabi") && !ai.calls.candidates.includes("cream-home"));
  assert.equal((await s.post("/api/jobs", { draftId: id, frames: [] }, { "Idempotency-Key": randomUUID() })).status, 400);
  const ready = await s.ready(id, 1);
  assert.equal(ready.status, "ready");
  assert.equal(ai.calls.chosen, d.directions[1].styleId);
  assert.equal(await s.balance(), 500);
  const frames = structuredClone(ready.frames);
  frames[0] = { ...frames[0], textMode: "ai", texts: [{ role: "headline", text: "保温杯" }, { role: "point", text: "一键开盖" }] };
  frames[1] = { ...frames[1], textMode: "overlay", layout: "bottom", texts: [{ role: "headline", text: "精确排字" }] };
  const res = await s.post("/api/jobs", { draftId: id, frames }, { "Idempotency-Key": randomUUID() });
  assert.equal(res.status, 202, await res.clone().text());
  const job = await res.json();
  assert.equal(job.cost, 20);
  assert.equal(job.params.direction.styleId, d.directions[1].styleId);
  assert.equal(job.params.frames[0].layout, "free");
  const done = await s.terminal(job.id);
  assert.equal(done.status, "succeeded", done.error);
  assert.equal(ai.calls.read, 1);
  assert.deepEqual(done.manifest.textCheck[0].problems.map((p) => p.text), ["一键开盖"]);
  assert.equal(await s.balance(), 480);
  assert.equal((await s.request(`/api/jobs/${job.id}/source/input-0.png`)).status, 200);
  assert.equal((await s.request(`/api/jobs/${job.id}/source/text-check.json`)).status, 404);
  // overlay frame: free text edit re-exports without generation
  const before = done.manifest.assets[1].sha256;
  const edited = await s.post(`/api/jobs/${job.id}/texts`, { frames: [null, { texts: [{ role: "headline", text: "改过的字" }] }] });
  assert.equal(edited.status, 200, await edited.clone().text());
  const after = await edited.json();
  assert.equal(after.params.frames[1].texts[0].text, "改过的字");
  assert.notEqual(after.manifest.assets[1].sha256, before);
  assert.equal(after.params.frames[0].texts[0].text, "保温杯");
  assert.equal(await s.balance(), 480);
});

test("detail pages: vertical screens stitched into one long image", async (t) => {
  const s = await setup(t, async (job, dir) => {
    const tall = await sharp({ create: { width: 768, height: 1024, channels: 3, background: "#aa8866" } }).png().toBuffer();
    for (let i = 1; i <= job.params.count; i++) await fs.writeFile(path.join(dir, `result-${i}.png`), tall);
  });
  const res = await s.submit({ fields: { skillId: "detail", count: "4", size: "3:4", copy: "陶瓷杯\n手工上釉\n杯口圆润\n早餐时光" } });
  assert.equal(res.status, 202, await res.clone().text());
  const done = await s.terminal((await res.json()).id);
  assert.equal(done.status, "succeeded", done.error);
  const modules = done.manifest.assets.filter((a) => a.role === "module");
  const long = done.manifest.assets.find((a) => a.role === "long");
  assert.equal(modules.length, 4);
  assert.ok(modules.every((m) => m.width === 750 && m.height === 1000));
  assert.equal(long.height, 4000);
  assert.equal(await s.balance(), 500 - 120);
});

test("posters work without images; product requires one; invalid edits never charge", async (t) => {
  let received;
  const s = await setup(t, async (job, dir) => {
    received = job.params;
    await writeResults(job, dir);
  });
  const res = await s.submit({ main: null, fields: { skillId: "poster", size: "3:4", copy: "秋日咖啡节\n第二杯半价" } });
  assert.equal(res.status, 202);
  assert.equal((await s.terminal((await res.json()).id)).status, "succeeded");
  assert.deepEqual(received.inputs, []);
  assert.equal(received.hasMainImage, false);
  assert.equal((await s.draft({ main: null })).status, 400);
  assert.equal((await s.draft({ fields: { count: "9" } })).status, 400);
  assert.equal((await s.draft({ fields: { skillId: "constructor" } })).status, 400);
  assert.equal((await s.draft({ main: Buffer.from("<script>") })).status, 400);
  assert.equal((await s.draft({ mime: "image/svg+xml" })).status, 400);
  const balance = await s.balance();
  const long = await s.submit({ edit: (f) => (f[0].texts = [{ role: "headline", text: "长".repeat(40) }]) });
  assert.equal(long.status, 400);
  const extra = await s.submit({ edit: (f) => f.push(f[0]) });
  assert.equal(extra.status, 400);
  const role = await s.submit({ edit: (f) => (f[0].texts = [{ role: "constructor", text: "x" }]) });
  assert.equal(role.status, 400);
  assert.equal(await s.balance(), balance);
});

test("single-frame regenerate can switch to exact text; failures refund", async (t) => {
  let fail = false;
  const s = await setup(t, async (job, dir) => {
    if (fail) throw new Error("upstream broke");
    await writeResults(job, dir);
  });
  const res = await s.submit({
    fields: { count: "2" },
    edit: (f) => {
      f[1] = { ...f[1], textMode: "ai", layout: "free", texts: [{ role: "headline", text: "第二张" }] };
    },
  });
  const done = await s.terminal((await res.json()).id);
  const redo = await s.post(`/api/jobs/${done.id}/retry`, { frame: 1, textMode: "overlay" }, { "Idempotency-Key": randomUUID() });
  assert.equal(redo.status, 202);
  const one = await s.terminal((await redo.json()).id);
  assert.equal(one.status, "succeeded");
  assert.equal(one.params.count, 1);
  assert.equal(one.params.frames[0].textMode, "overlay");
  assert.equal(one.sourceId, done.id);
  assert.equal(await s.balance(), 500 - 20 - 10);
  fail = true;
  const again = await s.post(`/api/jobs/${done.id}/retry`, {}, { "Idempotency-Key": randomUUID() });
  const failed = await s.terminal((await again.json()).id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /upstream broke/);
  assert.equal(await s.balance(), 470);
});

test("no Kimi configured: common styles, rule storyboard, no proofreading", async (t) => {
  const ai = fakeAI({ ready: false });
  const s = await setup(t, writeResults, { textAI: ai });
  const d = await s.ready((await (await s.draft()).json()).id);
  assert.equal(d.via, "rules");
  const res = await s.post("/api/jobs", { draftId: d.id, frames: d.frames }, { "Idempotency-Key": randomUUID() });
  const done = await s.terminal((await res.json()).id);
  assert.equal(done.status, "succeeded");
  assert.equal(ai.calls.read, 0);
  assert.deepEqual(done.manifest.textCheck, []);
});

test("duplicate confirmations create one job and one charge", async (t) => {
  let calls = 0;
  const s = await setup(t, async (job, dir) => {
    calls++;
    await writeResults(job, dir);
  });
  const d = await s.ready((await (await s.draft()).json()).id);
  const key = randomUUID();
  const send = () => s.post("/api/jobs", { draftId: d.id, frames: d.frames }, { "Idempotency-Key": key });
  const jobs = await Promise.all((await Promise.all([send(), send()])).map((r) => r.json()));
  assert.equal(jobs[0].id, jobs[1].id);
  assert.equal((await s.terminal(jobs[0].id)).status, "succeeded");
  assert.equal(calls, 1);
  assert.equal(await s.balance(), 490);
});

test("style library: list, filter data, upload → AI recipe, pick it for a draft, delete", async (t) => {
  const ai = fakeAI();
  const s = await setup(t, writeResults, { textAI: ai });
  const list = (await (await s.request("/api/styles")).json()).styles;
  assert.ok(list.length >= 30);
  assert.ok(list.every((x) => x.categories.length && x.types.length));
  const form = new FormData();
  form.append("image", new Blob([image], { type: "image/png" }), "good.png");
  form.append("prompt", "soft light, ceramic, moss");
  const up = await s.request("/api/styles", { method: "POST", body: form });
  assert.equal(up.status, 202, await up.clone().text());
  const id = (await up.json()).id;
  let style;
  for (let i = 0; i < 100; i++) {
    style = await (await s.request("/api/styles/" + id)).json();
    if (style.status !== "analyzing") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(style.status, "ready");
  assert.equal(style.name, "测试风格");
  assert.equal(style.prompt, "soft light, ceramic, moss");
  assert.equal(style.cover, `/api/styles/${id}/cover`);
  assert.equal((await s.request(style.cover)).status, 200);
  // a chosen style goes first and its sample is attached to the job as a style reference
  const created = await s.draft({ fields: { styleId: id } });
  const d = await s.settle((await created.json()).id);
  assert.equal(d.directions[0].styleId, id);
  const ready = await s.ready(d.id, 0);
  const res = await s.post("/api/jobs", { draftId: d.id, frames: ready.frames }, { "Idempotency-Key": randomUUID() });
  const job = await res.json();
  assert.equal(job.params.styleRef, "style-ref.png");
  assert.equal((await s.request(`/api/styles/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await s.request(`/api/styles/wabi`, { method: "DELETE" })).status, 403);
  assert.equal((await s.draft({ fields: { styleId: "nope" } })).status, 400);
});

test("outputs require login; missing output fails and refunds", async (t) => {
  const s = await setup(t, async () => {});
  const done = await s.terminal((await (await s.submit()).json()).id);
  assert.equal(done.status, "failed");
  assert.equal(await s.balance(), 500);
  assert.equal((await fetch(s.url + `/api/jobs/${done.id}`)).status, 401);
  assert.equal((await fetch(s.url + `/api/drafts/x`)).status, 401);
  assert.equal((await s.request("/.data/access-code.txt")).status, 404);
});

test("queue runs one job at a time; cancelling refunds only that job", async (t) => {
  let running = 0, max = 0, first = true;
  const s = await setup(t, async (job, dir, signal) => {
    running++;
    max = Math.max(max, running);
    try {
      if (first) {
        first = false;
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      } else await writeResults(job, dir);
    } finally {
      running--;
    }
  });
  const a = await (await s.submit()).json();
  const b = await (await s.submit()).json();
  await s.request(`/api/jobs/${a.id}/cancel`, { method: "POST" });
  assert.equal((await s.terminal(a.id)).status, "cancelled");
  assert.equal((await s.terminal(b.id)).status, "succeeded");
  assert.equal(max, 1);
  assert.equal(await s.balance(), 490);
});

test("public-origin mode rejects other origins and sets a secure cookie", async (t) => {
  const s = await setup(t, writeResults, { publicOrigin: "https://workspace.example" });
  const response = await s.request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: ACCESS }) });
  assert.match(response.headers.get("set-cookie"), /Secure/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.equal((await s.request("/api/drafts", { method: "POST", headers: { Origin: "https://untrusted.example" } })).status, 403);
  const status = (headers) =>
    new Promise((resolve, reject) => {
      http.get(s.url + "/api/health", { headers }, (r) => (r.resume(), resolve(r.statusCode))).on("error", reject);
    });
  assert.equal(await status({ Host: "untrusted.example" }), 403);
  assert.equal(await status({ Host: "workspace.example", Origin: "https://workspace.example" }), 200);
});

test("API mode: brief carries the visual system and exact text; covers feed the library", async (t) => {
  const sent = [];
  const providers = createProviders({
    env: { IMAGE_API_BASE_URL: "https://relay.example", IMAGE_API_KEY: "private-test-key", IMAGE_API_MODEL_2K: "m25", IMAGE_API_MODEL_4K: "m20" },
    codexCheck: async () => ({ ready: true }),
    fetchImpl: async (url, init) => {
      if (url.pathname.endsWith("models")) return Response.json({ data: [{ id: "m25" }, { id: "m20" }] });
      const json = typeof init.body === "string" ? JSON.parse(init.body) : null;
      sent.push({ path: url.pathname, model: json?.model || init.body.get("model"), prompt: json?.prompt || init.body.get("prompt"), images: json ? [] : init.body.getAll("image[]").map((f) => f.name) });
      return Response.json({ data: [{ b64_json: image.toString("base64") }] });
    },
  });
  const s = await setup(t, null, { providers });
  const res = await s.submit({
    fields: { count: "2" },
    extra: { providerMode: "api", resolution: "2K" },
    edit: (f) => {
      f[0] = { ...f[0], textMode: "ai", texts: [{ role: "headline", text: "一键开盖" }] };
      f[1] = { ...f[1], textMode: "overlay", layout: "bottom", texts: [{ role: "headline", text: "保温12小时" }] };
    },
  });
  const done = await s.terminal((await res.json()).id);
  assert.equal(done.status, "succeeded", done.error);
  // Frames run concurrently; order the requests by frame.
  sent.sort((a, b) => Number(/后期会在这里排字/.test(a.prompt)) - Number(/后期会在这里排字/.test(b.prompt)));
  assert.deepEqual(sent[0].images, ["input-0.png", "style-ref.png"]);
  assert.deepEqual(sent[1].images, ["input-0.png"]);
  assert.match(sent[0].prompt, /"一键开盖"/);
  assert.match(sent[0].prompt, /【视觉系统/);
  assert.match(sent[1].prompt, /后期会在这里排字/);
  assert.doesNotMatch(sent[1].prompt, /保温12小时/);
  // generate a cover for a built-in style: text-only request, then it shows in the library
  const before = await s.balance();
  const cover = await s.post("/api/styles/wabi/cover", { providerMode: "api" }, { "Idempotency-Key": randomUUID() });
  assert.equal(cover.status, 202, await cover.clone().text());
  const coverDone = await s.terminal((await cover.json()).id);
  assert.equal(coverDone.status, "succeeded", coverDone.error);
  assert.equal(sent.at(-1).path, "/v1/images/generations");
  assert.match(sent.at(-1).prompt, /侘寂|wabi/);
  assert.equal(coverDone.cost, 0);
  assert.equal(await s.balance(), before);
  const wabi = await (await s.request("/api/styles/wabi")).json();
  assert.equal(wabi.cover, "/api/styles/wabi/cover");
  // the next job using wabi attaches the cover as a style reference
  const next = await s.submit({ fields: { styleId: "wabi" }, extra: { providerMode: "api", resolution: "2K" } });
  const nextDone = await s.terminal((await next.json()).id);
  assert.equal(nextDone.status, "succeeded", nextDone.error);
  assert.deepEqual(sent.at(-1).images, ["input-0.png", "style-ref.png"]);
  assert.match(sent.at(-1).prompt, /风格样图/);
  const up = await s.post(`/api/jobs/${done.id}/upscale`, { asset: "image-1.png" }, { "Idempotency-Key": randomUUID() });
  assert.equal(up.status, 202, await up.clone().text());
  assert.equal((await s.terminal((await up.json()).id)).status, "succeeded");
  assert.equal(sent.at(-1).model, "m20");
  assert.doesNotMatch(await (await s.request("/api/workspace")).text(), /private-test-key/);
  const batch = await (await s.post("/api/styles-covers", { providerMode: "api" })).json();
  assert.equal(batch.missing, 0, "bundled covers ship with the repo");
  const all = (await (await s.request("/api/styles")).json()).styles;
  assert.equal(all.filter((x) => x.source === "builtin" && !x.types.includes("interior") && !x.cover).length, 0);
});

test("partial batch exports completed frames and a duplicate resume bills and requests only the missing frame", async t => {
  const calls = [];
  const providers = createProviders({
    env: { IMAGE_API_BASE_URL:"https://relay.example", IMAGE_API_KEY:"test", IMAGE_API_MODEL_2K:"test-model", IMAGE_API_CONCURRENCY:"1" },
    codexCheck:async()=>({ready:true}),
    fetchImpl:async(url, init)=>{
      if(url.pathname.endsWith("models")) return Response.json({data:[{id:"test-model"}]});
      calls.push(init.body.get("prompt"));
      assert.equal(init.body.get("model"),"test-model");
      assert.equal(init.body.has("background"),false);
      if(calls.length===2) return new Response(null,{status:502});
      return Response.json({data:[{b64_json:image.toString("base64")}]});
    }
  });
  const s=await setup(t,null,{providers});
  const created=await s.submit({fields:{count:"2"},extra:{providerMode:"api",resolution:"2K"}});
  const partial=await s.terminal((await created.json()).id);
  assert.equal(partial.status,"partial",partial.error);
  assert.deepEqual(partial.manifest.missing,[1]);
  assert.equal(partial.manifest.assets.length,1);
  assert.equal((await s.request(`/api/jobs/${partial.id}/files/image-1.png`)).status,200);
  assert.equal((await s.request(`/api/jobs/${partial.id}/files/image-2.png`)).status,404);
  assert.equal(await s.balance(),490);
  const retry=()=>s.post(`/api/jobs/${partial.id}/retry`,{},{ "Idempotency-Key":randomUUID() }).then(r=>r.json());
  const [a,b]=await Promise.all([retry(),retry()]);
  assert.equal(a.id,b.id);
  const done=await s.terminal(a.id);
  assert.equal(done.status,"succeeded",done.error);
  assert.deepEqual(done.params.reusedFrames,[0]);
  assert.equal(done.cost,10);
  assert.equal(done.manifest.assets[0].sha256,partial.manifest.assets[0].sha256);
  assert.equal(done.manifest.assets.length,2);
  assert.equal(calls.length,3);
  assert.equal(calls[2],calls[1]);
  assert.equal(await s.balance(),480);
  const tweak = frame => s.post(`/api/jobs/${partial.id}/tweak`, { frame, instruction: "保留商品，背景调亮" }, { "Idempotency-Key": randomUUID() });
  assert.equal((await tweak(1)).status, 400);
  const edited = await s.terminal((await (await tweak(0)).json()).id);
  assert.equal(edited.status, "succeeded", edited.error);
  assert.deepEqual(edited.params.tweakOf, { jobId: partial.id, frame: 0 });
  assert.equal(edited.params.frames.length, 1);
  assert.equal(calls.length, 4);
  assert.equal(await s.balance(), 470);
});

test("authorized previews are resized and privately cacheable; downloading returns the exact export", async t => {
  const s = await setup(t);
  const j = await s.terminal((await (await s.submit()).json()).id);
  const asset = j.manifest.assets.find(a=>a.role==="image");
  const url = `/api/jobs/${j.id}/files/${asset.name}?v=${encodeURIComponent(j.updatedAt)}`;
  const preview = url+"&thumb=320";
  const [first, concurrent] = await Promise.all([s.request(preview), s.request(preview)]);
  assert.equal(first.status,200);
  assert.equal(concurrent.status,200);
  assert.match(first.headers.get("cache-control"),/private, max-age=/);
  assert.match(first.headers.get("vary"),/Cookie/i);
  const bytes=Buffer.from(await first.arrayBuffer());
  assert.deepEqual(bytes,Buffer.from(await concurrent.arrayBuffer()));
  const meta=await sharp(bytes).metadata();
  assert.equal(meta.format,"webp");
  assert.ok(meta.width <= 320);
  assert.equal((await fetch(s.url+preview)).status,401);
  const dl=await s.request(url+"&thumb=320&download=1");
  const {createHash}=await import("node:crypto");
  assert.equal(createHash("sha256").update(Buffer.from(await dl.arrayBuffer())).digest("hex"),asset.sha256);
});
