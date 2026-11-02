import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createImageRunner, imageConfig } from "../backend/image-api.js";
import { createProviders } from "../backend/providers.js";
import { deliver } from "../backend/media.js";
import {
  parsePoster,
  posterDirection,
  visualInputDirection,
} from "../backend/poster.js";

const env = {
  IMAGE_API_BASE_URL: "https://relay.example/v1",
  IMAGE_API_KEY: "test-private-key",
  GENERATION_PROVIDER: "api",
};
const image = await sharp({
  create: { width: 320, height: 320, channels: 3, background: "#557799" },
})
  .png()
  .toBuffer();
const modelResponse = () =>
  Response.json({ data: [{ id: "gpt-image-2.5" }, { id: "gpt-image-2-4K" }] });
const params = {
  providerMode: "api",
  imageModel: "gpt-image-2.5",
  resolution: "2K",
  requestedSize: "2048x2048",
  size: "1:1",
  skillId: "product",
  count: 1,
  inputs: ["input-0.png"],
  productName: "水瓶",
  platform: "测试",
};
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-api-test-"));
  await fs.writeFile(path.join(dir, "input-0.png"), image);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("provider checks retain connection errors instead of claiming that configured models are absent", async () => {
  const providers = createProviders({
    env,
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
  });
  const status = await providers.check("api");
  assert.equal(status.ready, false);
  assert.match(status.message, /连接失败或超时/);
});

test("API sends reference images, model and resolution; delivery preserves real pixels and reports mismatch", async (t) => {
  const dir = await directory(t);
  let calls = 0;
  const run = createImageRunner(imageConfig(env), async (url, init) => {
    calls++;
    assert.equal(url.href, "https://relay.example/v1/images/edits");
    assert.equal(init.headers.Authorization, "Bearer test-private-key");
    assert.equal(init.redirect, "error");
    assert.equal(init.body.get("model"), "gpt-image-2.5");
    assert.equal(init.body.get("size"), "2048x2048");
    assert.equal(init.body.get("n"), "1");
    assert.deepEqual(
      Buffer.from(await init.body.get("image[]").arrayBuffer()),
      image,
    );
    return Response.json({ data: [{ b64_json: image.toString("base64") }] });
  });
  const job = { id: "test-api-job", params };
  await run(job, dir, new AbortController().signal);
  const manifest = await deliver(job, dir);
  assert.equal(calls, 1);
  assert.equal(manifest.assets[0].width, 320);
  assert.equal(manifest.assets[0].height, 320);
  assert.match(manifest.warnings[0], /2048x2048.*320x320/);
  assert.equal(manifest.generation.model, "gpt-image-2.5");
  assert.doesNotMatch(JSON.stringify(manifest), /test-private-key/);
});

test("text-only poster uses the generations endpoint and sends visible copy with hierarchy", async (t) => {
  const dir = await directory(t);
  const poster = parsePoster({
    kind: "menu",
    layout: "typography",
    title: "秋日咖啡节",
    subtitle: "暖意入杯",
    body: "美式 18元\n拿铁 24元",
    offer: "",
    cta: "到店品尝",
    footer: "11月2日 · STUDIO",
  });
  const run = createImageRunner(imageConfig(env), async (url, init) => {
    assert.equal(url.pathname, "/v1/images/generations");
    assert.equal(init.headers["Content-Type"], "application/json");
    const payload = JSON.parse(init.body);
    assert.equal(payload.n, 1);
    assert.equal(payload.response_format, "b64_json");
    assert.match(payload.prompt, /没有图片附件/);
    assert.match(payload.prompt, /可见、清晰可读的文字逐字呈现/);
    assert.match(payload.prompt, /秋日咖啡节/);
    assert.match(payload.prompt, /美式 18元/);
    assert.match(payload.prompt, /名称与价格一一对应/);
    assert.ok(!Object.hasOwn(payload, "image"));
    return Response.json({ data: [{ b64_json: image.toString("base64") }] });
  });
  await run(
    {
      params: {
        ...params,
        skillId: "poster",
        poster,
        inputs: [],
        hasMainImage: false,
      },
    },
    dir,
  );
  assert.ok((await fs.stat(path.join(dir, "result-1.png"))).size > 0);
  assert.match(posterDirection(poster), /主标题最突出/);
  assert.match(
    visualInputDirection({ inputs: ["input-0.png"], hasMainImage: false }),
    /所有附件仅提供风格参考/,
  );
  assert.throws(
    () => parsePoster({ title: "菜单", layout: "unknown" }),
    /版式无效/,
  );
});

test("poster with visual assets stays on edits and includes its exact headline", async (t) => {
  const dir = await directory(t);
  const poster = parsePoster({
    title: "新品上市",
    kind: "brand",
    layout: "top",
  });
  const run = createImageRunner(imageConfig(env), async (url, init) => {
    assert.equal(url.pathname, "/v1/images/edits");
    assert.equal(init.body.getAll("image[]").length, 1);
    assert.match(init.body.get("prompt"), /新品上市/);
    assert.match(init.body.get("prompt"), /完整的字体设计、图文层级/);
    return Response.json({ data: [{ b64_json: image.toString("base64") }] });
  });
  await run(
    { params: { ...params, skillId: "poster", poster, hasMainImage: true } },
    dir,
  );
});

test("upstream failures do not leak bodies or keys, retry automatically, or produce output", async (t) => {
  const dir = await directory(t);
  let calls = 0;
  const run = createImageRunner(imageConfig(env), async () => {
    calls++;
    return Response.json(
      { error: { message: "test-private-key https://private.example" } },
      { status: 502 },
    );
  });
  await assert.rejects(
    run({ params }, dir),
    (e) =>
      /HTTP 502/.test(e.message) &&
      !/test-private-key|private.example/.test(e.message),
  );
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(path.join(dir, "result-1.png")));
});

test("only explicit image bytes are accepted; URL results and cancellation cause no extra requests", async (t) => {
  const dir = await directory(t);
  let calls = 0;
  const run = createImageRunner(imageConfig(env), async () => {
    calls++;
    return Response.json({ data: [{ url: "http://127.0.0.1/private" }] });
  });
  await assert.rejects(run({ params }, dir), /不同格式/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run({ params }, dir, controller.signal), /取消/);
  assert.equal(calls, 1);
});

test("4K always routes to 2.0 4K, smaller requests to 2.5; incompatible dimensions are rejected", async () => {
  const providers = createProviders({
    env,
    fetchImpl: async () => modelResponse(),
    codexCheck: async () => ({ ready: true }),
  });
  await providers.check("api");
  const choice = providers.selection({
    providerMode: "api",
    imageModel: "gpt-image-2.5",
    resolution: "4K",
    size: "16:9",
  });
  assert.equal(choice.imageModel, "gpt-image-2-4K");
  assert.equal(choice.requestedSize, "3840x2160");
  assert.equal(
    providers.selection({
      providerMode: "api",
      imageModel: "gpt-image-2-4K",
      resolution: "2K",
      size: "1:1",
    }).imageModel,
    "gpt-image-2.5",
  );
  assert.throws(
    () =>
      providers.selection({
        providerMode: "api",
        resolution: "4K",
        size: "1:1",
      }),
    /4K/,
  );
  assert.throws(() => providers.selection({ providerMode: "unknown" }), /模式/);
  assert.doesNotMatch(
    JSON.stringify(providers.list()),
    /test-private-key|relay.example/,
  );
});

test("configured relay aliases are used on the wire for 4K upgrades", async (t) => {
  const dir = await directory(t);
  let model;
  const providers = createProviders({
    env: {
      ...env,
      IMAGE_API_MODEL_2K: "gpt-image-2.5-sunburst",
      IMAGE_API_MODEL_4K: "gpt-image-2.0",
    },
    fetchImpl: async (url, init) => {
      if (url.pathname.endsWith("models"))
        return Response.json({
          data: [{ id: "gpt-image-2.5-sunburst" }, { id: "gpt-image-2.0" }],
        });
      model = init.body.get("model");
      assert.equal(init.body.get("response_format"), "b64_json");
      return Response.json({ data: [{ b64_json: image.toString("base64") }] });
    },
  });
  await providers.check("api");
  assert.equal(
    providers.selection({ providerMode: "api", resolution: "2K", size: "1:1" })
      .imageModel,
    "gpt-image-2.5-sunburst",
  );
  const choice = providers.upscaleSelection(320, 320);
  await providers.run(
    { params: { ...params, ...choice, skillId: "upscale" } },
    dir,
  );
  assert.equal(model, "gpt-image-2.0");
});

test("detail export retains native API bases without counting them as long-page modules", async (t) => {
  const dir = await directory(t);
  await fs.writeFile(path.join(dir, "result-1.png"), image);
  await fs.writeFile(path.join(dir, "result-2.png"), image);
  const job = {
    id: "detail-api-job",
    params: {
      ...params,
      skillId: "detail",
      count: 2,
      brandColor: "#557799",
      modules: [
        { title: "外观", body: "" },
        { title: "细节", body: "" },
      ],
    },
  };
  const manifest = await deliver(job, dir);
  assert.equal(manifest.assets.filter((a) => a.role === "original").length, 2);
  assert.equal(
    manifest.assets.find((a) => a.role === "long-preview").height,
    2100,
  );
  assert.equal(manifest.assets.find((a) => a.role === "original").width, 320);
});
