// The first complete JSON object in the answer (models sometimes add text or a second object).
export function parseJsonObject(answer) {
  const text = String(answer || "");
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  // Last resort: models sometimes quote words inside a value with plain " (「主图"深海"」),
  // or leave a trailing comma. Repair those and try once more.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(repair(text.slice(first, last + 1)));
    } catch {}
  }
  throw new Error("AI 返回内容无法解析");
}

function repair(src) {
  let out = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      continue;
    }
    if (c === "\\") {
      out += c + (src[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "\n") {
      out += "\\n";
      continue;
    }
    if (c === '"') {
      // A real closing quote is followed by , : } ] (after spaces); anything else is a quote mark inside the text.
      const next = src.slice(i + 1).match(/^\s*(.)/)?.[1];
      if (next === undefined || ",:}]".includes(next)) inString = false;
      else {
        out += '\\"';
        continue;
      }
    }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}
