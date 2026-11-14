// Export selections belong to this browser tab and leave the original screens alone.
const selections = new Map();

export function mountLongExport(root, { key, items, esc, busy, onChange, onExport }) {
  const state = selections.get(key) || { order: [], excluded: new Set() };
  selections.set(key, state);
  const byId = new Map(items.map((item) => [item.id, item]));
  const ids = state.order.filter((id) => byId.has(id));
  ids.push(...items.map((item) => item.id).filter((id) => !ids.includes(id)));

  root.innerHTML = `
    <h2>拼接长图</h2>
    <p class="muted">勾选要拼的分屏，用箭头调整顺序。取消勾选后，分屏仍可单独下载。</p>
    <ol class="long-export-list"></ol>
    <div class="row wrap long-export-actions">
      <span class="muted" role="status"></span>
      <button class="btn primary" type="button">导出选中长图</button>
    </div>`;
  const list = root.querySelector("ol");
  const status = root.querySelector('[role="status"]');
  const button = root.querySelector(".long-export-actions button");
  let exporting = false;
  const selected = () => ids.map((id) => byId.get(id)).filter((item) => !item.unavailable && !state.excluded.has(item.id));
  const update = () => {
    const picked = selected();
    status.textContent = `已选 ${picked.length} / ${items.length} 屏`;
    button.disabled = exporting || !picked.length;
    onChange(picked);
  };

  function renderList() {
    list.innerHTML = ids.map((id, i) => {
      const { title, thumb, unavailable } = byId.get(id);
      return `<li>
        <label><input type="checkbox" data-index="${i}" ${unavailable || state.excluded.has(id) ? "" : "checked"} ${unavailable ? "disabled" : ""}>
          ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" decoding="async">` : ""}
          <span>${esc(title)}${unavailable ? `<small class="muted">${esc(unavailable)}</small>` : ""}</span>
        </label>
        <div class="sec-move">
          <button type="button" data-index="${i}" data-move="-1" aria-label="上移 ${esc(title)}" ${i === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-index="${i}" data-move="1" aria-label="下移 ${esc(title)}" ${i === ids.length - 1 ? "disabled" : ""}>↓</button>
        </div>
      </li>`;
    }).join("");
  }
  list.onchange = (event) => {
    const checkbox = event.target;
    const id = ids[Number(checkbox.dataset.index)];
    if (checkbox.checked) state.excluded.delete(id);
    else state.excluded.add(id);
    update();
  };
  list.onclick = (event) => {
    const move = event.target.closest("[data-move]");
    if (!move) return;
    const from = Number(move.dataset.index);
    const to = from + Number(move.dataset.move);
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    state.order = ids.slice();
    renderList();
    (list.children[to].querySelector(`[data-move="${move.dataset.move}"]:enabled`) || list.children[to].querySelector("button:enabled"))?.focus();
    update();
  };
  button.onclick = async () => {
    const picked = selected();
    if (!picked.length || exporting) return;
    exporting = true;
    button.textContent = "正在拼接…";
    await busy(button, () => onExport(picked));
    exporting = false;
    button.textContent = "导出选中长图";
    update();
  };
  renderList();
  update();
}

export function downloadImage(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
}

export async function exportLongImage(items, imageSource, filename, format = "image/png") {
  const width = 750;
  const parts = [];
  let height = 0;
  for (const item of items) {
    const image = new Image();
    try {
      image.src = await imageSource(item);
      await image.decode();
    } catch {
      throw new Error(`「${item.title}」加载失败，请重试。`);
    }
    const partHeight = Math.max(1, Math.round(image.naturalHeight * width / image.naturalWidth));
    parts.push({ image, height: partHeight });
    height += partHeight;
    if (height > 32000) throw new Error("长图太长，请减少几屏或分段导出。");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  for (const part of parts) {
    ctx.drawImage(part.image, 0, y, width, part.height);
    y += part.height;
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, format, 0.9));
  if (!blob) throw new Error("长图导出失败，请重试。");
  const url = URL.createObjectURL(blob);
  downloadImage(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
