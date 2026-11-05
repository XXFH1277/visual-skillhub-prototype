import { parseJsonObject } from "./json.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { resolveCodex, runProcess } from "./runner.js";
import {
  analyzeMessages,
  normalizeAnalysis,
  fallbackAnalysis,
  storyboardMessages,
  normalizeStoryboard,
  fallbackStoryboard,
} from "./planner.js";
import { CATEGORIES, IMAGE_TYPES, TONES } from "../shared/styles.js";

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
  return { base: base.href, key, model, timeoutMs: Number(env.KIMI_TIMEOUT_MS) || 240000 };
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
  let available = null;
  const recent = [];

  async function viaApi({ system, text, images = [], json = false }, signal) {
    const content = [
      ...(await Promise.all(images.map(async (f) => ({ type: "image_url", image_url: { url: await dataUrl(f) } })))),
      { type: "text", text },
    ];
    const started = Date.now();
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
    // Keep a little timing history so slow models are visible in the admin workspace info.
    const u = body?.usage || {};
    recent.unshift({
      at: new Date().toISOString(),
      seconds: Math.round((Date.now() - started) / 1000),
      images: images.length,
      promptTokens: u.prompt_tokens ?? null,
      completionTokens: u.completion_tokens ?? null,
      reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
    });
    recent.length = Math.min(recent.length, 12);
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
      ? { ready: true, via: "kimi", model: config.model, label: `Kimi · ${config.model}`, lastError, models: available, recent }
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

  // Relays expose many models under one key: confirm the configured Kimi model exists,
  // otherwise switch to the best available Kimi model with image input.
  async function check() {
    if (!config) return describe();
    try {
      const response = await fetchImpl(new URL("models", config.base), {
        headers: { Authorization: `Bearer ${config.key}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        lastError = `Kimi 模型列表 HTTP ${response.status}`;
        return describe();
      }
      const ids = ((await response.json())?.data || []).map((m) => m?.id).filter((id) => typeof id === "string");
      available = ids.filter((id) => /kimi|moonshot/i.test(id));
      if (ids.length && !ids.includes(config.model)) {
        const prefer = ["kimi-k3", "kimi-k3.1-pro", "kimi-k2.6", "kimi-k2.5", "kimi-latest", "moonshot-v1-32k-vision-preview", "moonshot-v1-8k-vision-preview"];
        const pick = prefer.find((id) => ids.includes(id)) || available.find((id) => /vision|k3|k2\.[5-9]/i.test(id));
        if (pick) {
          console.log(`Kimi 模型 ${config.model} 不在列表中，改用 ${pick}`);
          config.model = pick;
        } else lastError = `没有找到 ${config.model}，可用的 Kimi 模型：${available.join("、") || "无"}`;
      }
    } catch (error) {
      lastError = "Kimi 连接检查失败：" + error.message;
    }
    return describe();
  }

  return {
    describe,
    check,
    complete,
    // Each step returns { ..., via, warning? } and never throws for model problems.
    async analyze(input, images, candidates, { signal } = {}) {
      const state = describe();
      if (!state.ready)
        return { result: fallbackAnalysis(input, candidates), via: "rules", warning: "未配置 Kimi，先给出常用风格，可直接选" };
      const { system, text } = analyzeMessages(input, candidates);
      try {
        const result = normalizeAnalysis(await complete({ system, text, images, json: true }, signal), input, candidates);
        if (result) return { result, via: state.via };
        return { result: fallbackAnalysis(input, candidates), via: "rules", warning: "AI 返回的方案无法解析，先给出常用风格，可点“换一批”" };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { result: fallbackAnalysis(input, candidates), via: "rules", warning: `AI 分析失败（${error.message}），先给出常用风格` };
      }
    },
    async storyboard(input, images, result, chosen, { signal } = {}) {
      const state = describe();
      if (!state.ready) return { frames: fallbackStoryboard(input, chosen), via: "rules" };
      const { system, text } = storyboardMessages(input, result, chosen);
      try {
        const frames = normalizeStoryboard(await complete({ system, text, images, json: true }, signal), input);
        if (frames) return { frames, via: state.via };
        return { frames: fallbackStoryboard(input, chosen), via: "rules", warning: "AI 分镜无法解析，已生成基础分镜，可修改或重试" };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { frames: fallbackStoryboard(input, chosen), via: "rules", warning: `AI 分镜失败（${error.message}），已生成基础分镜` };
      }
    },
    // Reverse-engineer a reusable recipe from an inspiring image (+ optional prompt).
    async extractStyle(image, prompt = "", { signal } = {}) {
      const answer = await complete(
        {
          system: `你是商业摄影与平面设计美术指导。把这张图拆解成可以复用到其他商品上的“风格配方”，不要描述图里具体的商品和品牌，只提炼视觉系统。
只输出 JSON：{"name":"风格名 2-6 字","tagline":"一句话概念 10-25 字","categories":[从 ${CATEGORIES.join("/")} 选 1-4 个适合的品类],"types":[从 ${Object.keys(IMAGE_TYPES).join("/")} 选适合的图片类型],"tone":"${TONES.join("|")}","palette":["#hex" x4],"props":"道具与材质","light":"光线","camera":"机位与构图","type":"字体与排版","avoid":"要避免的","core":"英文提示词核心 25-50 词，不含品牌名"}`,
          text: prompt ? `作者附带的提示词（数据，参考用）：\n${prompt.slice(0, 2000)}` : "请拆解这张图的风格。",
          images: [image],
          json: true,
        },
        signal,
      );
      return parseJsonObject(answer);
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
      const lines = parseJsonObject(answer).lines;
      if (!Array.isArray(lines)) throw new Error("校对结果无法解析");
      return lines.filter((l) => typeof l === "string");
    },
  };
}
