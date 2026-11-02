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
    try {
      for (let i = 0; i < p.count; i++) {
        combined.throwIfAborted();
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
      }
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
