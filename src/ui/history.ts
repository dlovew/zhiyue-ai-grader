  // src/ui/history.ts
  // 能否在阅卷页定位：必须有学号（旧记录没存学号就没法在记录列表里对上号）。
  function canJumpRecord(entry) {
    const identity = entry?.question?.identity;
    return Boolean(identity && String(identity.userCode || "").trim());
  }
  // 复核状态文案：供详情展示，导出用同一套口径。
  function reviewText(entry) {
    const confirmed = entry.confirmedScore === void 0 || entry.confirmedScore === null ? "" : `\uFF08\u786E\u8BA4 ${entry.confirmedScore} \u5206\uFF09`;
    const note = entry.reviewNote ? ` \xB7 ${entry.reviewNote}` : "";
    return entry.reviewedAt ? `\u5DF2\u590D\u6838${confirmed}${note}` : "\u672A\u590D\u6838";
  }
  // 历史里可能有坏记录（早期版本写进过 result: null）：补齐成一个可渲染的占位，
  // 否则 render 里读 entry.result.score 会直接抛错，整个面板打不开。
  function normalizeHistoryEntries(entries) {
    return (Array.isArray(entries) ? entries : []).map((entry) => {
      if (!entry || !entry.question) return null;
      if (entry.result && typeof entry.result === "object") return entry;
      return {
        ...entry,
        result: {
          status: "unknown",
          score: 0,
          maxScore: Number(entry.question.maxScore) || 0,
          subScores: [],
          reason: "\u8FD9\u6761\u8BB0\u5F55\u7684\u5206\u6570\u4E22\u5931\u4E86\uFF0C\u5EFA\u8BAE\u91CD\u65B0\u6279\u6539",
          needsReview: true,
          reviewReasons: ["\u5206\u6570\u4E22\u5931"],
          cacheHit: false,
          elapsedMs: 0,
          usage: null,
          pipeline: "-",
          model: "-"
        }
      };
    }).filter(Boolean);
  }
  var HistoryPanel = class {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.entries = [];
      this.selectedId = "";
      this.host = document.createElement("div");
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      guardEnter(this.shadow);
      this.bind();
    }
    markup() {
      return `<div class="zygr-overlay" hidden><div class="zygr-dialog zygr-wide">
      <div class="zygr-dialog-head"><h2>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u5386\u53F2\u8BB0\u5F55</h2><button class="zygr-icon" data-act="close" aria-label="\u5173\u95ED">\xD7</button></div>
      <div class="zygr-dialog-body">
        <div class="zygr-row">
          <select data-filter="review" aria-label="\u590D\u6838\u7B5B\u9009"><option value="">\u5168\u90E8\u72B6\u6001</option><option value="review">\u9700\u590D\u6838</option><option value="normal">\u6B63\u5E38</option></select>
          <input data-filter="keyword" type="search" placeholder="\u641C\u7D22\u9898\u53F7\u6216\u4F9D\u636E" aria-label="\u641C\u7D22">
        </div>
        <div class="zygr-summary" data-summary></div>
        <div class="zygr-history-grid">
          <div class="zygr-history-list"><div class="zygr-list" data-list></div></div>
          <div class="zygr-card zygr-history-detail" data-detail><div class="zygr-empty">\u9009\u62E9\u4E00\u6761\u8BB0\u5F55\u67E5\u770B\u8BE6\u60C5</div></div>
        </div>
      </div>
      <div class="zygr-dialog-foot">
        <button class="zygr-btn zygr-ghost" data-act="clear">\u6E05\u7A7A\u5386\u53F2</button>
        <button class="zygr-btn" data-act="csv">\u5BFC\u51FA CSV</button>
        <button class="zygr-btn" data-act="html">\u5BFC\u51FA HTML</button>
        <button class="zygr-btn zygr-primary" data-act="next-review">\u4E0B\u4E00\u6761\u9700\u590D\u6838</button>
        <button class="zygr-btn zygr-ghost" data-act="close">\u5173\u95ED</button>
      </div>
    </div></div>`;
    }
    q(selector) {
      const element = this.shadow.querySelector(selector);
      if (!element) throw new Error(`\u5386\u53F2\u754C\u9762\u5143\u7D20\u7F3A\u5931\uFF1A${selector}`);
      return element;
    }
    bind() {
      this.shadow.addEventListener("click", (event) => {
        const target = event.target;
        const action = target.closest("[data-act]")?.dataset.act;
        if (action === "close") this.hide();
        else if (action === "clear") this.callbacks.onClear();
        else if (action === "csv") this.callbacks.onExport("csv");
        else if (action === "html") this.callbacks.onExport("html");
        if (action === "next-review") {
          this.jumpNextReview();
          return;
        }
        if (action === "jump") {
          const row = target.closest("[data-id]");
          const entry = this.entries.find((item2) => item2.id === row?.dataset.id);
          if (entry) this.callbacks.onJump?.(entry);
          return;
        }
        const item = target.closest("[data-id]");
        if (item?.dataset.id) {
          this.selectedId = item.dataset.id;
          this.render();
          this.q("[data-detail]").scrollTop = 0;
        }
      });
      this.shadow.addEventListener("input", () => this.render());
      this.shadow.addEventListener("change", () => this.render());
    }
    filtered() {
      const review = this.q("[data-filter='review']").value;
      const keyword = this.q("[data-filter='keyword']").value.trim().toLowerCase();
      return this.entries.filter((entry) => {
        if (review === "review" && !entry.result.needsReview) return false;
        if (review === "normal" && entry.result.needsReview) return false;
        if (keyword && !`${entry.question.questionId} ${entry.result.reason}`.toLowerCase().includes(keyword)) return false;
        return true;
      });
    }
    render() {
      const list = this.q("[data-list]");
      list.replaceChildren();
      const entries = this.filtered();
      // 汇总只统计当前筛选结果，方便核对某个范围内的输入/输出与命中情况。
      this.q("[data-summary]").textContent = summaryText(entries);
      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "zygr-empty";
        empty.textContent = "\u6682\u65E0\u7B26\u5408\u6761\u4EF6\u7684\u8BB0\u5F55";
        list.appendChild(empty);
      }
      for (const entry of entries) {
        const item = document.createElement("div");
        item.className = "zygr-item";
        if (entry.id === this.selectedId) item.classList.add("zygr-selected");
        item.dataset.id = entry.id;
        const text = document.createElement("div");
        text.className = "zygr-item-main";
        text.textContent = `${new Date(entry.createdAt).toLocaleString("zh-CN")} \xB7 \u9898\u53F7 ${entry.question.questionId} \xB7 ${entry.result.score}/${entry.result.maxScore} \xB7 ${entry.result.pipeline}${entry.result.needsReview ? " \xB7 \u9700\u590D\u6838" : ""}`;
        item.appendChild(text);
        // 单条记录上就能直接跳回阅卷页，不必先展开详情。
        if (canJumpRecord(entry)) {
          const jump = document.createElement("button");
          jump.className = "zygr-jump";
          jump.dataset.act = "jump";
          jump.textContent = "\u5B9A\u4F4D";
          jump.title = "\u5728\u9605\u5377\u9875\u56DE\u8BC4\u8FD9\u4E00\u4EFD\u5377\u5B50";
          item.appendChild(jump);
        }
        list.appendChild(item);
      }
      this.renderDetail();
    }
    renderDetail() {
      const container = this.q("[data-detail]");
      container.replaceChildren();
      const entry = this.entries.find((item) => item.id === this.selectedId);
      if (!entry) {
        const empty = document.createElement("div");
        empty.className = "zygr-empty";
        empty.textContent = "\u9009\u62E9\u4E00\u6761\u8BB0\u5F55\u67E5\u770B\u8BE6\u60C5";
        container.appendChild(empty);
        return;
      }
      const detail = document.createElement("div");
      detail.className = "zygr-detail";
      const usage = entryUsage(entry);
      const lines = [
        `\u9898\u53F7\uFF1A${entry.question.questionId}`,
        `\u94FE\u8DEF / \u6A21\u578B\uFF1A${entry.result.pipeline} / ${entry.result.model}`,
        `\u7ED3\u679C\uFF1A${entry.result.score} / ${entry.result.maxScore}\uFF08${entry.result.status}\uFF09`,
        `\u7528\u91CF\uFF1A\u8F93\u5165 ${usage.prompt}\uFF08\u524D\u7F00\u547D\u4E2D ${usage.cached}\uFF09 \xB7 \u8F93\u51FA ${usage.completion}${usage.reasoning ? `\uFF08\u542B\u601D\u8003 ${usage.reasoning}\uFF09` : ""}`,
        `\u7F13\u5B58 / \u8017\u65F6\uFF1A${entryHitText(entry)} / ${entryElapsed(entry)}s`,
        `\u4F9D\u636E\uFF1A${entry.result.reason || "\u65E0"}`,
        `\u590D\u6838\uFF1A${entry.result.reviewReasons.join("\uFF1B") || "\u65E0"}`,
        `\u5C0F\u9898\uFF1A${entry.result.subScores.map((item) => `${item.label} ${item.score}/${item.maxScore}`).join("\uFF1B") || "\u65E0"}`,
        `\u5B9A\u4F4D\uFF1A${entry.question.identity?.userCode ? `\u5B66\u53F7 ${entry.question.identity.userCode} \xB7 \u8BD5\u5377 ${entry.question.identity.markingPaperId ? "\u5DF2\u8BB0\u5F55" : "\u672A\u8BB0\u5F55"}` : "\u4E0D\u652F\u6301\uFF08\u65E7\u8BB0\u5F55\u6CA1\u5B58\u5B66\u53F7\uFF09"}`,
        `\u590D\u6838\u7ED3\u679C\uFF1A${reviewText(entry)}`
      ];
      detail.textContent = lines.join("\n");
      container.appendChild(detail);
      // 复核留痕：备注与确认分都写回历史，导出时一并带出。
      const actions = document.createElement("div");
      actions.className = "zygr-row";
      const reviewButton = document.createElement("button");
      reviewButton.className = "zygr-btn zygr-ghost";
      reviewButton.textContent = entry.reviewedAt ? "\u4FEE\u6539\u590D\u6838\u5907\u6CE8" : "\u6807\u8BB0\u5DF2\u590D\u6838";
      reviewButton.addEventListener("click", () => {
        const note = window.prompt("\u590D\u6838\u5907\u6CE8\uFF08\u53EF\u7559\u7A7A\uFF09", entry.reviewNote || "");
        if (note === null) return;
        this.callbacks.onReview?.(entry.id, { reviewedAt: Date.now(), reviewNote: note.trim() });
      });
      const scoreButton = document.createElement("button");
      scoreButton.className = "zygr-btn zygr-ghost";
      scoreButton.textContent = "\u8BB0\u5F55\u786E\u8BA4\u5206";
      scoreButton.addEventListener("click", () => {
        const raw = window.prompt("\u786E\u8BA4\u5206\u6570", String(entry.confirmedScore ?? entry.result.score));
        if (raw === null) return;
        const value = Number(raw);
        if (!Number.isFinite(value)) return;
        const max = Number(entry.result.maxScore) || 999;
        this.callbacks.onReview?.(entry.id, { confirmedScore: Math.min(Math.max(value, 0), max) });
      });
      const jumpButton = document.createElement("button");
      jumpButton.className = "zygr-btn zygr-primary";
      jumpButton.textContent = "\u5B9A\u4F4D\u5230\u8BE5\u5377";
      jumpButton.disabled = !canJumpRecord(entry);
      jumpButton.title = canJumpRecord(entry) ? "\u5728\u9605\u5377\u9875\u56DE\u8BC4\u8FD9\u4E00\u4EFD\u5377\u5B50" : "\u8BE5\u8BB0\u5F55\u6CA1\u6709\u5B66\u53F7\uFF0C\u65E0\u6CD5\u5B9A\u4F4D";
      jumpButton.addEventListener("click", () => this.callbacks.onJump?.(entry));
      actions.append(jumpButton, reviewButton, scoreButton);
      container.appendChild(actions);
    }
    // 复核队列：把「需复核且还没标记」的记录按当前筛选排成一条队，一条条定位过去。
    nextReviewEntry() {
      const pending = this.filtered().filter((entry) => entry.result.needsReview && !entry.reviewedAt && canJumpRecord(entry));
      if (pending.length === 0) return null;
      const index = pending.findIndex((entry) => entry.id === this.selectedId);
      return pending[index + 1] || pending[0];
    }
    jumpNextReview() {
      const next = this.nextReviewEntry();
      if (!next) {
        this.callbacks.onEmptyQueue?.();
        return;
      }
      this.selectedId = next.id;
      this.render();
      // 第二个参数标记「来自复核队列」：主流程据此在提交后自动跳下一条。
      this.callbacks.onJump?.(next, true);
    }
    mount() {
      if (!this.host.isConnected) document.body.appendChild(this.host);
    }
    show(entries) {
      this.entries = normalizeHistoryEntries(entries);
      this.mount();
      this.q(".zygr-overlay").hidden = false;
      this.render();
    }
    hide() {
      this.q(".zygr-overlay").hidden = true;
    }
    refresh(entries) {
      this.entries = normalizeHistoryEntries(entries);
      if (!this.q(".zygr-overlay").hidden) this.render();
    }
  };

