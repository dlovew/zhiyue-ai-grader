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
      detail: ["high", "auto", "low"].includes(image.detail) ? image.detail : "high"
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
    // 只做等比缩小，绝不放大：放大不会带来新信息，只会被服务商的短边归一化规则再插值一次。
    const scale = Math.min(1, config.maxEdge / Math.max(sourceWidth, sourceHeight));
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(sourceWidth * scale));
    output.height = Math.max(1, Math.round(sourceHeight * scale));
    const outputCtx = output.getContext("2d", { willReadFrequently: true });
    if (!outputCtx) throw new Error("\u65E0\u6CD5\u521B\u5EFA\u753B\u5E03\u4E0A\u4E0B\u6587");
    outputCtx.drawImage(image, 0, 0, output.width, output.height);
    // 空白率在缩放后的画布上采样：整幅扫描图直接 getImageData 一次就是几十 MB，且结果没有区别。
    const ratio = blankRatio(outputCtx, output.width, output.height);
    const encoded = output.toDataURL("image/jpeg", Math.min(1, Math.max(0.5, config.quality)));
    return {
      dataUrl: encoded,
      hash: await sha256(encoded),
      width: output.width,
      height: output.height,
      blankRatio: ratio,
      // 只有"原图本来够清晰、被我们缩到看不清"才算问题；题块裁切图本身短边就小，属正常。
      lowRes: Math.min(output.width, output.height) < 320 && Math.min(sourceWidth, sourceHeight) >= 320
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

