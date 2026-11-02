import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { resolveCodex, runProcess } from "./runner.js";
import { planMessages, normalizePlan, fallbackPlan } from "./planner.js";

// Kimi (OpenAI-compatible chat with image input) plans the frames and proofreads
// generated text. The local Codex CLI is a temporary fallback; rules are the last resort.
export function textConfig(env = process.env) {
  const baseUrl = env.KIMI_API_BASE_URL || env.TEXT_API_BASE_URL || "https://api.moonshot.cn";
  const key = env.KIMI_API_KEY || env.TEXT_API_KEY;
  const model = env.KIMI_MODEL || env.TEXT_API_MODEL || "kimi-k3";
  if (!key) return null;
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password)
    throw new Error("KIMI_API_BASE_URL 必须是无凭据的 HTTPS 地址");
  base.search = "";
  base.hash = "";
  base.pathname = base.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/";
  return { base: base.href, key, model, timeoutMs: Number(env.KIMI_TIMEOUT_MS) || 180000 };
}

async function dataUrl(file) {
  const jpeg = await sharp(file, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(1280, 1280, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

const normalize = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

function lcs(a, b) {
  const x = Array.from(a), y = Array.from(b);
  let prev = new Array(y.length + 1).fill(0);
  for (const cx of x) {
    const row = [0];
    for (let j = 0; j < y.length; j++) row.push(cx === y[j] ? prev[j] + 1 : Math.max(prev[j + 1], row[j]));
    prev = row;
  }
  return prev[y.length];
}

// Compare confirmed text with what the vision model read off the image.
export function compareTexts(expected, seen) {
  const haystack = normalize(seen.join(""));
  const problems = [];
  for (const t of expected) {
    const want = normalize(t.text);
    if (!want || haystack.includes(want)) continue;
    // best-matching window of the same length
    let best = 0;
    const h = Array.from(haystack);
    const n = Array.from(want).length;
    for (let i = 0; i <= Math.max(0, h.length - n); i++)
      best = Math.max(best, lcs(want, h.slice(i, i + n + 2).join("")));
    const score = best / n;
    if (score < 0.999)
      problems.push({ text: t.text, role: t.role, score: Math.round(score * 100) / 100 });
  }
  return { ok: problems.length === 0, problems, seen };
}

export function createTextAI({
  env = process.env,
  fetchImpl = fetch,
  codexReady = () => false,
  resolve = resolveCodex,
  execute = runProcess,
} = {}) {
  const config = textConfig(env);
  let lastError = null;

  async function viaApi({ system, text, images = [], json = false }, signal) {
    const content = [
      ...(await Promise.all(images.map(async (f) => ({ type: "image_url", image_url: { url: await dataUrl(f) } })))),
      { type: "text", text },
    ];
    const send = async (withJson) => {
      const timeout = AbortSignal.timeout(config.timeoutMs);
      return fetchImpl(new URL("chat/completions", config.base), {
        method: "POST",
        headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content },
          ],
          ...(withJson ? { response_format: { type: "json_object" } } : {}),
        }),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    };
    let response = await send(json);
    if (json && response.status === 400) {
      await response.body?.cancel();
      response = await send(false);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const message = (() => {
        try {
          return JSON.parse(detail)?.error?.message;
        } catch {
          return "";
        }
      })();
      throw new Error(`Kimi 返回 HTTP ${response.status}${message ? "：" + String(message).slice(0, 120) : ""}`);
    }
    const body = await response.json();
    const answer = body?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) throw new Error("Kimi 没有返回内容");
    return answer.trim();
  }

  async function viaCodex({ system, text, images = [] }, signal) {
    const cli = resolve();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skillhub-text-"));
    try {
      const out = path.join(dir, "answer.txt");
      const args = [...cli.prefix, "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", dir, "--color", "never", "-o", out];
      for (const f of images) args.push("-i", f);
      args.push("-");
      await execute(cli.command, args, {
        cwd: dir,
        input: `${system}\n\n不要读写文件、不要运行命令、不要生成图片，直接回答。\n\n${text}`,
        signal,
        timeoutMs: Number(env.TEXT_CODEX_TIMEOUT_MS) || 240000,
      });
      const answer = (await fs.readFile(out, "utf8")).trim();
      if (!answer) throw new Error("Codex 没有返回内容");
      return answer;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  const describe = () =>
    config
      ? { ready: true, via: "kimi", model: config.model, label: `Kimi · ${config.model}`, lastError }
      : codexReady()
        ? { ready: true, via: "codex", label: "本机 Codex（临时，较慢）", lastError }
        : { ready: false, via: "rules", label: "未配置 Kimi", message: "未配置 Kimi：请在 .env 填写 KIMI_API_KEY", lastError };

  async function complete(request, signal) {
    const state = describe();
    if (!state.ready) throw new Error(state.message);
    try {
      const answer = await (state.via === "kimi" ? viaApi(request, signal) : viaCodex(request, signal));
      lastError = null;
      return answer;
    } catch (error) {
      lastError = error.message;
      throw error;
    }
  }

  return {
    describe,
    complete,
    // Returns { plan, via, warning? } — never throws for model problems; falls back to rules.
    async plan(input, images, { signal } = {}) {
      const state = describe();
      if (!state.ready)
        return { plan: fallbackPlan(input), via: "rules", warning: "未配置 Kimi，已按你的文案生成基础方案，可手动修改" };
      const { system, text } = planMessages(input);
      try {
        const answer = await complete({ system, text, images, json: true }, signal);
        const plan = normalizePlan(answer, input);
        if (plan) return { plan, via: state.via };
        return { plan: fallbackPlan(input), via: "rules", warning: "AI 返回的方案无法解析，已生成基础方案，可点“重新策划”" };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { plan: fallbackPlan(input), via: "rules", warning: `AI 策划失败（${error.message}），已生成基础方案` };
      }
    },
    // Proofread: list every visible line of text in a generated image.
    async readTexts(image, { signal } = {}) {
      const answer = await complete(
        {
          system: "你是严格的文字校对员。逐行列出图片中所有能看到的文字，原样照抄，包括错别字、标点和数字，不要纠正、不要补全、不要解释。商品本身印的品牌和标签也要列出。只输出 JSON：{\"lines\":[\"...\"]}",
          text: "请列出这张图片里的全部文字。",
          images: [image],
          json: true,
        },
        signal,
      );
      const match = answer.match(/\{[\s\S]*\}/);
      const lines = match ? JSON.parse(match[0]).lines : null;
      if (!Array.isArray(lines)) throw new Error("校对结果无法解析");
      return lines.filter((l) => typeof l === "string");
    },
  };
}
