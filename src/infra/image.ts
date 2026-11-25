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
    // 阈值取 3.2：常见的"两个空并排"宽条约 2.5～3，绝不能切，否则会打乱空的对应关系。
    if (ratio <= 3.2 || height < 200) return null;
    const rows = Math.max(1, Math.round(Math.sqrt(ratio)));
    const cols = Math.max(1, Math.ceil(ratio / rows));
    const pieces = rows * cols;
    if (pieces < 2 || pieces > 16) return null;
    return { rows, cols, pieces };
  }
  // 学科策略：公式/符号密集的学科保分辨率；文字为主的科目适度收敛以省 token。
  // 只在用户明确选了学科时生效，detail 一律高精度，避免手写小字被糊掉。
  var SUBJECT_IMAGE_PROFILES = {
    "\u6570\u5B66": { maxEdge: 1600, detail: "high" },
    "\u7269\u7406": { maxEdge: 1600, detail: "high" },
    "\u5316\u5B66": { maxEdge: 1600, detail: "high" },
    "\u751F\u7269": { maxEdge: 1440, detail: "high" },
    "\u8BED\u6587": { maxEdge: 1440, detail: "high" },
    "\u82F1\u8BED": { maxEdge: 1440, detail: "high" },
    "\u5386\u53F2": { maxEdge: 1280, detail: "high" },
    "\u653F\u6CBB": { maxEdge: 1280, detail: "high" },
    "\u5730\u7406": { maxEdge: 1280, detail: "high" }
  };
  // 把配置规整成一次批改真正使用的图片参数；学科自动策略优先于手动尺寸。
  function resolveImageOptions(config) {
    const image = isRecord(config?.image) ? config.image : {};
    const positive = (value, fallback) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : fallback;
    };
    const resolved = {
      maxEdge: Math.min(2400, Math.max(600, positive(image.maxEdge, 1600))),
      quality: Math.min(1, Math.max(0.5, positive(image.quality, 0.82))),
      detail: ["high", "auto", "low"].includes(image.detail) ? image.detail : "high",
      cropToAnswer: image.cropToAnswer === true,
      splitWideStrip: image.splitWideStrip === true,
      mergeImages: image.mergeImages === true
    };
    const subject = String(config?.context?.subject || "").trim();
    const preset = image.autoBySubject === false ? null : SUBJECT_IMAGE_PROFILES[subject];
    if (preset) {
      resolved.maxEdge = preset.maxEdge;
      resolved.detail = preset.detail;
      resolved.subject = subject;
    }
    return resolved;
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
      // 只有"原图本来够清晰、被我们缩到看不清"才算问题；
      // 宽扁作答条本身短边就小，属正常，不再误报。
      lowRes: Math.min(output.width, output.height) < 320 && Math.min(sourceWidth, sourceHeight) >= 320,
      restructured: Boolean(layout)
    };
  }
  // 同题多图按顺序两两纵向拼成一张：省掉每张图的固定开销与 tile 取整浪费。
  // 拼后过高则放弃合并，避免整页被缩到短边 768 后手写发糊。
  async function mergePreparedImages(images, options) {
    if (!options?.mergeImages || !Array.isArray(images) || images.length < 2) return images;
    const merged = [];
    for (let index = 0; index < images.length; index += 2) {
      const first = images[index];
      const second = images[index + 1];
      if (!second) {
        merged.push(first);
        continue;
      }
      // 只有两张图都足够清晰时才合并，否则单页有效分辨率会掉到看不清手写。
      if (Math.min(first.width, first.height, second.width, second.height) < 1100) {
        merged.push(first, second);
        continue;
      }
      const width = Math.max(first.width, second.width);
      const gap = Math.max(16, Math.round(Math.min(first.width, second.width) * 0.03));
      const height = first.height + second.height + gap;
      if (height > width * 2.4) {
        merged.push(first, second);
        continue;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        merged.push(first, second);
        continue;
      }
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(await loadImage(first.dataUrl), 0, 0, first.width, first.height);
      context.drawImage(await loadImage(second.dataUrl), 0, first.height + gap, second.width, second.height);
      const dataUrl = canvas.toDataURL("image/jpeg", Math.min(1, Math.max(0.5, options.quality)));
      merged.push({
        dataUrl,
        hash: await sha256(dataUrl),
        width,
        height,
        blankRatio: Math.min(first.blankRatio, second.blankRatio),
        lowRes: Boolean(first.lowRes || second.lowRes),
        restructured: true,
        mergedCount: 2
      });
    }
    return merged;
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

