import sharp from "sharp";
import { layoutBoxes } from "../shared/scenes.js";

// Program typesetting: the layout sketch shown to merchants / sent as a text
// reference to the image model, exact-text overlays, and detail-page captions.

const OPTIONS = { limitInputPixels: 40_000_000, failOn: "warning" };
const FONT =
  "Microsoft YaHei, PingFang SC, Noto Sans CJK SC, Source Han Sans SC, sans-serif";
const xml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c],
  );

const charWidth = (c) => (/[\u0000-ÿ]/.test(c) ? 0.56 : 1);
const textWidth = (s, size) => Array.from(s).reduce((w, c) => w + charWidth(c), 0) * size;

export function wrap(text, size, maxWidth) {
  const lines = [];
  let line = "";
  for (const c of Array.from(String(text))) {
    if (c === "\n") {
      lines.push(line);
      line = "";
      continue;
    }
    if (line && textWidth(line + c, size) > maxWidth) {
      // keep short latin words together where possible
      const m = line.match(/^(.*[^A-Za-z0-9.%])([A-Za-z0-9.%]{1,8})$/);
      if (/[A-Za-z0-9.%]/.test(c) && m) {
        lines.push(m[1]);
        line = m[2] + c;
        continue;
      }
      lines.push(line);
      line = c === " " ? "" : c;
    } else line += c;
  }
  if (line) lines.push(line);
  return lines;
}

const ROLE_STYLE = {
  headline: { scale: 1, weight: 700, gap: 0.35 },
  sub: { scale: 0.6, weight: 500, gap: 0.45 },
  price: { scale: 0.8, weight: 800, gap: 0.4, accent: true },
  point: { scale: 0.5, weight: 500, gap: 0.5, bullet: true },
  body: { scale: 0.42, weight: 400, gap: 0.55 },
  cta: { scale: 0.44, weight: 700, gap: 0.5, pill: true },
  footer: { scale: 0.34, weight: 400, gap: 0.5, muted: true },
};

function measure(texts, unit, maxWidth) {
  const blocks = texts.map((t) => {
    const style = ROLE_STYLE[t.role] || ROLE_STYLE.body;
    const size = Math.max(12, unit * style.scale);
    const content = style.bullet ? "· " + t.text : t.text;
    const lines = wrap(content, size, maxWidth - (style.pill ? size * 1.6 : 0));
    const lineHeight = size * 1.3;
    const height = lines.length * lineHeight + (style.pill ? size * 0.6 : 0);
    return { ...t, style, size, lines, lineHeight, height, gap: size * style.gap };
  });
  const total = blocks.reduce((h, b, i) => h + b.height + (i ? b.gap : 0), 0);
  return { blocks, total };
}

// Fit a stack of role-styled texts into a box. Returns SVG elements (no wrapper).
export function textElements(texts, box, { color = "#1b1f2a", accent = "#e8541e", align = "center", valign = "center" } = {}) {
  const list = texts.filter((t) => t.text?.trim());
  if (!list.length || !box) return "";
  // Headline size: fit the longest headline-ish line in at most two lines.
  const lead = list.find((t) => t.role === "headline") || list[0];
  const leadWidth = textWidth(lead.text, 1);
  let unit = Math.min(box.h * 0.34, box.w / 4, (box.w * 2) / Math.max(leadWidth + 1, 4));
  let fit = measure(list, unit, box.w);
  for (let i = 0; i < 40 && fit.total > box.h; i++) {
    unit *= 0.92;
    fit = measure(list, unit, box.w);
  }
  let y =
    box.y +
    (valign === "top" ? 0 : valign === "bottom" ? box.h - fit.total : (box.h - fit.total) / 2);
  const anchor = align === "left" ? "start" : "middle";
  const x = align === "left" ? box.x : box.x + box.w / 2;
  const out = [];
  fit.blocks.forEach((b, i) => {
    if (i) y += b.gap;
    const fill = b.style.accent ? accent : b.style.muted ? color : color;
    const opacity = b.style.muted ? ' fill-opacity="0.72"' : "";
    if (b.style.pill) {
      const w = Math.max(...b.lines.map((l) => textWidth(l, b.size))) + b.size * 1.6;
      const px = align === "left" ? box.x : x - w / 2;
      out.push(
        `<rect x="${px}" y="${y}" width="${w}" height="${b.height}" rx="${b.height / 2}" fill="${accent}"/>`,
      );
      b.lines.forEach((line, j) =>
        out.push(
          `<text x="${align === "left" ? px + b.size * 0.8 : x}" y="${y + b.size * 0.3 + b.size * 1.02 + j * b.lineHeight}" font-size="${b.size.toFixed(1)}" font-weight="${b.style.weight}" fill="#ffffff" text-anchor="${anchor}">${xml(line)}</text>`,
        ),
      );
    } else
      b.lines.forEach((line, j) =>
        out.push(
          `<text x="${x}" y="${y + b.size * 1.02 + j * b.lineHeight}" font-size="${b.size.toFixed(1)}" font-weight="${b.style.weight}" fill="${fill}"${opacity} text-anchor="${anchor}">${xml(line)}</text>`,
        ),
      );
    y += b.height;
  });
  return `<g font-family="${FONT}">${out.join("")}</g>`;
}

const alignFor = (layout) => (["left", "right"].includes(layout) ? "left" : "center");

// Layout sketch: the merchant's photo in the image area plus the exact confirmed
// text in the text area. Contains nothing else, so the model has nothing to copy by mistake.
export async function renderLayoutSketch({ width, height, layout, texts, mainImage, accent }, out) {
  const boxes = layoutBoxes(layout, width, height);
  const layers = [];
  if (mainImage) {
    const box = boxes.image;
    const img = await sharp(mainImage, OPTIONS)
      .resize(box.w, box.h, { fit: "contain", background: "#f3f1ec" })
      .png()
      .toBuffer();
    layers.push({ input: img, left: box.x, top: box.y });
  }
  if (boxes.text && texts.length) {
    const scrim =
      layout === "center"
        ? `<rect x="${boxes.text.x - 20}" y="${boxes.text.y - 20}" width="${boxes.text.w + 40}" height="${boxes.text.h + 40}" rx="24" fill="#ffffff" fill-opacity="0.86"/>`
        : "";
    layers.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${scrim}${textElements(texts, boxes.text, { accent, align: alignFor(layout) })}</svg>`,
      ),
      left: 0,
      top: 0,
    });
  }
  await sharp({ create: { width, height, channels: 3, background: "#f3f1ec" } })
    .composite(layers)
    .png()
    .toFile(out);
}

// Exact text on top of a generated (text-free) image. Picks dark or light ink from
// the region brightness and adds a soft scrim when the background is busy.
export async function overlayTexts(input, { layout, texts, accent }, out) {
  const image = sharp(input, OPTIONS);
  const { width, height } = await image.metadata();
  const box = layoutBoxes(layout, width, height).text;
  if (!box || !texts.length) {
    await sharp(input, OPTIONS).png().toFile(out);
    return;
  }
  const stats = await sharp(input, OPTIONS)
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .greyscale()
    .stats();
  const { mean, stdev } = stats.channels[0];
  const dark = mean > 140;
  const color = dark ? "#16181f" : "#ffffff";
  const busy = stdev > 48 || (mean > 90 && mean < 170);
  const scrim = busy
    ? `<rect x="${box.x - 18}" y="${box.y - 14}" width="${box.w + 36}" height="${box.h + 28}" rx="22" fill="${dark ? "#ffffff" : "#000000"}" fill-opacity="${dark ? 0.72 : 0.42}"/>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${scrim}${textElements(texts, box, { color, accent, align: alignFor(layout) })}</svg>`;
  await sharp(input, OPTIONS)
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toFile(out);
}

// Caption panel under each detail-page screen (750px wide, height grows with text).
export function detailCaption(texts, accent) {
  const list = texts.filter((t) => t.text?.trim());
  if (!list.length) return null;
  const width = 750;
  const box = { x: 60, y: 44, w: 630, h: 2000 };
  const sized = list.map((t) => ({
    ...t,
    size: t.role === "headline" ? 40 : 26,
    weight: t.role === "headline" ? 700 : 400,
  }));
  let y = box.y;
  const out = [];
  sized.forEach((t, i) => {
    if (i) y += t.role === "headline" ? 18 : 14;
    const lines = wrap(t.text, t.size, box.w);
    lines.forEach((line, j) =>
      out.push(
        `<text x="${width / 2}" y="${y + t.size + j * t.size * 1.45}" font-size="${t.size}" font-weight="${t.weight}" fill="${t.role === "headline" ? "#16181f" : "#4a4f5c"}" text-anchor="middle">${xml(line)}</text>`,
      ),
    );
    y += lines.length * t.size * 1.45;
  });
  const height = Math.round(y + 56);
  return {
    height,
    svg: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff"/><rect x="${width / 2 - 22}" y="20" width="44" height="4" rx="2" fill="${accent}"/><g font-family="${FONT}">${out.join("")}</g></svg>`,
    ),
  };
}
