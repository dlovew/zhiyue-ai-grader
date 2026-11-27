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
  // 列表列宽有限，日期压到「月-日 时:分」；详情里仍保留完整语义。
  function compactTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "\u2014";
    const pad = (number) => String(number).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
      this.reviewFilter = "all";
      this.host = document.createElement("div");
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      guardEnter(this.shadow);
      this.bind();
    }
    markup() {
      return `<div class="zygr-overlay" hidden>
      <div class="zygr-dialog" role="dialog" aria-modal="true" aria-labelledby="zygr-history-title">
        <header class="zg-head">
          <div>
            <h2 id="zygr-history-title">\u5386\u53F2\u8BB0\u5F55</h2>
            <p id="zygr-history-sub">\u5171 0 \u6761</p>
          </div>
          <button class="zp-iconbtn" data-act="close" aria-label="\u5173\u95ED">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </header>
        <div class="zh-toolbar">
          <div class="zg-seg" data-seg="history" role="group" aria-label="\u590D\u6838\u7B5B\u9009">
            <button data-review="all" aria-pressed="true">\u5168\u90E8</button>
            <button data-review="review" aria-pressed="false">\u9700\u590D\u6838</button>
            <button data-review="normal" aria-pressed="false">\u6B63\u5E38</button>
          </div>
          <div class="zh-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
            <input data-filter="keyword" type="search" placeholder="\u641C\u7D22\u9898\u53F7\u6216\u8BC4\u5206\u4F9D\u636E" aria-label="\u641C\u7D22\u5386\u53F2">
          </div>
        </div>
        <div class="zh-summary" data-summary></div>
        <div class="zh-body">
          <div class="zh-list" data-list></div>
          <div class="zh-detail" data-detail><div class="zh-empty">\u9009\u62E9\u4E00\u6761\u8BB0\u5F55\u67E5\u770B\u8BE6\u60C5</div></div>
        </div>
        <footer class="zg-foot">
          <div class="zg-foot-left">
            <button class="zg-btn small danger" data-act="clear">\u6E05\u7A7A\u5386\u53F2</button>
          </div>
          <div class="zg-foot-right">
            <button class="zg-btn small" data-act="csv">\u5BFC\u51FA CSV</button>
            <button class="zg-btn small" data-act="html">\u5BFC\u51FA HTML</button>
            <button class="zg-btn small primary" data-act="next-review">\u4E0B\u4E00\u6761\u9700\u590D\u6838</button>
            <button class="zg-btn small ghost" data-act="close">\u5173\u95ED</button>
          </div>
        </footer>
      </div>
    </div>`;
    }
    q(selector) {
      const element = this.shadow.querySelector(selector);
      if (!element) throw new Error(`\u5386\u53F2\u754C\u9762\u5143\u7D20\u7F3A\u5931\uFF1A${selector}`);
      return element;
    }
    bind() {
      this.shadow.addEventListener("click", (event) => {
        const target = event.target;
        const reviewButton = target.closest("[data-review]");
        if (reviewButton) {
          this.reviewFilter = reviewButton.dataset.review || "all";
          this.shadow.querySelectorAll("[data-review]").forEach((item) => {
            item.setAttribute("aria-pressed", String(item === reviewButton));
          });
          this.render();
          return;
        }
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
        }
      });
      this.shadow.addEventListener("input", () => this.render());
      this.shadow.addEventListener("change", () => this.render());
    }
    filtered() {
      const keyword = this.q("[data-filter='keyword']").value.trim().toLowerCase();
      return this.entries.filter((entry) => {
        if (this.reviewFilter === "review" && !entry.result.needsReview) return false;
        if (this.reviewFilter === "normal" && entry.result.needsReview) return false;
        if (keyword && !`${entry.question.questionId} ${entry.result.reason}`.toLowerCase().includes(keyword)) return false;
        return true;
      });
    }
    render() {
      const list = this.q("[data-list]");
      list.replaceChildren();
      const entries = this.filtered();
      const reviewCount = this.entries.filter((entry) => entry.result.needsReview).length;
      this.q("#zygr-history-sub").textContent = `\u5171 ${this.entries.length} \u6761 \xB7 ${reviewCount} \u6761\u9700\u590D\u6838`;
      // 汇总只统计当前筛选结果，方便核对某个范围内的输入/输出与命中情况。
      this.q("[data-summary]").textContent = summaryText(entries);
      if (!entries.some((entry) => entry.id === this.selectedId)) {
        this.selectedId = entries.length ? entries[0].id : "";
      }
      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "zh-empty";
        empty.textContent = "\u6682\u65E0\u7B26\u5408\u6761\u4EF6\u7684\u8BB0\u5F55";
        list.appendChild(empty);
      }
      for (const entry of entries) {
        const item = document.createElement("div");
        item.className = "zh-row";
        if (entry.result.needsReview) item.classList.add("needs");
        if (entry.id === this.selectedId) item.classList.add("is-selected");
        item.dataset.id = entry.id;

        const select = document.createElement("button");
        select.type = "button";
        select.className = "zh-select";
        select.setAttribute("aria-pressed", String(entry.id === this.selectedId));
        select.setAttribute("aria-label", `\u9898\u53F7 ${entry.question.questionId}\uFF0C${entry.result.score} \u5206\uFF0C${entry.result.needsReview ? "\u9700\u590D\u6838" : "\u5DF2\u6B63\u5E38"}`);

        const score = document.createElement("span");
        score.className = "zh-score";
        score.textContent = String(entry.result.score);

        const main = document.createElement("span");
        main.className = "zh-main";
        const line1 = document.createElement("span");
        line1.className = "zh-l1";
        line1.textContent = `\u9898\u53F7 ${entry.question.questionId}`;
        const line2 = document.createElement("span");
        line2.className = "zh-l2";
        const reviewed = entry.reviewedAt ? " \xB7 \u5DF2\u590D\u6838" : "";
        line2.textContent = `${compactTime(entry.createdAt)} \xB7 ${entry.result.score}/${entry.result.maxScore}${entry.result.needsReview ? " \xB7 \u9700\u590D\u6838" : ""}${reviewed}`;
        main.append(line1, line2);
        select.append(score, main);
        item.appendChild(select);

        // 单条记录上就能直接跳回阅卷页，不必先展开详情。
        if (canJumpRecord(entry)) {
          const jump = document.createElement("button");
          jump.type = "button";
          jump.className = "zh-jump";
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
        empty.className = "zh-empty";
        empty.textContent = "\u9009\u62E9\u4E00\u6761\u8BB0\u5F55\u67E5\u770B\u8BE6\u60C5";
        container.appendChild(empty);
        return;
      }
      const usage = entryUsage(entry);
      const identity = entry.question.identity || {};
      const hitText = `${entryHitText(entry)} / ${entryElapsed(entry)}s`;
      const usageText = `\u8F93\u5165 ${usage.prompt}\uFF08\u524D\u7F00\u547D\u4E2D ${usage.cached}\uFF09 \xB7 \u8F93\u51FA ${usage.completion}${usage.reasoning ? `\uFF08\u542B\u601D\u8003 ${usage.reasoning}\uFF09` : ""}`;
      const locationText = identity.userCode
        ? `\u5B66\u53F7 ${escapeHtml(identity.userCode)} \xB7 \u8BD5\u5377 ${identity.markingPaperId ? "\u5DF2\u8BB0\u5F55" : "\u672A\u8BB0\u5F55"}`
        : "\u4E0D\u652F\u6301\uFF08\u65E7\u8BB0\u5F55\u6CA1\u5B58\u5B66\u53F7\uFF09";
      const subRows = (entry.result.subScores || []).map((item) => `
        <div class="zp-subrow">
          <div class="zp-submain"><span class="zp-sublabel">${escapeHtml(item.label)}</span><span class="zp-subreason">${escapeHtml(item.reason || "\u2014")}</span></div>
          <span class="zp-subscore"><span class="zp-pill">${escapeHtml(item.score)} / ${escapeHtml(item.maxScore)}</span></span>
        </div>`).join("");
      container.innerHTML = `
        <div class="zh-detailhead">
          <div>
            <span class="zp-kicker">\u9898\u53F7 ${escapeHtml(entry.question.questionId)}</span>
            <div class="zh-bigscore">${escapeHtml(entry.result.score)}<span>/ ${escapeHtml(entry.result.maxScore)} \u5206</span></div>
          </div>
          ${entry.result.needsReview ? '<span class="zp-pill warn">\u9700\u590D\u6838</span>' : '<span class="zp-pill ok">\u6B63\u5E38</span>'}
        </div>
        <p class="zp-reason">${escapeHtml(entry.result.reason || "\u65E0")}</p>
        <dl class="zh-stats">
          <div class="zh-statrow"><dt>\u6A21\u578B</dt><dd>${escapeHtml(entry.result.model)}</dd></div>
          <div class="zh-statrow"><dt>\u7F13\u5B58 / \u8017\u65F6</dt><dd>${escapeHtml(hitText)}</dd></div>
          <div class="zh-statrow"><dt>\u7528\u91CF</dt><dd>${usageText}</dd></div>
          <div class="zh-statrow"><dt>\u5B9A\u4F4D</dt><dd>${locationText}</dd></div>
          <div class="zh-statrow"><dt>\u590D\u6838</dt><dd>${escapeHtml(reviewText(entry))}</dd></div>
        </dl>
        <h4 class="zh-h4">\u5C0F\u9898</h4>
        <div class="zp-sublist" style="margin-top:2px">${subRows || '<div class="zp-reason">\u65E0</div>'}</div>
        <div class="zh-actions">
          <button class="zg-btn small primary" data-act="detail-jump" ${canJumpRecord(entry) ? "" : "disabled"} title="${canJumpRecord(entry) ? "\u5728\u9605\u5377\u9875\u56DE\u8BC4\u8FD9\u4E00\u4EFD\u5377\u5B50" : "\u8BE5\u8BB0\u5F55\u6CA1\u6709\u5B66\u53F7\uFF0C\u65E0\u6CD5\u5B9A\u4F4D"}">\u5B9A\u4F4D\u5230\u8BE5\u5377</button>
          <button class="zg-btn small" data-act="detail-review">${entry.reviewedAt ? "\u4FEE\u6539\u590D\u6838\u5907\u6CE8" : "\u6807\u8BB0\u5DF2\u590D\u6838"}</button>
          <button class="zg-btn small ghost" data-act="detail-score">\u8BB0\u5F55\u786E\u8BA4\u5206</button>
        </div>`;

      const jumpButton = container.querySelector('[data-act="detail-jump"]');
      if (jumpButton) jumpButton.addEventListener("click", () => this.callbacks.onJump?.(entry));
      // 复核留痕：备注与确认分都写回历史，导出时一并带出。
      const reviewButton = container.querySelector('[data-act="detail-review"]');
      if (reviewButton) {
        reviewButton.addEventListener("click", () => {
          const note = window.prompt("\u590D\u6838\u5907\u6CE8\uFF08\u53EF\u7559\u7A7A\uFF09", entry.reviewNote || "");
          if (note === null) return;
          this.callbacks.onReview?.(entry.id, { reviewedAt: Date.now(), reviewNote: note.trim() });
        });
      }
      const scoreButton = container.querySelector('[data-act="detail-score"]');
      if (scoreButton) {
        scoreButton.addEventListener("click", () => {
          const raw = window.prompt("\u786E\u8BA4\u5206\u6570", String(entry.confirmedScore ?? entry.result.score));
          if (raw === null) return;
          const value = Number(raw);
          if (!Number.isFinite(value)) return;
          const max = Number(entry.result.maxScore) || 999;
          this.callbacks.onReview?.(entry.id, { confirmedScore: Math.min(Math.max(value, 0), max) });
        });
      }
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
