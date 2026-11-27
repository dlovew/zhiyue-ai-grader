  // src/ui/panel.ts
  var STATUS_LABEL = {
    legible: "\u53EF\u8FA8\u8BA4",
    partial: "\u90E8\u5206\u4E0D\u6E05",
    illegible: "\u65E0\u6CD5\u8FA8\u8BA4",
    blank: "\u672A\u4F5C\u7B54"
  };
  var SKIP_CONFIRM_KEY = "zygr.submit.skipConfirm.v1";
  var CONTINUOUS_LIMIT_MAX = 5000;
  var CONTINUOUS_LIMIT_HINT = `\u8FDE\u7EED\u6279\u9605\u6700\u591A\u81EA\u52A8\u6279\u6539\u5E76\u63D0\u4EA4\u7684\u4EFD\u6570\uFF0C\u8FBE\u5230\u540E\u4F1A\u81EA\u52A8\u505C\u6B62\uFF1B\u4E0D\u662F\u5FC5\u987B\u6279\u6EE1\u7684\u4EFD\u6570\u30021\uFF5E${CONTINUOUS_LIMIT_MAX} \u4EFD\uFF0C\u9ED8\u8BA4 20 \u4EFD`;
  var OUTPUT_MODE_HINT = "\u8F93\u51FA\u6863\u4F4D\u51B3\u5B9A\u6A21\u578B\u5199\u591A\u5C11\u5B57\uFF1A\u7B80\u7565\u6700\u7701 token\uFF0C\u6807\u51C6\u9002\u4E2D\uFF0C\u8BE6\u7EC6\u6700\u8D39\u3002\u6539\u52A8\u540E\u7ACB\u5373\u4FDD\u5B58\uFF0C\u4ECE\u4E0B\u4E00\u4EFD\u5F00\u59CB\u751F\u6548\u3002";
  var OUTPUT_MODE_SHORT = { brief: "\u7B80\u7565", standard: "\u6807\u51C6", detailed: "\u8BE6\u7EC6" };
  function normalizeContinuousLimit(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return 20;
    return Math.max(1, Math.min(CONTINUOUS_LIMIT_MAX, number));
  }
  // 所有面板输入框都拦下 Enter：页面本身可能把回车当提交，会把半截分数写进平台。
  // 只阻止冒泡；文本域仍保留换行（不 preventDefault）。
  function guardEnter(root) {
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const target = event.target;
      if (!target || !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || "")) return;
      event.stopPropagation();
      if (target.tagName !== "TEXTAREA") event.preventDefault();
    });
  }
  var GraderPanel = class {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.toastTimer = 0;
      this.cacheMiss = null;
      this.host = document.createElement("div");
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      guardEnter(this.shadow);
      this.panel = this.q(".zp-panel");
      const version = this.shadow.querySelector("#zygr-version");
      if (version) version.textContent = `v${typeof ZYGR_VERSION === "string" ? ZYGR_VERSION : "dev"}`;
      const skipConfirm = this.shadow.querySelector("[data-opt='skip-submit-confirm']");
      if (skipConfirm) skipConfirm.checked = readJson(SKIP_CONFIRM_KEY, false) === true;
      this.setContinuousLimit(20);
      this.setOutputMode("standard");
      this.bind();
    }
    markup() {
      const outputButtons = Object.keys(OUTPUT_MODES).map((key) => `
          <button data-output-mode="${key}" aria-pressed="${key === "standard" ? "true" : "false"}" title="${OUTPUT_MODES[key].label}">${OUTPUT_MODE_SHORT[key] || key}</button>`).join("");
      return `<div class="zp-panel">
      <header class="zp-head">
        <div class="zp-brand">
          <span class="zp-logo" aria-hidden="true">\u667A</span>
          <div class="zp-titles">
            <div class="zp-titleline">
              <strong>\u667A\u9605\u6279\u6539\u52A9\u624B</strong>
              <span class="zp-ver" id="zygr-version" title="\u5F53\u524D\u811A\u672C\u7248\u672C">v--</span>
            </div>
            <span class="zp-sub" id="zygr-subtitle">\u7B49\u5F85\u8BFB\u53D6\u9898\u76EE</span>
          </div>
        </div>
        <div class="zp-header-actions">
          <button class="zp-iconbtn" data-act="collapse" title="\u6298\u53E0" aria-label="\u6298\u53E0">
            <svg class="zp-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <button class="zp-iconbtn" data-act="close" title="\u5173\u95ED" aria-label="\u5173\u95ED">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
      </header>
      <div class="zp-body">
        <div class="zp-status">
          <span class="zp-stage"><i class="zp-dot" id="zygr-dot"></i><span id="zygr-stage">\u5C31\u7EEA</span></span>
          <span class="zp-count" id="zygr-progress" hidden></span>
          <span class="zp-chip" id="zygr-cache">\u5F85\u914D\u7F6E</span>
        </div>
        <div class="zp-track"><i id="zygr-bar"></i></div>
        <section class="zp-card" aria-label="\u5F53\u524D\u9898\u76EE">
          <div class="zp-qhead">
            <div class="zp-qmain">
              <span class="zp-kicker">\u5F53\u524D\u9898\u76EE</span>
              <div class="zp-qtitle" id="zygr-qtitle">\u672A\u8BFB\u53D6</div>
              <div class="zp-qmeta" id="zygr-meta">\u5C1A\u672A\u68C0\u6D4B\u5230\u9605\u5377\u9875\u9762</div>
            </div>
          </div>
          <div class="zp-thumbs" id="zygr-thumbs"></div>
        </section>
        <section class="zp-card zp-result" id="zygr-result" aria-live="polite"></section>
        <div class="zp-error" id="zygr-error" hidden></div>
      </div>
      <footer class="zp-foot">
        <div class="zp-actions">
          <button class="zp-btn primary" data-act="grade">\u5F00\u59CB\u6279\u6539</button>
          <button class="zp-btn zp-submit" data-act="submit">\u63D0\u4EA4\u7ED3\u679C</button>
        </div>
        <div class="zp-options">
          <button class="zp-mini" data-act="continuous">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5l11 7-11 7z"/></svg>
            <span>\u8FDE\u7EED\u6279\u9605</span>
          </button>
          <span class="zp-optlabel">\u6700\u591A</span>
          <div class="zp-stepper" title="${CONTINUOUS_LIMIT_HINT}">
            <button data-step="-1" aria-label="\u51CF\u5C11\u4EFD\u6570">\u2212</button>
            <input type="number" data-opt="continuous-limit" min="1" max="${CONTINUOUS_LIMIT_MAX}" step="1" value="20" aria-label="\u8FDE\u7EED\u6279\u9605\u6700\u591A\u6279\u6539\u4EFD\u6570" title="${CONTINUOUS_LIMIT_HINT}">
            <button data-step="1" aria-label="\u589E\u52A0\u4EFD\u6570">+</button>
          </div>
          <span class="zp-optlabel">\u4EFD</span>
          <div class="zp-seg" role="group" aria-label="\u8F93\u51FA\u6863\u4F4D" title="${OUTPUT_MODE_HINT}">${outputButtons}
          </div>
        </div>
        <div class="zp-footbar">
          <label class="zp-skip" title="\u52FE\u9009\u540E\u63D0\u4EA4\u4E0D\u518D\u5F39\u786E\u8BA4\u6846">
            <input type="checkbox" data-opt="skip-submit-confirm">
            <span class="zp-switch" aria-hidden="true"></span>
            <span>\u63D0\u4EA4\u514D\u786E\u8BA4</span>
          </label>
          <span class="zp-tools">
            <button class="zp-quiet" data-act="history">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              \u5386\u53F2
            </button>
            <button class="zp-quiet" data-act="settings">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="7" cy="17" r="2"/></svg>
              \u8BBE\u7F6E
            </button>
          </span>
        </div>
      </footer>
      <div class="zygr-toast" id="zygr-toast" hidden></div>
    </div>
    <div class="zygr-overlay" id="zygr-cache-help" hidden>
      <div class="zygr-dialog zygr-help" role="dialog" aria-modal="true" aria-labelledby="zygr-cache-help-title">
        <header class="zg-head">
          <div>
            <h2 id="zygr-cache-help-title">\u524D\u7F00\u7F13\u5B58\u672A\u547D\u4E2D</h2>
            <p>\u4E0D\u5F71\u54CD\u9605\u5377\u7ED3\u679C\uFF0C\u53EA\u5F71\u54CD\u8D39\u7528\u4E0E\u9996\u5B57\u901F\u5EA6</p>
          </div>
          <button class="zp-iconbtn" data-act="cache-help-close" aria-label="\u5173\u95ED">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </header>
        <div class="zygr-cache-help-body" id="zygr-cache-help-body"></div>
        <footer class="zg-foot">
          <div class="zg-foot-left"></div>
          <div class="zg-foot-right"><button class="zg-btn primary" data-act="cache-help-close">\u77E5\u9053\u4E86</button></div>
        </footer>
      </div>
    </div>`;
    }
    q(selector) {
      const element = this.shadow.querySelector(selector);
      if (!element) throw new Error(`\u754C\u9762\u5143\u7D20\u7F3A\u5931\uFF1A${selector}`);
      return element;
    }
    setText(id, value) {
      this.q(`#${id}`).textContent = value;
    }
    bind() {
      this.shadow.addEventListener("change", (event) => {
        const target = event.target;
        if (target?.matches?.("[data-opt='skip-submit-confirm']")) {
          writeJson(SKIP_CONFIRM_KEY, Boolean(target.checked));
        } else if (target?.matches?.("[data-opt='continuous-limit']")) {
          this.setContinuousLimit(target.value);
          this.callbacks.onContinuousLimitChange?.(normalizeContinuousLimit(target.value));
        }
      });
      this.shadow.addEventListener("click", (event) => {
        const step = event.target.closest("[data-step]");
        if (step) {
          if (step.disabled) return;
          const limitInput = this.shadow.querySelector("[data-opt='continuous-limit']");
          const next = normalizeContinuousLimit(Number(limitInput?.value || 20) + Number(step.dataset.step));
          this.setContinuousLimit(next);
          this.callbacks.onContinuousLimitChange?.(next);
          return;
        }
        const output = event.target.closest("[data-output-mode]");
        if (output) {
          const value = normalizeOutputMode(output.dataset.outputMode);
          this.setOutputMode(value);
          this.callbacks.onOutputModeChange?.(value);
          return;
        }
        const button = event.target.closest("[data-act]");
        if (!button) return;
        const action = button.dataset.act;
        if (action === "collapse") {
          const collapsed = this.panel.classList.toggle("is-collapsed");
          button.setAttribute("aria-expanded", String(!collapsed));
        } else if (action === "close") {
          this.hide();
        } else if (action === "grade") {
          this.callbacks.onGrade();
        } else if (action === "continuous") {
          this.callbacks.onContinuous();
        } else if (action === "submit") {
          const skipConfirm = Boolean(this.shadow.querySelector("[data-opt='skip-submit-confirm']")?.checked);
          this.callbacks.onSubmit(skipConfirm);
        } else if (action === "history") {
          this.callbacks.onHistory();
        } else if (action === "settings") {
          this.callbacks.onSettings();
        } else if (action === "cache-help") {
          this.showCacheHelp();
        } else if (action === "cache-help-close") {
          this.hideCacheHelp();
        }
      });
      const help = this.shadow.querySelector("#zygr-cache-help");
      if (help) {
        help.addEventListener("click", (event) => {
          if (event.target === help) this.hideCacheHelp();
        });
      }
      this.shadow.addEventListener("keydown", (event) => {
        if (event.key === "Escape") this.hideCacheHelp();
      });
    }
    mount() {
      if (!this.host.isConnected) document.body.appendChild(this.host);
    }
    show() {
      this.mount();
      this.panel.hidden = false;
    }
    hide() {
      this.panel.hidden = true;
      this.hideCacheHelp();
    }
    setSubtitle(value) {
      this.setText("zygr-subtitle", value);
    }
    setQuestion(question) {
      this.renderThumbs(question?.images ?? []);
      if (!question) {
        this.setText("zygr-qtitle", "\u672A\u8BFB\u53D6");
        this.setText("zygr-meta", "\u5C1A\u672A\u68C0\u6D4B\u5230\u9605\u5377\u9875\u9762");
        return;
      }
      const subs = question.subQuestions.length > 0 ? `${question.subQuestions.length} \u4E2A\u5C0F\u9898 \xB7 ` : "";
      this.setText("zygr-qtitle", `\u9898\u53F7 ${question.questionId}`);
      this.setText("zygr-meta", `${subs}\u6EE1\u5206 ${question.maxScore || "\u672A\u6307\u5B9A"} \xB7 \u4F5C\u7B54\u56FE\u7247 ${question.images.length} \u5F20`);
    }
    renderThumbs(images) {
      const container = this.q("#zygr-thumbs");
      container.replaceChildren();
      for (const src of images.slice(0, 6)) {
        if (!/^(data:image\/|https?:\/\/)/i.test(src)) continue;
        const image = document.createElement("img");
        image.src = src;
        image.alt = "\u4F5C\u7B54\u56FE\u7247\u7F29\u7565\u56FE";
        image.title = "\u4F5C\u7B54\u56FE\u7247\u7F29\u7565\u56FE";
        image.onerror = () => image.remove();
        container.appendChild(image);
      }
    }
    setStage(stage, detail) {
      this.setText("zygr-stage", detail ? `${stage} \xB7 ${detail}` : stage);
      const progress = this.q("#zygr-bar");
      progress.style.width = stage.includes("\u7F13\u5B58\u547D\u4E2D") || stage === "\u5B8C\u6210" ? "100%" : stage.includes("\u8BC4\u5206") ? "70%" : "35%";
      const dot = this.q("#zygr-dot");
      dot.className = stage === "\u5B8C\u6210" ? "zp-dot ok" : stage.includes("\u505C\u6B62") ? "zp-dot warn" : "zp-dot";
    }
    setProgress(text) {
      const element = this.q("#zygr-progress");
      element.textContent = text || "";
      element.hidden = !text;
    }
    setCache(label, kind = "idle") {
      const chip = this.q("#zygr-cache");
      chip.textContent = label;
      chip.className = `zp-chip${kind === "ok" ? " ok" : kind === "warn" ? " warn" : kind === "new" ? " new" : ""}`;
    }
    setBusy(busy, label = "\u5904\u7406\u4E2D") {
      this.shadow.querySelectorAll('.zp-foot .zp-btn:not([data-act="continuous"]), .zp-quiet, [data-output-mode]').forEach((button) => {
        button.disabled = busy;
      });
      if (busy) this.setStage(label);
    }
    setAutoMode(active) {
      const button = this.q('[data-act="continuous"]');
      const label = button.querySelector("span");
      if (label) label.textContent = active ? "\u505C\u6B62\u8FDE\u7EED\u6279\u9605" : "\u8FDE\u7EED\u6279\u9605";
      button.classList.toggle("running", active);
      // 运行中改上限会让人误以为当前这一轮会跟着变；锁定后提示下一次启动才生效。
      const limit = this.shadow.querySelector("[data-opt='continuous-limit']");
      if (limit) limit.disabled = active;
      this.shadow.querySelectorAll("[data-step]").forEach((step) => {
        step.disabled = active;
      });
    }
    setContinuousLimit(value) {
      const limit = this.shadow.querySelector("[data-opt='continuous-limit']");
      if (limit) limit.value = String(normalizeContinuousLimit(value));
    }
    setOutputMode(value) {
      const mode = normalizeOutputMode(value);
      this.shadow.querySelectorAll("[data-output-mode]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.outputMode === mode));
      });
    }
    showError(message) {
      const box = this.q("#zygr-error");
      box.textContent = message;
      box.hidden = false;
    }
    clearError() {
      const box = this.q("#zygr-error");
      box.textContent = "";
      box.hidden = true;
    }
    setResult(result) {
      const container = this.q("#zygr-result");
      container.replaceChildren();
      this.cacheMiss = result.cacheMiss || null;

      const head = document.createElement("div");
      head.className = "zp-scorehead";
      const left = document.createElement("div");
      const kicker = document.createElement("span");
      kicker.className = "zp-kicker";
      kicker.textContent = "\u5F97\u5206";
      const score = document.createElement("div");
      score.className = "zp-score";
      const scoreInput = document.createElement("input");
      scoreInput.type = "number";
      scoreInput.className = "zp-total";
      scoreInput.min = "0";
      scoreInput.max = String(result.maxScore || 999);
      scoreInput.step = "0.5";
      scoreInput.value = String(Math.round(result.score * 10) / 10);
      scoreInput.title = "\u53EF\u76F4\u63A5\u4FEE\u6539\u603B\u5206";
      scoreInput.setAttribute("aria-label", "\u603B\u5206");
      const unit = document.createElement("span");
      unit.textContent = `/ ${result.maxScore || "\u2014"}`;
      score.append(scoreInput, unit);
      left.append(kicker, score);

      const badges = document.createElement("div");
      badges.className = "zp-badges";
      const statusPill = document.createElement("span");
      const statusKind = result.status === "legible" ? "ok" : result.status === "partial" ? "warn" : "bad";
      statusPill.className = `zp-pill ${statusKind}`;
      statusPill.textContent = STATUS_LABEL[result.status] || "\u5DF2\u8BC4\u5206";
      badges.appendChild(statusPill);
      if (result.needsReview) {
        const reviewPill = document.createElement("span");
        reviewPill.className = "zp-pill warn";
        reviewPill.textContent = "\u9700\u590D\u6838";
        badges.appendChild(reviewPill);
      }
      head.append(left, badges);
      container.appendChild(head);

      const reason = document.createElement("p");
      reason.className = "zp-reason";
      reason.textContent = result.reason || "\u672A\u8FD4\u56DE\u8BC4\u5206\u4F9D\u636E";
      container.appendChild(reason);

      if (result.subScores.length > 0) {
        const list = document.createElement("div");
        list.className = "zp-sublist";
        result.subScores.forEach((item, index) => {
          const row = document.createElement("div");
          row.className = "zp-subrow";
          const main = document.createElement("div");
          main.className = "zp-submain";
          const label = document.createElement("span");
          label.className = "zp-sublabel";
          label.textContent = item.label;
          const why = document.createElement("span");
          why.className = "zp-subreason";
          why.textContent = item.reason || "\u2014";
          main.append(label, why);
          const wrap = document.createElement("span");
          wrap.className = "zp-subscore";
          const subInput = document.createElement("input");
          subInput.type = "number";
          subInput.className = "zp-subinput";
          subInput.min = "0";
          subInput.max = String(item.maxScore || 999);
          subInput.step = "0.5";
          subInput.value = String(Math.round(Number(item.score) * 10) / 10);
          subInput.dataset.scoreIndex = String(index);
          subInput.title = "\u53EF\u76F4\u63A5\u4FEE\u6539\u8BE5\u5C0F\u9898\u5F97\u5206";
          subInput.setAttribute("aria-label", `\u5C0F\u9898 ${item.label} \u5F97\u5206`);
          const max = document.createElement("em");
          max.textContent = `/ ${item.maxScore || "\u2014"}`;
          wrap.append(subInput, max);
          row.append(main, wrap);
          list.appendChild(row);
        });
        container.appendChild(list);
      }

      const reviews = [...result.reviewReasons];
      if (reviews.length > 0) {
        const note = document.createElement("div");
        note.className = "zp-reviews";
        note.textContent = reviews.join("\uFF1B");
        container.appendChild(note);
      }

      const meta = document.createElement("div");
      meta.className = "zp-meta";
      // 多模态直评现在只有一条链路，不再显示「链路 vlm」；模型与耗时一行，token 消耗另起一行。
      const modelLine = document.createElement("div");
      modelLine.className = "zp-metaline";
      modelLine.textContent = `\u6A21\u578B ${result.model} \xB7 \u8017\u65F6 ${(result.elapsedMs / 1e3).toFixed(1)}s`;
      meta.appendChild(modelLine);
      // 用量直接取自响应里的 usage，读取它不消耗 token。
      const usage = result.usage;
      // 命中 0 也要显示，否则用户无法区分「接口没返回」和「这次没命中」。
      if (usage && (usage.prompt || usage.completion)) {
        const usageLine = document.createElement("div");
        usageLine.className = "zp-metaline";
        usageLine.textContent = `\u8F93\u5165 ${usage.prompt}\uFF08\u524D\u7F00\u547D\u4E2D ${Number(usage.cached) || 0}\uFF09 \xB7 \u8F93\u51FA ${usage.completion}${usage.reasoning ? `\uFF08\u542B\u601D\u8003 ${usage.reasoning}\uFF09` : ""}`;
        meta.appendChild(usageLine);
      }
      container.appendChild(meta);

      if (this.cacheMiss) {
        const hint = document.createElement("button");
        hint.type = "button";
        hint.className = "zp-notice";
        hint.dataset.act = "cache-help";
        hint.innerHTML = `<span></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
        const hintText = hint.querySelector("span");
        if (hintText) hintText.textContent = `\u524D\u7F00\u7F13\u5B58\u5DF2\u8FDE\u7EED ${this.cacheMiss.streak} \u6B21\u672A\u547D\u4E2D\uFF0C\u70B9\u51FB\u67E5\u770B\u539F\u56E0`;
        container.appendChild(hint);
      }
      this.setCache(result.cacheHit ? "\u7F13\u5B58\u547D\u4E2D" : "\u65B0\u7ED3\u679C", result.cacheHit ? "ok" : "new");
      this.setStage("\u5B8C\u6210");
    }
    // 未命中解释：只用本地累计的计数与估算值，不重新发请求。
    showCacheHelp() {
      const info = this.cacheMiss;
      const overlay = this.shadow.querySelector("#zygr-cache-help");
      const body = this.shadow.querySelector("#zygr-cache-help-body");
      if (!info || !overlay || !body) return;
      const section = (title, items) => {
        const wrap = document.createElement("div");
        wrap.className = "zygr-cache-help-section";
        const heading = document.createElement("h3");
        heading.textContent = title;
        const list = document.createElement("ul");
        for (const item of items) {
          const li = document.createElement("li");
          li.textContent = item;
          list.appendChild(li);
        }
        wrap.append(heading, list);
        return wrap;
      };
      const summary = document.createElement("p");
      summary.className = "zygr-cache-help-summary";
      summary.textContent = `${info.model} 已连续 ${info.streak} 次没有命中前缀缓存。本次固定文本约 ${info.textTokens} token，输入合计 ${info.promptTokens} token（含 ${info.imageCount} 张作答图）。`;
      const impact = document.createElement("p");
      impact.className = "zygr-cache-help-impact";
      impact.textContent = "不影响阅卷结果：缓存只复用输入的预计算，模型输出与不缓存时完全一致；它只影响 token 费用和首字速度。";
      const reasons = [];
      if (Number(info.driftCount) >= 2) {
        reasons.push(`这道题的固定文本在批改过程中变了 ${info.driftCount} 次（提示词哈希不一致），缓存每次都会重建。重点查题目、小题、分值是否在不同学生页面上解析得不一致。`);
      }
      reasons.push(...(info.modelEverHit
        ? [
          "这个模型命中过前缀缓存，说明它支持；这次连续未命中，更可能是固定文本没达到门槛、前缀被改动，或缓存已过期。",
          "固定文本里混进了每份都会变的内容：时间、学生姓名/学号，或页面解析出的小题数量与文案不一致。",
          "并发太高时请求被路由到了别的实例，或者距上一份超过 TTL（多数平台 5–15 分钟）。",
          "平台没有返回 cached_tokens 字段（部分中转/兼容网关会省略），无法据此判断。"
        ]
        : [
          "该平台可能按「整条消息」缓存：同一条消息里的作答图一变，前面的文字也一起失效（火山方舟的隐式缓存实测如此）。",
          "该模型可能不支持前缀缓存，或这个视觉模型不在缓存支持列表里——同平台的文本模型支持，不等于 VL 模型支持。",
          `固定文本约 ${info.textTokens} token，没达到该模型的最小缓存长度（参考：${getPlatformCacheNote(info.platform)}）。`,
          "平台没有返回 cached_tokens 字段（部分中转/兼容网关会省略），无法据此判断。"
        ]));
      const advice = [
        info.textTokens < 1024
          ? "固定文本不足 1024 token：换 DeepSeek（约 64）或智谱（约 128）最容易命中；文本超过 4096 时 Gemini 写入免费更划算。"
          : "文本长度已经够：优先换一个明确支持该视觉模型的平台，或检查前缀是否被动态内容打断。",
        "如果换了平台仍是 0 命中，说明它按整条消息缓存，图片一变文字就失效——别再为它调提示词，直接换平台。",
        "同一道题连续批完再换题，别在题与题之间来回跳。",
        "设置 → 限速与超时，把 RPM 降到 15 左右；并发越高，越容易被路由到没有缓存的实例。",
        "批量批改期间固定输出档位：切档会改写提示词，这道题的缓存要重新建立。"
      ];
      body.replaceChildren(impact, summary, section("可能的原因", reasons), section("可以怎么处理", advice));
      const note = document.createElement("p");
      note.className = "zygr-hint";
      note.textContent = `参考门槛：${getPlatformCacheNote(info.platform)}。以上是经验判断，最终以平台返回的 cached_tokens 为准。`;
      body.appendChild(note);
      overlay.hidden = false;
    }
    hideCacheHelp() {
      const overlay = this.shadow.querySelector("#zygr-cache-help");
      if (overlay) overlay.hidden = true;
    }
    // 换卷/定位后把结果区清空：旧分数留在面板上会诱导老师提交到另一份卷。
    clearResult() {
      const container = this.q("#zygr-result");
      container.replaceChildren();
      this.cacheMiss = null;
      this.hideCacheHelp();
      const empty = document.createElement("div");
      empty.className = "zp-empty";
      empty.innerHTML = `<span class="zp-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.7 4.4L18 9l-4.3 1.6L12 15l-1.7-4.4L6 9l4.3-1.6z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/></svg></span><strong>\u6279\u6539\u7ED3\u679C\u5C06\u663E\u793A\u5728\u8FD9\u91CC</strong><p>\u8BFB\u53D6\u4F5C\u7B54\u56FE\u540E\uFF0C\u6309\u5F53\u524D\u9898\u76EE\u7684\u53C2\u8003\u7B54\u6848\u4E0E\u8BC4\u5206\u6807\u51C6\u76F4\u63A5\u8BC4\u5206\u3002</p>`;
      container.appendChild(empty);
      this.setStage("\u5C31\u7EEA");
    }
    getScoreEdits() {
      const total = this.shadow.querySelector(".zp-total");
      const subInputs = [...this.shadow.querySelectorAll(".zp-subinput")];
      const subScores = subInputs.map((input) => Number(input.value));
      return {
        total: total && total.value.trim() !== "" ? Number(total.value) : null,
        subScores: subInputs.length ? subScores : null
      };
    }
    toast(message) {
      const element = this.q("#zygr-toast");
      element.textContent = message;
      element.hidden = false;
      window.clearTimeout(this.toastTimer);
      this.toastTimer = window.setTimeout(() => {
        element.hidden = true;
      }, 2400);
    }
  };
