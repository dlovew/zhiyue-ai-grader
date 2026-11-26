  // src/ui/history.ts
  var HistoryPanel = class {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.entries = [];
      this.selectedId = "";
      this.host = document.createElement("div");
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
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
        <button class="zygr-btn zygr-primary" data-act="close">\u5173\u95ED</button>
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
        item.textContent = `${new Date(entry.createdAt).toLocaleString("zh-CN")} \xB7 \u9898\u53F7 ${entry.question.questionId} \xB7 ${entry.result.score}/${entry.result.maxScore} \xB7 ${entry.result.pipeline}${entry.result.needsReview ? " \xB7 \u9700\u590D\u6838" : ""}`;
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
        `\u7528\u91CF\uFF1A\u8F93\u5165 ${usage.prompt}${usage.cached ? `\uFF08\u524D\u7F00\u547D\u4E2D ${usage.cached}\uFF09` : ""} \xB7 \u8F93\u51FA ${usage.completion}${usage.reasoning ? `\uFF08\u542B\u601D\u8003 ${usage.reasoning}\uFF09` : ""}`,
        `\u7F13\u5B58 / \u8017\u65F6\uFF1A${entryHitText(entry)} / ${entryElapsed(entry)}s`,
        `\u4F9D\u636E\uFF1A${entry.result.reason || "\u65E0"}`,
        `\u590D\u6838\uFF1A${entry.result.reviewReasons.join("\uFF1B") || "\u65E0"}`,
        `\u5C0F\u9898\uFF1A${entry.result.subScores.map((item) => `${item.label} ${item.score}/${item.maxScore}`).join("\uFF1B") || "\u65E0"}`
      ];
      detail.textContent = lines.join("\n");
      container.appendChild(detail);
    }
    mount() {
      if (!this.host.isConnected) document.body.appendChild(this.host);
    }
    show(entries) {
      this.entries = entries;
      this.mount();
      this.q(".zygr-overlay").hidden = false;
      this.render();
    }
    hide() {
      this.q(".zygr-overlay").hidden = true;
    }
    refresh(entries) {
      this.entries = entries;
      if (!this.q(".zygr-overlay").hidden) this.render();
    }
  };

