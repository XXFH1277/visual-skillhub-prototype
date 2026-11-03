import sharp from "sharp";
import mammoth from "mammoth";
import { AppError } from "./store.js";

// Turn a merchant's existing note (PDF / Word / text) into plain text + embedded photos.
const MIN_SIDE = 300;
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

async function fromPdf(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false }).promise;
  if (doc.numPages > 80) throw new AppError("PDF 页数过多（超过 80 页）");
  let text = "";
  const images = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((x) => x.str + (x.hasEOL ? "\n" : "")).join("") + "\n";
    const ops = await page.getOperatorList();
    for (let j = 0; j < ops.fnArray.length && images.length < 40; j++) {
      if (ops.fnArray[j] !== pdfjs.OPS.paintImageXObject) continue;
      const name = ops.argsArray[j][0];
      const img = await withTimeout(new Promise((r) => page.objs.get(name, r)), 3000);
      if (!img?.data || img.width < MIN_SIDE || img.height < MIN_SIDE) continue;
      const channels = Math.round(img.data.length / (img.width * img.height));
      if (![1, 3, 4].includes(channels)) continue;
      try {
        images.push(
          await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels } })
            .jpeg({ quality: 88 })
            .toBuffer(),
        );
      } catch {}
    }
    page.cleanup();
  }
  await doc.destroy();
  return { text, images };
}

async function fromDocx(buffer) {
  const images = [];
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const data = await image.read();
        if (images.length < 40) images.push(Buffer.from(data));
        return { src: "" };
      }),
    },
  );
  const text = html
    .replace(/<\/(p|h\d|li|tr)>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  const usable = [];
  for (const b of images) {
    try {
      const m = await sharp(b).metadata();
      if (m.width >= MIN_SIDE && m.height >= MIN_SIDE) usable.push(b);
    } catch {}
  }
  return { text, images: usable };
}

export async function importNote(file) {
  const name = (file.originalname || "").toLowerCase();
  try {
    if (file.mimetype === "application/pdf" || name.endsWith(".pdf")) return await fromPdf(file.buffer);
    if (name.endsWith(".docx")) return await fromDocx(file.buffer);
    if (name.endsWith(".txt") || file.mimetype.startsWith("text/")) return { text: file.buffer.toString("utf8"), images: [] };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("文件读取失败，请确认是正常的 PDF / Word 文件，或直接粘贴文字");
  }
  throw new AppError("只支持 PDF、Word（.docx）或 txt；旧版 .doc 请另存为 .docx");
}
