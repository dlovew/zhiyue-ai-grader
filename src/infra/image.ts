  // src/infra/image.ts
  function fallbackHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  async function sha256(text) {
    if (globalThis.crypto?.subtle) {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return fallbackHash(text);
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("\u56FE\u7247\u52A0\u8F7D\u5931\u8D25"));
      image.src = src;
    });
  }
  async function fetchAsDataUrl(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        timeout: 3e4,
        onload: (response) => {
          const raw = response.response;
          const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new TextEncoder().encode(response.responseText ?? "");
          const blob = new Blob([bytes], { type: "image/jpeg" });
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("\u56FE\u7247\u8BFB\u53D6\u5931\u8D25"));
          reader.readAsDataURL(blob);
        },
        onerror: () => reject(new Error("\u56FE\u7247\u4E0B\u8F7D\u5931\u8D25")),
        ontimeout: () => reject(new Error("\u56FE\u7247\u4E0B\u8F7D\u8D85\u65F6"))
      });
    });
  }
  function contentBox(ctx, width, height) {
    try {
      const data = ctx.getImageData(0, 0, width, height).data;
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      let found = false;
      for (let y2 = 0; y2 < height; y2 += 2) {
        for (let x2 = 0; x2 < width; x2 += 2) {
          const index = (y2 * width + x2) * 4;
          const alpha = data[index + 3];
          const brightness = (data[index] + data[index + 1] + data[index + 2]) / 3;
          if (alpha > 32 && brightness < 245) {
            found = true;
            if (x2 < minX) minX = x2;
            if (y2 < minY) minY = y2;
            if (x2 > maxX) maxX = x2;
            if (y2 > maxY) maxY = y2;
          }
        }
      }
      if (!found) return null;
      // 留够边距，避免裁掉贴在边缘的作答与跨栏标注。
      const pad = Math.max(6, Math.floor(Math.min(width, height) * 0.06));
      const x = Math.max(0, minX - pad);
      const y = Math.max(0, minY - pad);
      const w = Math.min(width, maxX + pad + 1) - x;
      const h = Math.min(height, maxY + pad + 1) - y;
      if (w < 32 || h < 32 || w * h > width * height * 0.72) return null;
      return { x, y, w, h };
    } catch {
      return null;
    }
  }
  function blankRatio(ctx, width, height) {
    try {
      const data = ctx.getImageData(0, 0, width, height).data;
      let blank = 0;
      let total = 0;
      for (let i = 0; i < data.length; i += 16) {
        total += 1;
        if ((data[i] + data[i + 1] + data[i + 2]) / 3 > 248) blank += 1;
      }
      return total > 0 ? blank / total : 1;
    } catch {
      return 0;
    }
  }
  // 宽扁的作答条在视觉模型里会被"短边拉到 768"规则放大宽度，tile 数暴涨。
  // 切成等宽小块后按网格重排成接近方形的版面，tile 数可降到 1/3 左右。
  function stripLayout(width, height) {
    const ratio = height > 0 ? width / height : 0;
    if (ratio <= 2.4 || height < 160) return null;
    const rows = Math.max(1, Math.round(Math.sqrt(ratio)));
    const cols = Math.max(1, Math.ceil(ratio / rows));
    const pieces = rows * cols;
    if (pieces < 2 || pieces > 16) return null;
    return { rows, cols, pieces };
  }
  async function prepareImage(src, config) {
    const dataUrl = src.startsWith("data:") ? src : await fetchAsDataUrl(src);
    const image = await loadImage(dataUrl);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const work = document.createElement("canvas");
    work.width = sourceWidth;
    work.height = sourceHeight;
    const workCtx = work.getContext("2d", { willReadFrequently: true });
    if (!workCtx) throw new Error("\u65E0\u6CD5\u521B\u5EFA\u753B\u5E03\u4E0A\u4E0B\u6587");
    workCtx.drawImage(image, 0, 0);
    const ratio = blankRatio(workCtx, sourceWidth, sourceHeight);
    let sx = 0;
    let sy = 0;
    let sw = sourceWidth;
    let sh = sourceHeight;
    if (config.cropToAnswer) {
      const box = contentBox(workCtx, sourceWidth, sourceHeight);
      if (box) {
        sx = box.x;
        sy = box.y;
        sw = box.w;
        sh = box.h;
      }
    }
    const layout = config.splitWideStrip === false ? null : stripLayout(sw, sh);
    const gap = 16;
    const piecesW = layout ? sw / layout.pieces : sw;
    const boardW = layout ? layout.cols * piecesW : sw;
    const boardH = layout ? layout.rows * sh + (layout.rows - 1) * gap : sh;
    const scale = Math.min(1, config.maxEdge / Math.max(boardW, boardH));
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(boardW * scale));
    output.height = Math.max(1, Math.round(boardH * scale));
    const outputCtx = output.getContext("2d");
    if (!outputCtx) throw new Error("\u65E0\u6CD5\u521B\u5EFA\u753B\u5E03\u4E0A\u4E0B\u6587");
    if (layout) {
      // 左上到右下按原顺序重排，阅读顺序不乱；块间留白避免笔画粘连。
      for (let index = 0; index < layout.pieces; index += 1) {
        const col = index % layout.cols;
        const row = Math.floor(index / layout.cols);
        outputCtx.drawImage(
          work,
          sx + index * piecesW, sy, piecesW, sh,
          Math.round(col * piecesW * scale), Math.round(row * (sh + gap) * scale),
          Math.ceil(piecesW * scale), Math.ceil(sh * scale)
        );
      }
    } else {
      outputCtx.drawImage(work, sx, sy, sw, sh, 0, 0, output.width, output.height);
    }
    const encoded = output.toDataURL("image/jpeg", Math.min(1, Math.max(0.5, config.quality)));
    return {
      dataUrl: encoded,
      hash: await sha256(encoded),
      width: output.width,
      height: output.height,
      blankRatio: ratio,
      lowRes: Math.min(output.width, output.height) < 400,
      restructured: Boolean(layout)
    };
  }
  function dedupePrepared(images) {
    const seen = /* @__PURE__ */ new Set();
    return images.filter((image) => {
      if (seen.has(image.hash)) return false;
      seen.add(image.hash);
      return true;
    });
  }
  function isBlankImage(image) {
    return image.blankRatio > 0.97;
  }
  function isWasteImage(image) {
    const { width, height } = image;
    return width < 15 || height < 15 || Math.max(width / height, height / width) > 100;
  }

