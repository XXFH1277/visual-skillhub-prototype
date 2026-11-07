import { recordUsage, withUsage } from "./usage.js";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { regularFile } from "./media.js";
import { imageSize, upscaleSize } from "../shared/generation.js";
import { preparePrompts, frameInputs } from "./prompts.js";

// The endpoint and credential are server-only configuration. Never accept either
// from job parameters, and never echo upstream bodies into browser-visible errors.
export function imageConfig(env = process.env) {
  if (!env.IMAGE_API_BASE_URL || !env.IMAGE_API_KEY) return null;
  const base = new URL(env.IMAGE_API_BASE_URL);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("IMAGE_API_BASE_URL 必须是无凭据、无查询参数的 HTTPS 地址");
  base.pathname =
    base.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/";
  return {
    base: base.href,
    key: env.IMAGE_API_KEY,
    model2k: env.IMAGE_API_MODEL_2K || "gpt-image-2.5",
    model4k: env.IMAGE_API_MODEL_4K || "gpt-image-2-4K",
    timeoutMs: Number(env.GENERATION_TIMEOUT_MS) || 900000,
    concurrency: Math.min(Math.max(Number(env.IMAGE_API_CONCURRENCY) || 3, 1), 6),
  };
}

async function readJson(response, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("图片服务响应超过大小限制");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("图片服务返回了无法读取的数据");
  }
}

export async function checkImageApi(config, fetchImpl = fetch) {
  if (!config)
    return {
      ready: false,
      message: "尚未配置生图 API；请在本机 .env 设置地址与密钥",
      models: [],
    };
  try {
    const response = await fetchImpl(new URL("models", config.base), {
      headers: { Authorization: `Bearer ${config.key}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        ready: false,
        message: `生图 API 鉴权检查失败（HTTP ${response.status}）`,
        models: [],
      };
    }
    const body = await readJson(response, 1024 * 1024);
    const models = Array.isArray(body.data)
      ? body.data.map((x) => x.id).filter((x) => typeof x === "string")
      : [];
    return {
      ready: models.length > 0,
      models,
      message: "API 鉴权通过；模型可用性及实际尺寸以生成结果为准",
    };
  } catch {
    return {
      ready: false,
      models: [],
      message: "生图 API 连接失败或超时，请检查本机配置与网络",
    };
  }
}

function upscalePrompt(p) {
  return `请将附件这张已经完成的图片提升至 4K 清晰度，目标 ${p.requestedSize}。严格保留原图画幅比例、构图、主体形状、颜色、Logo、全部文字、光线与背景，不增加、删除或重新设计任何元素。只改善材质细节、边缘与清晰度，避免过度锐化。仅输出一张提升后的图片。`;
}

export function createImageRunner(config, fetchImpl = fetch) {
  return async (job, dir, signal) => {
    if (!config) throw new Error("生图 API 未配置");
    const p = job.params;
    const requestedSize =
      p.operation === "upscale"
        ? upscaleSize(p.sourceWidth, p.sourceHeight)
        : imageSize(p.size, p.resolution);
    if (!requestedSize || requestedSize !== p.requestedSize)
      throw new Error("生图请求尺寸无效");
    if (p.resolution === "4K" && p.imageModel !== config.model4k)
      throw new Error("生图 4K 请求必须使用 2.0 4K 模型");
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const prompts =
      p.operation === "upscale"
        ? [upscalePrompt(p)]
        : await preparePrompts(p, dir);
    const results = [];
    const started = Date.now();
    let phase = "prepare";
    // Frames are independent: run a few at once (the relay takes ~1 min per image).
    const runFrame = (i) => withUsage({ jobId: job.id, suiteId: p.suiteId || null, purpose: p.packStep ? `pack-${p.packStep}` : p.operation || p.skillId }, () => runFrameNow(i));
    const runFrameNow = async (i) => {
        combined.throwIfAborted();
        const frameStarted = Date.now();
        const form = new FormData();
        form.set("model", p.imageModel);
        // The relay's 4K model owns upscale dimensions. `auto` preserves arbitrary
        // source aspect ratios without sending unsupported square 4K size values.
        form.set("size", p.operation === "upscale" ? "auto" : requestedSize);
        form.set("n", "1");
        form.set("response_format", "b64_json");
        form.set("prompt", prompts[i]);
        const files = p.operation === "upscale" ? p.inputs : frameInputs(p, i);
        for (const name of files) {
          const file = await regularFile(dir, name);
          form.append(
            "image[]",
            new Blob([await fs.readFile(file)], { type: "image/png" }),
            name,
          );
        }
        // No automatic retries: a timeout does not prove the upstream did not bill.
        const textOnly = files.length === 0;
        if (textOnly && p.skillId !== "poster" && p.operation !== "cover")
          throw new Error("生图任务缺少参考素材");
        const requestBody = textOnly
          ? JSON.stringify({
              model: p.imageModel,
              size: requestedSize,
              n: 1,
              response_format: "b64_json",
              prompt: form.get("prompt"),
            })
          : form;
        phase = "request";
        const response = await fetchImpl(
          new URL(
            textOnly ? "images/generations" : "images/edits",
            config.base,
          ),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.key}`,
              ...(textOnly ? { "Content-Type": "application/json" } : {}),
            },
            body: requestBody,
            redirect: "error",
            signal: combined,
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            `生图 API 返回 HTTP ${response.status}；未自动重试，请检查中转站状态与账单`,
          );
        }
        phase = "read-response";
        const body = await readJson(response, 64 * 1024 * 1024);
        // The relay may or may not pass token usage through; seconds and count always.
        recordUsage({
          kind: "image",
          model: p.imageModel,
          seconds: Math.round((Date.now() - frameStarted) / 1000),
          images: files.length,
          promptTokens: body.usage?.input_tokens ?? null,
          completionTokens: body.usage?.output_tokens ?? null,
          detail: body.usage ? JSON.stringify(body.usage).slice(0, 400) : null,
        });
        if (
          body.data?.length !== 1 ||
          typeof body.data[0]?.b64_json !== "string"
        ) {
          await fs.writeFile(
            path.join(dir, `api-response-${i + 1}.json`),
            JSON.stringify(body).replaceAll(config.key, "[redacted]"),
          );
          throw new Error(
            "生图 API 返回了不同格式；已在本机保留响应，便于恢复结果，未自动重试",
          );
        }
        const b64 = body.data[0].b64_json;
        if (
          !b64.length ||
          b64.length % 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)
        )
          throw new Error("生图 API 图片编码无效");
        const bytes = Buffer.from(b64, "base64");
        phase = "decode-image";
        let meta;
        try {
          meta = await sharp(bytes, {
            limitInputPixels: 40000000,
            failOn: "warning",
          }).metadata();
          if (
            !["png", "jpeg", "webp"].includes(meta.format) ||
            meta.width < 256 ||
            meta.height < 256 ||
            (meta.pages || 1) !== 1
          )
            throw new Error("invalid");
          await sharp(bytes, { limitInputPixels: 40000000, failOn: "warning" })
            .png()
            .toFile(path.join(dir, `result-${i + 1}.png`));
        } catch {
          throw new Error("生图 API 返回的图片无法解码或不符合尺寸限制");
        }
        results.push({
          index: i + 1,
          requestedSize,
          actualSize: `${meta.width}x${meta.height}`,
          sizeMatched: requestedSize === `${meta.width}x${meta.height}`,
        });
    };
    try {
      let next = 0;
      let failed = null;
      const worker = async () => {
        while (!failed && next < p.count) {
          const i = next++;
          try {
            await runFrame(i);
          } catch (error) {
            failed ||= error;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(config.concurrency || 1, p.count) }, worker));
      if (failed) throw failed;
      results.sort((a, b) => a.index - b.index);
      phase = "save-report";
      await fs.writeFile(
        path.join(dir, "api-report.json"),
        JSON.stringify(
          {
            model: p.imageModel,
            durationSeconds: Math.round((Date.now() - started) / 1000),
            results,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      const safeCode = (value) =>
        typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value)
          ? value
          : null;
      await fs
        .writeFile(
          path.join(dir, "api-failure.json"),
          JSON.stringify(
            {
              phase,
              model: p.imageModel,
              requestedSize,
              durationSeconds: Math.round((Date.now() - started) / 1000),
              errorType: safeCode(error.name),
              errorCode: safeCode(error.code),
              causeCode: safeCode(error.cause?.code),
            },
            null,
            2,
          ),
        )
        .catch(() => {});
      if (signal?.aborted) throw new Error("任务已取消；中转站可能仍计费");
      if (timeout.aborted)
        throw new Error("生图 API 超时；未自动重试，中转站可能仍计费");
      if (
        error.message.startsWith("生图") ||
        error.message.startsWith("图片服务")
      )
        throw error;
      throw new Error(
        "生图 API 请求中断或响应处理失败；未自动重试，任务诊断已保存在本机",
      );
    }
  };
}

// Admin probe: try one model on the relay (e.g. a new gpt-image-2.6, SVG output,
// transparent background) and keep whatever comes back for inspection. Never retries.
export async function probeImageModel(config, { model, prompt, size = "1024x1024", format = "png", background }, fetchImpl = fetch) {
  if (!config) return { ok: false, message: "生图 API 未配置" };
  const body = { model, prompt, size, n: 1, response_format: "b64_json" };
  if (format !== "png") body.output_format = format;
  if (background) body.background = background;
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(new URL("images/generations", config.base), {
      method: "POST",
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(300000),
    });
  } catch (error) {
    return { ok: false, seconds: Math.round((Date.now() - started) / 1000), message: `请求失败：${error.name}` };
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const text = Buffer.from(await response.arrayBuffer()).toString("utf8");
  const redact = (t) => t.replaceAll(config.key, "[redacted]");
  if (!response.ok) return { ok: false, status: response.status, seconds, message: redact(text).slice(0, 600) };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, status: response.status, seconds, message: "返回的不是 JSON：" + redact(text).slice(0, 300) };
  }
  const item = data.data?.[0] || {};
  const out = { ok: true, status: response.status, seconds, keys: Object.keys(item), usage: data.usage || null, outputFormat: data.output_format || null };
  if (typeof item.b64_json === "string") {
    const bytes = Buffer.from(item.b64_json, "base64");
    const head = bytes.subarray(0, 200).toString("utf8").trimStart();
    out.kind = /^(<\?xml|<svg)/i.test(head) ? "svg" : bytes[0] === 0x89 ? "png" : bytes[0] === 0xff ? "jpeg" : head.startsWith("RIFF") ? "webp" : "unknown";
    out.bytes = bytes;
  } else if (typeof item.url === "string") {
    out.url = item.url;
    try {
      const r = await fetchImpl(item.url, { signal: AbortSignal.timeout(60000) });
      const bytes = Buffer.from(await r.arrayBuffer());
      out.kind = bytes[0] === 0x89 ? "png" : bytes[0] === 0xff ? "jpeg" : bytes.subarray(0, 4).toString() === "RIFF" ? "webp" : /^(<\?xml|<svg)/i.test(bytes.subarray(0, 200).toString("utf8").trimStart()) ? "svg" : "unknown";
      out.bytes = bytes;
    } catch {
      out.message = "图片地址下载失败";
    }
  }
  else if (typeof item.svg === "string") (out.kind = "svg"), (out.bytes = Buffer.from(item.svg));
  // Is there real transparency (not a drawn checkerboard)?
  if (out.bytes && ["png", "webp"].includes(out.kind)) {
    try {
      const img = sharp(out.bytes);
      const meta = await img.metadata();
      out.width = meta.width;
      out.height = meta.height;
      out.hasAlpha = Boolean(meta.hasAlpha);
      if (meta.hasAlpha) {
        const { data } = await img.extractChannel("alpha").raw().toBuffer({ resolveWithObject: true });
        let clear = 0;
        for (let i = 0; i < data.length; i += 16) if (data[i] < 250) clear++;
        out.transparentShare = Math.round((clear / (data.length / 16)) * 1000) / 1000;
      }
    } catch {}
  }
  return out;
}
