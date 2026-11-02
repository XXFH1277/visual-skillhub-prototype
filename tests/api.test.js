import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createWorkspace } from "../backend/app.js";
import http from "node:http";
import { createProviders } from "../backend/providers.js";

const ACCESS = "test-only-access-code-123456";
const image = await sharp({
  create: { width: 320, height: 320, channels: 3, background: "#6677aa" },
})
  .png()
  .toBuffer();
async function setup(t, runner, options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-test-"));
  const dir = path.join(rootDir, ".data");
  const w = await createWorkspace({
    dataDir: dir,
    accessCode: ACCESS,
    runner,
    provider: { ready: true },
    ...options,
  });
  const server = w.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const request = (route, init = {}) =>
    fetch(url + route, {
      ...init,
      headers: {
        "X-Requested-With": "SkillHub",
        Cookie: cookie,
        ...init.headers,
      },
    });
  const response = await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: ACCESS }),
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie").split(";")[0];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await w.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const submit = async ({
    key = randomUUID(),
    data = image,
    mime = "image/png",
    extra = {},
    includeMain = true,
  } = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries({
      skillId: "product",
      productName: "测试商品",
      platform: "通用",
      count: "1",
      size: "1:1",
      ...extra,
    }))
      form.append(k, v);
    if (includeMain)
      form.append("main", new Blob([data], { type: mime }), "main.png");
    return request("/api/jobs", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: form,
    });
  };
  const terminal = async (id) => {
    for (let i = 0; i < 150; i++) {
      const job = await (await request(`/api/jobs/${id}`)).json();
      if (!["queued", "running"].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Job did not finish");
  };
  return { request, submit, terminal, url, dir, w };
}

test("switching defaults preserves queued provider choices and API failures refund without leaking secrets", async (t) => {
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const providers = createProviders({
    env: {
      IMAGE_API_BASE_URL: "https://relay.example",
      IMAGE_API_KEY: "private-test-key",
    },
    codexCheck: async () => ({ ready: true, message: "test" }),
    codexRun: async (job, dir) => {
      calls.push(job.params.providerMode);
      await hold;
      await fs.writeFile(path.join(dir, "result-1.png"), image);
    },
    fetchImpl: async (url, init) => {
      if (url.pathname.endsWith("models"))
        return Response.json({
          data: [{ id: "gpt-image-2.5" }, { id: "gpt-image-2-4K" }],
        });
      calls.push(init.body.get("model"));
      return Response.json(
        { error: { message: "private-test-key" } },
        { status: 502 },
      );
    },
  });
  const s = await setup(t, null, { providers });
  try {
    const first = await (await s.submit()).json();
    const setMode = (mode) =>
      s.request("/api/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
    assert.equal((await setMode("api")).status, 200);
    const second = await (
      await s.submit({
        extra: { resolution: "4K", size: "16:9", imageModel: "gpt-image-2.5" },
      })
    ).json();
    assert.equal(second.params.providerMode, "api");
    assert.equal(second.params.imageModel, "gpt-image-2-4K");
    assert.equal((await setMode("codex")).status, 200);
    assert.equal(
      s.w.store.db
        .prepare("SELECT value FROM settings WHERE key='generation-provider'")
        .get().value,
      "codex",
    );
    release();
    assert.equal((await s.terminal(first.id)).status, "succeeded");
    const failed = await s.terminal(second.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /502/);
    assert.doesNotMatch(failed.error, /private-test-key/);
    assert.deepEqual(calls, ["codex", "gpt-image-2-4K"]);
    assert.equal(s.w.store.account().balance, 490);
    const bad = await s.submit({
      extra: { providerMode: "api", resolution: "4K", size: "1:1" },
    });
    assert.equal(bad.status, 400);
    assert.equal(s.w.store.account().balance, 490);
    const state = await (await s.request("/api/workspace")).text();
    assert.doesNotMatch(state, /private-test-key|relay.example/);
    assert.equal(
      (
        await fetch(s.url + "/api/provider", {
          method: "POST",
          headers: {
            "X-Requested-With": "SkillHub",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ mode: "api" }),
        })
      ).status,
      401,
    );
  } finally {
    release();
  }
});

test("upscale uses the selected generated asset, routes to 2.0 4K, deduplicates and preserves source", async (t) => {
  let uploaded,
    calls = 0;
  const providers = createProviders({
    env: {
      IMAGE_API_BASE_URL: "https://relay.example",
      IMAGE_API_KEY: "private-test-key",
    },
    codexCheck: async () => ({ ready: true }),
    codexRun: async (_job, dir) =>
      fs.writeFile(path.join(dir, "result-1.png"), image),
    fetchImpl: async (url, init) => {
      if (url.pathname.endsWith("models"))
        return Response.json({
          data: [{ id: "gpt-image-2.5" }, { id: "gpt-image-2-4K" }],
        });
      calls++;
      assert.equal(init.body.get("model"), "gpt-image-2-4K");
      assert.equal(init.body.get("size"), "auto");
      assert.match(init.body.get("prompt"), /严格保留原图/);
      uploaded = Buffer.from(await init.body.get("image[]").arrayBuffer());
      return Response.json({ data: [{ b64_json: image.toString("base64") }] });
    },
  });
  const s = await setup(t, null, { providers });
  const source = await s.terminal((await (await s.submit()).json()).id);
  const route = `/api/jobs/${source.id}/files/image-1.png`;
  const original = Buffer.from(await (await s.request(route)).arrayBuffer());
  const key = randomUUID();
  const upscale = () =>
    s.request(`/api/jobs/${source.id}/upscale`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ asset: "image-1.png" }),
    });
  const [a, b] = await Promise.all([upscale(), upscale()]);
  const jobs = await Promise.all([a.json(), b.json()]);
  assert.equal(jobs[0].id, jobs[1].id);
  const done = await s.terminal(jobs[0].id);
  assert.equal(done.status, "succeeded");
  assert.equal(done.sourceId, source.id);
  assert.equal(done.params.operation, "upscale");
  assert.equal(done.params.requestedSize, "4096x4096");
  assert.equal(done.manifest.sourceExportId, source.manifest.exportId);
  assert.equal(calls, 1);
  assert.deepEqual(uploaded, original);
  assert.deepEqual(
    Buffer.from(await (await s.request(route)).arrayBuffer()),
    original,
  );
  assert.equal(s.w.store.account().balance, 480);
  const bad = await s.request(`/api/jobs/${source.id}/upscale`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({ asset: "../access-code.txt" }),
  });
  assert.equal(bad.status, 400);
  assert.equal(s.w.store.account().balance, 480);
});

test("poster copy is required and persisted; posters can omit images while product jobs cannot", async (t) => {
  let received;
  const s = await setup(t, async (job, dir) => {
    received = job.params;
    await fs.writeFile(path.join(dir, "result-1.png"), image);
  });
  const missing = await s.submit({
    includeMain: false,
    extra: { skillId: "poster" },
  });
  assert.equal(missing.status, 400);
  assert.equal(s.w.store.account().balance, 500);
  const copy = {
    kind: "menu",
    layout: "typography",
    title: "秋日菜单",
    body: "美式咖啡 18元\n拿铁 24元",
    footer: "STUDIO 咖啡",
    offer: "",
    cta: "到店品尝",
  };
  const response = await s.submit({
    includeMain: false,
    extra: { skillId: "poster", poster: JSON.stringify(copy) },
  });
  assert.equal(response.status, 202);
  const done = await s.terminal((await response.json()).id);
  assert.equal(done.status, "succeeded");
  assert.deepEqual(received.inputs, []);
  assert.equal(received.hasMainImage, false);
  assert.equal(received.poster.body, copy.body);
  assert.equal(done.manifest.poster.title, "秋日菜单");
  assert.equal((await s.request(`/api/jobs/${done.id}/input`)).status, 404);
  assert.equal(s.w.store.account().balance, 485);
  const product = await s.submit({ includeMain: false });
  assert.equal(product.status, 400);
  const tooLong = await s.submit({
    extra: {
      skillId: "poster",
      poster: JSON.stringify({ ...copy, title: "长".repeat(33) }),
    },
  });
  assert.equal(tooLong.status, 400);
  assert.equal(s.w.store.account().balance, 485);
});

test("provider failure is persisted, refunded, and retry invokes the provider again", async (t) => {
  let calls = 0;
  const s = await setup(t, async () => {
    calls++;
    throw new Error("test provider failed");
  });
  const created = await s.submit();
  assert.equal(created.status, 202);
  const job = await created.json();
  assert.equal((await s.terminal(job.id)).status, "failed");
  const state = await (await s.request("/api/workspace")).json();
  assert.equal(state.account.balance, 500);
  const retry = await s.request(`/api/jobs/${job.id}/retry`, {
    method: "POST",
    headers: { "Idempotency-Key": randomUUID() },
  });
  assert.equal(retry.status, 202);
  assert.equal((await s.terminal((await retry.json()).id)).status, "failed");
  assert.equal(calls, 2);
  assert.equal(
    (await (await s.request("/api/workspace")).json()).account.balance,
    500,
  );
});

test("successful outputs require login; raw uploads and logs are never static files", async (t) => {
  const s = await setup(t, async (_job, dir) => {
    await fs.writeFile(path.join(dir, "result-1.png"), image);
    await fs.writeFile(path.join(dir, "codex.log"), "private log");
  });
  const job = await (await s.submit()).json();
  const done = await s.terminal(job.id);
  assert.equal(done.status, "succeeded");
  const route = `/api/jobs/${job.id}/files/image-1.png`;
  assert.equal((await fetch(s.url + route)).status, 401);
  const asset = await s.request(route);
  assert.equal(asset.status, 200);
  assert.equal(
    (await sharp(Buffer.from(await asset.arrayBuffer())).metadata()).width,
    1024,
  );
  const download = await s.request(route + "?download=1");
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.equal(
    (await s.request(`/api/jobs/${job.id}/files/codex.log`)).status,
    404,
  );
  assert.equal((await s.request(`/api/out/${job.id}/codex.log`)).status, 404);
  assert.equal((await s.request("/.data/access-code.txt")).status, 404);
  assert.equal((await s.request(`/api/jobs/${job.id}/input`)).status, 200);
});

test("simultaneous duplicate submissions create one generation and one charge", async (t) => {
  let calls = 0;
  const s = await setup(t, async (_job, dir) => {
    calls++;
    await fs.writeFile(path.join(dir, "result-1.png"), image);
  });
  const key = randomUUID();
  const results = await Promise.all([s.submit({ key }), s.submit({ key })]);
  const jobs = await Promise.all(results.map((r) => r.json()));
  assert.equal(jobs[0].id, jobs[1].id);
  assert.equal((await s.terminal(jobs[0].id)).status, "succeeded");
  assert.equal(calls, 1);
  assert.equal(
    (await (await s.request("/api/workspace")).json()).account.balance,
    490,
  );
});

test("invalid images and unsupported parameters never reach the generator or debit credits", async (t) => {
  let calls = 0;
  const s = await setup(t, async () => {
    calls++;
  });
  assert.equal(
    (await s.submit({ data: Buffer.from("<script>bad</script>") })).status,
    400,
  );
  assert.equal((await s.submit({ mime: "image/svg+xml" })).status, 400);
  assert.equal(
    (await s.submit({ extra: { skillId: "constructor" } })).status,
    400,
  );
  assert.equal((await s.submit({ extra: { count: "1.5" } })).status, 400);
  assert.equal(calls, 0);
  assert.equal(
    (await (await s.request("/api/workspace")).json()).account.balance,
    500,
  );
});

test("detail pages deliver exact-size modules and can update copy without regenerating or charging", async (t) => {
  let calls = 0;
  const s = await setup(t, async (job, dir) => {
    calls++;
    for (let i = 1; i <= job.params.count; i++)
      await fs.writeFile(path.join(dir, `result-${i}.png`), image);
  });
  const copy = [
    { title: "陶瓷咖啡杯", body: "用户确认的商品描述" },
    { title: "细节展示", body: "自然侧光" },
  ];
  const job = await (
    await s.submit({
      extra: { skillId: "detail", modules: JSON.stringify(copy) },
    })
  ).json();
  const done = await s.terminal(job.id);
  assert.equal(done.status, "succeeded");
  assert.equal(done.manifest.assets.length, 3);
  assert.equal(done.manifest.assets.at(-1).height, 2100);
  copy[0].title = "更新后的标题";
  const updated = await s.request(`/api/jobs/${job.id}/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modules: copy }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).params.modules[0].title, "更新后的标题");
  assert.equal(calls, 1);
  assert.equal(
    (await (await s.request("/api/workspace")).json()).account.balance,
    440,
  );
});

test("interior validates its own scope before charging and persists Skill snapshots across retry and export", async (t) => {
  const s = await setup(t, async (job, dir) => {
    const snapshot = JSON.parse(
      await fs.readFile(path.join(dir, "skill-context.json")),
    );
    assert.equal(snapshot.skillId, "interior");
    assert.equal(snapshot.sources.length, 1);
    await fs.writeFile(path.join(dir, "result-1.png"), image);
  });
  for (const creative of [
    {},
    { changes: "改窗帘", scope: "demolish" },
    { changes: "字".repeat(401) },
    { changes: "改窗帘", style: "custom" },
  ]) {
    const response = await s.submit({
      extra: { skillId: "interior", creative: JSON.stringify(creative) },
    });
    assert.equal(response.status, 400);
  }
  assert.equal(
    (await (await s.request("/api/workspace")).json()).account.balance,
    500,
  );
  const creative = {
    changes: "改窗帘",
    preserve: "保留地板",
    room: "bedroom",
    scope: "soft",
  };
  const extra = {
    skillId: "interior",
    creative: JSON.stringify(creative),
    productName: "卧室改造",
    platform: "自住探索",
    workflow: "forged",
  };
  const missing = await s.submit({ extra, includeMain: false });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /现状空间照片/);
  const submitted = await s.submit({ extra });
  assert.equal(submitted.status, 202);
  const job = await submitted.json(),
    done = await s.terminal(job.id);
  assert.equal(done.status, "succeeded");
  assert.equal(done.params.creative.room, "bedroom");
  assert.equal(done.manifest.workflow.sha256, done.params.workflow.sha256);
  assert.match(done.manifest.reviewRequired[0], /建筑结构/);
  assert.equal(
    (await s.request(`/api/jobs/${job.id}/files/skill-context.json`)).status,
    404,
  );
  const retry = await s.request(`/api/jobs/${job.id}/retry`, {
    method: "POST",
    headers: { "Idempotency-Key": randomUUID() },
  });
  assert.equal(retry.status, 202);
  const next = await retry.json();
  assert.deepEqual(next.params.creative, done.params.creative);
  assert.equal(next.params.workflow.sha256, done.params.workflow.sha256);
  assert.equal((await s.terminal(next.id)).status, "succeeded");
});

test("missing generated output fails instead of returning an unrelated or placeholder image", async (t) => {
  const s = await setup(t, async () => {});
  const job = await (await s.submit()).json();
  const done = await s.terminal(job.id);
  assert.equal(done.status, "failed");
  assert.equal(done.manifest, null);
  assert.equal(
    (await (await s.request("/api/workspace")).json()).account.balance,
    500,
  );
});

test("public-origin mode rejects other origins and sets a secure HttpOnly cookie", async (t) => {
  const s = await setup(t, async () => {}, {
    publicOrigin: "https://workspace.example",
  });
  const response = await s.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: ACCESS }),
  });
  assert.match(response.headers.get("set-cookie"), /Secure/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(response.headers.get("set-cookie"), /SameSite=Strict/);
  assert.equal(
    (
      await s.request("/api/jobs", {
        method: "POST",
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  // Node fetch discards a caller-supplied Host header; use HTTP for this wire-level test.
  const statusWithHeaders = (headers) =>
    new Promise((resolve, reject) => {
      http
        .get(s.url + "/api/health", { headers }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
        .on("error", reject);
    });
  assert.equal(await statusWithHeaders({ Host: "untrusted.example" }), 403);
  assert.equal(
    await statusWithHeaders({
      Host: "workspace.example",
      Origin: "https://workspace.example",
    }),
    200,
  );
});

test("queue runs one generator at a time; cancelling active work refunds only that job", async (t) => {
  let running = 0,
    max = 0;
  const s = await setup(t, async (job, dir, signal) => {
    running++;
    max = Math.max(max, running);
    try {
      if (job.params.productName === "cancel me")
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      else await fs.writeFile(path.join(dir, "result-1.png"), image);
    } finally {
      running--;
    }
  });
  const first = await (
    await s.submit({ extra: { productName: "cancel me" } })
  ).json();
  const second = await (await s.submit()).json();
  assert.equal(
    (await (await s.request(`/api/jobs/${second.id}`)).json()).status,
    "queued",
  );
  await s.request(`/api/jobs/${first.id}/cancel`, { method: "POST" });
  assert.equal((await s.terminal(first.id)).status, "cancelled");
  assert.equal((await s.terminal(second.id)).status, "succeeded");
  assert.equal(max, 1);
  assert.equal(
    (await (await s.request("/api/workspace")).json()).account.balance,
    490,
  );
});
