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
      this.host = document.createElement("div");
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      guardEnter(this.shadow);
      this.panel = this.q(".zygr-panel");
      const version = this.shadow.querySelector("#zygr-version");
      if (version) version.textContent = `v${typeof ZYGR_VERSION === "string" ? ZYGR_VERSION : "dev"}`;
      const skipConfirm = this.shadow.querySelector("[data-opt='skip-submit-confirm']");
      if (skipConfirm) skipConfirm.checked = readJson(SKIP_CONFIRM_KEY, false) === true;
      this.setContinuousLimit(20);
      this.setOutputMode("standard");
      this.bind();
    }
    markup() {
      return `<div class="zygr-panel">
      <header class="zygr-head">
        <div class="zygr-brand">
          <span class="zygr-logo">\u667A</span>
          <div>
            <div class="zygr-title-row">
              <strong>\u667A\u9605\u6279\u6539\u52A9\u624B</strong>
              <span class="zygr-version" id="zygr-version" title="\u5F53\u524D\u811A\u672C\u7248\u672C">v--</span>
            </div>
            <small id="zygr-subtitle">\u7B49\u5F85\u8BFB\u53D6\u9898\u76EE</small>
          </div>
        </div>
        <div class="zygr-head-actions">
          <button class="zygr-icon" data-act="collapse" title="\u6298\u53E0" aria-label="\u6298\u53E0">\u2014</button>
          <button class="zygr-icon" data-act="close" title="\u5173\u95ED" aria-label="\u5173\u95ED">\xD7</button>
        </div>
      </header>
      <div class="zygr-body">
        <div class="zygr-statusbar"><span id="zygr-stage">\u5C31\u7EEA</span><span id="zygr-progress" hidden></span><span class="zygr-chip" id="zygr-cache">\u5F85\u914D\u7F6E</span></div>
        <div class="zygr-progress"><i id="zygr-bar"></i></div>
        <section class="zygr-card"><div class="zygr-meta" id="zygr-meta">\u5C1A\u672A\u68C0\u6D4B\u5230\u9605\u5377\u9875\u9762</div><div class="zygr-thumbs" id="zygr-thumbs"></div></section>
        <section class="zygr-card" id="zygr-result"><div class="zygr-reason">\u6279\u6539\u7ED3\u679C\u5C06\u663E\u793A\u5728\u8FD9\u91CC</div></section>
        <div class="zygr-error" id="zygr-error" hidden></div>
      </div>
      <footer class="zygr-actions">
        <button class="zygr-btn zygr-primary" data-act="grade">\u5F00\u59CB\u6279\u6539</button>
        <div class="zygr-continuous-cell">
          <button class="zygr-btn" data-act="continuous">\u8FDE\u7EED\u6279\u9605</button>
          <label class="zygr-limit" title="${CONTINUOUS_LIMIT_HINT}">
            <span>\u6700\u591A</span>
            <input type="number" data-opt="continuous-limit" min="1" max="${CONTINUOUS_LIMIT_MAX}" step="1" value="20" aria-label="\u8FDE\u7EED\u6279\u9605\u6700\u591A\u6279\u6539\u4EFD\u6570" title="${CONTINUOUS_LIMIT_HINT}">
            <span>\u4EFD</span>
          </label>
        </div>
        <div class="zygr-submit-cell">
          <button class="zygr-btn" data-act="submit">\u63D0\u4EA4\u7ED3\u679C</button>
          <label class="zygr-mini-check"><input type="checkbox" data-opt="skip-submit-confirm"> \u4E00\u6B21\u63D0\u4EA4\uFF08\u514D\u786E\u8BA4\uFF09</label>
        </div>
        <label class="zygr-output" title="${OUTPUT_MODE_HINT}">
          <span>\u8F93\u51FA</span>
          <select data-opt="output-mode" aria-label="\u8F93\u51FA\u6863\u4F4D" title="${OUTPUT_MODE_HINT}">
            ${Object.keys(OUTPUT_MODES).map((key) => `<option value="${key}" title="${OUTPUT_MODES[key].label}">${OUTPUT_MODE_SHORT[key] || key}</option>`).join("")}
          </select>
        </label>
        <button class="zygr-btn zygr-ghost" data-act="history">\u5386\u53F2</button>
        <button class="zygr-btn zygr-ghost" data-act="settings">\u8BBE\u7F6E</button>
      </footer>
      <div class="zygr-toast" id="zygr-toast" hidden></div>
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
        } else if (target?.matches?.("[data-opt='output-mode']")) {
          this.setOutputMode(target.value);
          this.callbacks.onOutputModeChange?.(normalizeOutputMode(target.value));
        }
      });
      this.shadow.addEventListener("click", (event) => {
        const button = event.target.closest("[data-act]");
        if (!button) return;
        const action = button.dataset.act;
        if (action === "collapse") {
          this.panel.classList.toggle("zygr-collapsed");
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
        }
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
    }
    setSubtitle(value) {
      this.setText("zygr-subtitle", value);
    }
    setQuestion(question) {
      this.renderThumbs(question?.images ?? []);
      if (!question) {
        this.setText("zygr-meta", "\u5C1A\u672A\u68C0\u6D4B\u5230\u9605\u5377\u9875\u9762");
        return;
      }
      const subs = question.subQuestions.length > 0 ? ` \xB7 ${question.subQuestions.length} \u4E2A\u5C0F\u9898` : "";
      this.setText("zygr-meta", `\u9898\u53F7 ${question.questionId}${subs} \xB7 \u6EE1\u5206 ${question.maxScore || "\u672A\u6307\u5B9A"} \xB7 \u4F5C\u7B54\u56FE\u7247 ${question.images.length} \u5F20`);
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
    }
    setProgress(text) {
      const element = this.q("#zygr-progress");
      element.textContent = text || "";
      element.hidden = !text;
    }
    setCache(label, kind = "idle") {
      const chip = this.q("#zygr-cache");
      chip.textContent = label;
      chip.className = `zygr-chip${kind === "ok" ? " zygr-ok" : kind === "warn" ? " zygr-warn" : ""}`;
    }
    setBusy(busy, label = "\u5904\u7406\u4E2D") {
      this.shadow.querySelectorAll('.zygr-actions .zygr-btn:not([data-act="continuous"])').forEach((button) => {
        button.disabled = busy;
      });
      // 批改中锁定档位：运行中的这一份已经按旧档位发出去了，避免误以为改动能影响它。
      const outputMode = this.shadow.querySelector("[data-opt='output-mode']");
      if (outputMode) outputMode.disabled = busy;
      if (busy) this.setStage(label);
    }
    setAutoMode(active) {
      const button = this.q('[data-act="continuous"]');
      button.textContent = active ? "\u505C\u6B62\u8FDE\u7EED\u6279\u9605" : "\u8FDE\u7EED\u6279\u9605";
      button.classList.toggle("zygr-running", active);
      // 运行中改上限会让人误以为当前这一轮会跟着变；锁定后提示下一次启动才生效。
      const limit = this.shadow.querySelector("[data-opt='continuous-limit']");
      if (limit) limit.disabled = active;
    }
    setContinuousLimit(value) {
      const limit = this.shadow.querySelector("[data-opt='continuous-limit']");
      if (limit) limit.value = String(normalizeContinuousLimit(value));
    }
    setOutputMode(value) {
      const select = this.shadow.querySelector("[data-opt='output-mode']");
      if (select) select.value = normalizeOutputMode(value);
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
      const row = document.createElement("div");
      row.className = "zygr-score-row";
      const score = document.createElement("div");
      score.className = "zygr-score zygr-score-editable";
      const scoreInput = document.createElement("input");
      scoreInput.type = "number";
      scoreInput.className = "zygr-score-input";
      scoreInput.min = "0";
      scoreInput.max = String(result.maxScore || 999);
      scoreInput.step = "0.5";
      scoreInput.value = String(Math.round(result.score * 10) / 10);
      scoreInput.title = "\u53EF\u76F4\u63A5\u4FEE\u6539\u603B\u5206";
      const unit = document.createElement("small");
      unit.textContent = ` / ${result.maxScore || "\u2014"} \u5206`;
      score.append(scoreInput, unit);
      const badge = document.createElement("span");
      badge.className = `zygr-badge${result.needsReview ? " zygr-risk" : ""}`;
      badge.textContent = `${STATUS_LABEL[result.status]}${result.needsReview ? " \xB7 \u9700\u590D\u6838" : ""}`;
      row.append(score, badge);
      container.appendChild(row);
      const reason = document.createElement("div");
      reason.className = "zygr-reason";
      reason.textContent = result.reason || "\u672A\u8FD4\u56DE\u8BC4\u5206\u4F9D\u636E";
      container.appendChild(reason);
      if (result.subScores.length > 0) {
        const table = document.createElement("table");
        table.className = "zygr-table";
        const head = document.createElement("thead");
        head.innerHTML = "<tr><th>\u5C0F\u9898</th><th>\u5F97\u5206</th><th>\u4F9D\u636E</th></tr>";
        const body = document.createElement("tbody");
        result.subScores.forEach((item, index) => {
          const tr = document.createElement("tr");
          const labelTd = document.createElement("td");
          labelTd.textContent = `${item.label}/${item.maxScore}`;
          const scoreTd = document.createElement("td");
          const subInput = document.createElement("input");
          subInput.type = "number";
          subInput.className = "zygr-score-input zygr-subscore-input";
          subInput.min = "0";
          subInput.max = String(item.maxScore || 999);
          subInput.step = "0.5";
          subInput.value = String(Math.round(Number(item.score) * 10) / 10);
          subInput.dataset.scoreIndex = String(index);
          subInput.title = "\u53EF\u76F4\u63A5\u4FEE\u6539\u8BE5\u5C0F\u9898\u5F97\u5206";
          scoreTd.appendChild(subInput);
          const reasonTd = document.createElement("td");
          reasonTd.textContent = item.reason || "\u2014";
          tr.append(labelTd, scoreTd, reasonTd);
          body.appendChild(tr);
        });
        table.append(head, body);
        container.appendChild(table);
      }
      const reviews = [...result.reviewReasons];
      if (reviews.length > 0) {
        const note = document.createElement("div");
        note.className = "zygr-reviews";
        note.textContent = reviews.join("\uFF1B");
        container.appendChild(note);
      }
      const meta = document.createElement("div");
      meta.className = "zygr-reason";
      // 用量直接取自响应里的 usage，读取它不消耗 token。
      const usage = result.usage;
      // 命中 0 也要显示，否则用户无法区分「接口没返回」和「这次没命中」。
      const usageText = usage && (usage.prompt || usage.completion)
        ? ` \xB7 \u8F93\u5165 ${usage.prompt}\uFF08\u524D\u7F00\u547D\u4E2D ${Number(usage.cached) || 0}\uFF09 \xB7 \u8F93\u51FA ${usage.completion}${usage.reasoning ? `\uFF08\u542B\u601D\u8003 ${usage.reasoning}\uFF09` : ""}`
        : "";
      meta.textContent = `\u94FE\u8DEF ${result.pipeline} \xB7 \u6A21\u578B ${result.model} \xB7 \u8017\u65F6 ${(result.elapsedMs / 1e3).toFixed(1)}s${usageText}`;
      container.appendChild(meta);
      this.setCache(result.cacheHit ? "\u7F13\u5B58\u547D\u4E2D" : "\u65B0\u7ED3\u679C", result.cacheHit ? "ok" : result.needsReview ? "warn" : "idle");
      this.setStage("\u5B8C\u6210");
    }
    // 换卷/定位后把结果区清空：旧分数留在面板上会诱导老师提交到另一份卷。
    clearResult() {
      const container = this.q("#zygr-result");
      container.replaceChildren();
      const note = document.createElement("div");
      note.className = "zygr-reason";
      note.textContent = "\u6279\u6539\u7ED3\u679C\u5C06\u663E\u793A\u5728\u8FD9\u91CC";
      container.appendChild(note);
      this.setStage("\u5C31\u7EEA");
    }
    getScoreEdits() {
      const total = this.shadow.querySelector(".zygr-score-input[data-score-index=''], .zygr-score-editable .zygr-score-input");
      const subInputs = [...this.shadow.querySelectorAll(".zygr-subscore-input")];
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

