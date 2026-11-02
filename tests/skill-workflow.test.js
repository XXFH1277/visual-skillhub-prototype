import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { snapshotWorkflow, preparePrompts } from "../backend/skill-workflow.js";
import { createCodexRunner } from "../backend/runner.js";
import { createImageRunner, imageConfig } from "../backend/image-api.js";
import { parseCreative } from "../backend/creation.js";
import { parsePoster } from "../backend/poster.js";
import { suggestModules } from "../shared/creation.js";

const png = await sharp({
  create: { width: 320, height: 320, channels: 3, background: "white" },
})
  .png()
  .toBuffer();
async function dirFor(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-workflow-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "input-0.png"), png);
  return dir;
}
function parameters(skillId) {
  return {
    skillId,
    productName: skillId === "interior" ? "客厅改造" : "蓝色水瓶",
    platform: "内部预览",
    inputs: ["input-0.png"],
    hasMainImage: true,
    count: skillId === "product" ? 3 : 2,
    size: "1:1",
    requestedSize: "2048x2048",
    resolution: "2K",
    imageModel: "gpt-image-2.5",
    providerMode: "api",
    facts: "用户提供资料",
    styleNote: "自然柔光",
    brandColor: "#557799",
    ...(skillId === "poster"
      ? {
          poster: parsePoster({
            title: "秋日咖啡节",
            body: "美式 18元",
            kind: "menu",
          }),
        }
      : {
          creative: parseCreative(
            skillId,
            skillId === "interior"
              ? {
                  room: "living",
                  scope: "soft",
                  changes: "只更换沙发与窗帘",
                  preserve: "保留原地板与空调",
                  materials: "米色布艺",
                }
              : {},
          ),
        }),
    ...(skillId === "detail"
      ? {
          modules: [
            { title: "整体", body: "", role: "hero", visual: "完整轮廓" },
            {
              title: "细节",
              body: "瓶盖",
              role: "detail",
              visual: "已展示瓶盖特写",
            },
          ],
        }
      : {}),
  };
}

for (const skillId of ["product", "detail", "poster", "interior"]) {
  test(`${skillId}: Codex and API send the same frozen per-frame Skill and plan`, async (t) => {
    const dir = await dirFor(t),
      params = parameters(skillId);
    await snapshotWorkflow(params, dir);
    const expected = await preparePrompts(params, dir);
    assert.ok(
      params.workflow.sources.some(
        (s) => s.file === `skills/runtime/${skillId}/SKILL.md`,
      ),
    );
    assert.equal(expected.length, params.count);
    let calls = 0;
    const api = createImageRunner(
      imageConfig({
        IMAGE_API_BASE_URL: "https://relay.example",
        IMAGE_API_KEY: "private-test-key",
      }),
      async (_url, init) => {
        assert.equal(init.body.get("prompt"), expected[calls++]);
        assert.equal(init.body.getAll("image[]").length, 1);
        return Response.json({ data: [{ b64_json: png.toString("base64") }] });
      },
    );
    await api({ params }, dir);
    assert.equal(calls, params.count);
    let codexCalls = 0;
    const codex = createCodexRunner({
      resolve: () => ({ command: "test-codex", prefix: [] }),
      execute: async (command, args, options) => {
        codexCalls++;
        assert.equal(command, "test-codex");
        assert.equal(args.filter((x) => x === "-i").length, 1);
        for (const prompt of expected)
          assert.ok(options.input.includes(prompt));
        assert.ok(args.includes("workspace-write"));
      },
    });
    await codex({ params: { ...params, providerMode: "codex" } }, dir);
    assert.equal(codexCalls, 1);
    const receipt = JSON.parse(
      await fs.readFile(path.join(dir, "skill-execution.json")),
    );
    assert.equal(receipt.mode, "codex");
    assert.equal(receipt.snapshotSha256, params.workflow.sha256);
    assert.equal(receipt.prompts.length, params.count);
    assert.doesNotMatch(JSON.stringify(receipt), /private-test-key/);
    if (skillId === "interior") {
      assert.equal(params.workflow.sources.length, 1);
      assert.match(expected[0], /现状空间照片/);
      assert.match(expected[0], /scope=soft/);
      assert.match(expected[0], /保留原地板与空调/);
      assert.doesNotMatch(
        expected[0],
        /产品摄影|商品主图|品牌主色|productName|gpt-image2-ecommerce/,
      );
      const brief = JSON.parse(await fs.readFile(path.join(dir, "brief.json")));
      assert.equal(brief.inputs[0].role, "existing-space");
    }
    if (skillId === "detail") {
      assert.match(expected[1], /已展示瓶盖特写/);
      assert.match(expected[1], /只生成无文字的方形底图/);
    }
    if (skillId === "poster") assert.match(expected[0], /美式 18元/);
    if (skillId === "product")
      assert.deepEqual(
        params.workflow.frames.map((f) => f.role),
        ["hero", "detail", "context"],
      );
  });
}

test("changed or missing frozen Skill fails before contacting either provider", async (t) => {
  const dir = await dirFor(t),
    params = parameters("interior");
  await snapshotWorkflow(params, dir);
  await fs.appendFile(path.join(dir, "skill-context.json"), " ");
  let calls = 0;
  const api = createImageRunner(
    imageConfig({
      IMAGE_API_BASE_URL: "https://relay.example",
      IMAGE_API_KEY: "test",
    }),
    async () => {
      calls++;
    },
  );
  const codex = createCodexRunner({
    resolve: () => ({ command: "test", prefix: [] }),
    execute: async () => {
      calls++;
    },
  });
  await assert.rejects(api({ params }, dir), /快照校验失败/);
  await assert.rejects(codex({ params }, dir), /快照校验失败/);
  assert.equal(calls, 0);
});

test("category references are selected narrowly; copy mode and module suggestions retain confirmed facts", async (t) => {
  const dir = await dirFor(t),
    params = parameters("detail");
  params.creative.category = "food";
  await snapshotWorkflow(params, dir);
  const prompts = await preparePrompts(params, dir);
  assert.match(prompts[0], /Food and Beverage/);
  assert.doesNotMatch(prompts[0], /## Apparel and Accessories/);
  const modules = suggestModules("500ml\n可拆卸瓶盖", "书桌");
  assert.deepEqual(
    modules.filter((m) => m.body).map((m) => m.body),
    ["500ml", "可拆卸瓶盖"],
  );
  assert.equal(modules.at(-1).role, "context");
  assert.throws(() => suggestModules("长".repeat(101)), /100 字/);
  assert.throws(
    () => parseCreative("product", { textMode: "supplied" }),
    /文案/,
  );
  assert.throws(
    () => parseCreative("interior", { scope: "demolish", changes: "拆墙" }),
    /改造范围/,
  );
  assert.throws(() => parseCreative("interior", {}), /允许改动/);
  const product = parameters("product");
  product.creative = parseCreative("product", {
    recipe: "hero",
    textMode: "supplied",
    copy: "秋日新品",
  });
  await snapshotWorkflow(product, dir);
  assert.match(
    (await preparePrompts(product, dir))[0],
    /只将确认文案逐字排入画面.*秋日新品/,
  );
});
