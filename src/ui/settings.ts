  // src/ui/settings.ts
  function getPath(source, path) {
    return path.split(".").reduce((value, key) => {
      if (value && typeof value === "object" && key in value) {
        return value[key];
      }
      return void 0;
    }, source);
  }
  function setPath(target, path, value) {
    const keys = path.split(".");
    let cursor = target;
    for (let i = 0; i < keys.length - 1; i += 1) {
      const key = keys[i];
      if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[keys[keys.length - 1]] = value;
  }
  var SettingsPanel = class {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.toastTimer = 0;
      this.config = {};
      this.rubricImages = [];
      this.host = document.createElement("div");
      // 三个面板统一挂同一个标记类：便于排查与外部工具定位（本身不带样式）。
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      guardEnter(this.shadow);
      this.bind();
    }
    markup() {
      const fieldRow = (label, path, type = "text", extra = "") => `
        <div class="zg-row">
          <div class="zg-rowmain"><span class="zg-rowlabel">${label}</span></div>
          <input class="zg-input zg-num" data-field="${path}" type="${type}" aria-label="${label}" ${extra}>
        </div>`;
      const area = (label, path, rows, placeholder, badge = "") => `
        <div class="zg-field">
          <label>${label}${badge}</label>
          <textarea data-field="${path}" rows="${rows}" placeholder="${placeholder}"></textarea>
        </div>`;
      return `<div class="zygr-overlay" hidden>
      <div class="zygr-dialog" role="dialog" aria-modal="true" aria-labelledby="zygr-settings-title">
        <header class="zg-head">
          <div>
            <h2 id="zygr-settings-title">\u8BBE\u7F6E</h2>
            <p>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u914D\u7F6E\u53EA\u4FDD\u5B58\u5728\u672C\u673A</p>
          </div>
          <button class="zp-iconbtn" data-act="close" aria-label="\u5173\u95ED">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </header>

        <div class="zg-shell">
          <nav class="zg-nav" aria-label="\u8BBE\u7F6E\u5206\u533A" role="tablist">
            <button class="zg-navitem is-active" data-tab="context" role="tab" aria-selected="true">
              <span class="zg-tile blue" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h9a3 3 0 013 3v13H8a3 3 0 01-3-3z"/><path d="M8 4v13a3 3 0 00-3 3"/></svg></span>
              \u6279\u6539\u4E0A\u4E0B\u6587
            </button>
            <button class="zg-navitem" data-tab="api" role="tab" aria-selected="false">
              <span class="zg-tile purple" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v4M15 3v4M7 7h10v3a5 5 0 01-10 0zM12 15v6"/></svg></span>
              \u63A5\u53E3\u4E0E\u94FE\u8DEF
            </button>
            <button class="zg-navitem" data-tab="generator" role="tab" aria-selected="false">
              <span class="zg-tile pink" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.7 4.4L18 9l-4.3 1.6L12 15l-1.7-4.4L6 9l4.3-1.6z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/></svg></span>
              \u8BC4\u5206\u6807\u51C6\u751F\u6210
            </button>
            <button class="zg-navitem" data-tab="advanced" role="tab" aria-selected="false">
              <span class="zg-tile gray" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="8" cy="18" r="2" fill="currentColor" stroke="none"/></svg></span>
              \u9AD8\u7EA7
            </button>
            <div class="zg-navfoot">\u6240\u6709\u914D\u7F6E\u4E0E\u8BB0\u5F55\u53EA\u5B58\u5728\u6D4F\u89C8\u5668\u672C\u5730\uFF0C\u4E0D\u4E0A\u4F20\u670D\u52A1\u5668\u3002\u6E05\u7A7A\u6570\u636E\u540E\u9700\u91CD\u65B0\u586B\u5199\u3002</div>
          </nav>

          <div class="zg-pane">
            <div class="zg-page is-active" data-page="context">
              <div class="zg-pagehead">
                <h2>\u6279\u6539\u4E0A\u4E0B\u6587</h2>
                <p>\u9898\u53F7\u3001\u6EE1\u5206\u4E0E\u5C0F\u9898\u7531\u9605\u5377\u9875\u8BFB\u53D6\uFF1B\u8FD9\u91CC\u7684\u53C2\u8003\u7B54\u6848\u4E0E\u8BC4\u5206\u6807\u51C6\u4F1A\u968F\u6BCF\u6B21\u6279\u6539\u53D1\u9001\u7ED9\u6A21\u578B\u3002</p>
              </div>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u9898\u76EE\u4E0E\u9605\u5377\u4F9D\u636E</h3>
                <div class="zg-group">
                  ${area("\u9898\u76EE\u5185\u5BB9", "context.question", 3, "\u7559\u7A7A\u65F6\u4F7F\u7528\u9875\u9762\u9898\u53F7\uFF0C\u586B\u5199\u540E\u80FD\u63D0\u9AD8\u5224\u65AD\u7CBE\u5EA6", '<span class="zg-opt">\u53EF\u9009</span>')}
                  ${area("\u53C2\u8003\u7B54\u6848", "context.answer", 5, "", '<span class="zg-req">\u5FC5\u586B</span>')}
                  ${area("\u8BC4\u5206\u6807\u51C6", "context.rubric", 6, "", '<span class="zg-req">\u5FC5\u586B</span>')}
                </div>
                <p class="zg-note">\u6EE1\u5206\u4E0D\u5FC5\u624B\u5DE5\u7EF4\u62A4\uFF1A\u6279\u6539\u524D\u4F1A\u8BFB\u9875\u9762\uFF0C\u4E0D\u4E00\u81F4\u65F6\u81EA\u52A8\u5199\u56DE\u5E76\u63D0\u793A\u4E00\u884C\uFF0C\u4E0D\u518D\u963B\u65AD\u6279\u6539\u3002</p>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u57FA\u672C\u53C2\u6570</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u672C\u65B9\u6848\u6EE1\u5206</span><span class="zg-rowdesc">\u4E0E\u9875\u9762\u4E0D\u4E00\u81F4\u65F6\u81EA\u52A8\u540C\u6B65</span></div>
                    <input class="zg-input zg-num" data-field="context.maxScore" type="number" aria-label="\u672C\u65B9\u6848\u6EE1\u5206">
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u5B66\u79D1</span><span class="zg-rowdesc">\u7528\u4E8E\u81EA\u52A8\u5957\u7528\u56FE\u7247\u7B56\u7565\u4E0E\u5224\u5206\u53E3\u5F84</span></div>
                    <span class="zg-select">
                      <select data-field="context.subject" aria-label="\u5B66\u79D1">
                        <option value="">\u4E0D\u6307\u5B9A\uFF08\u6309\u624B\u52A8\u53C2\u6570\uFF09</option>
                        ${Object.keys(RUBRIC_SUBJECTS).map((name) => `<option value="${name}">${name}</option>`).join("")}
                      </select>
                    </span>
                  </div>
                </div>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u6807\u51C6\u5E93</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u672C\u9898\u6807\u51C6</span><span class="zg-rowdesc">\u6309\u300C\u8BD5\u5377 + \u9898\u53F7\u300D\u5206\u69FD\u4FDD\u5B58</span></div>
                    <div class="zg-rowactions">
                      <button class="zg-btn small" data-act="rubric-save">\u4FDD\u5B58</button>
                      <button class="zg-btn small ghost" data-act="rubric-load">\u8F7D\u5165</button>
                      <button class="zg-btn small ghost" data-act="rubric-clear">\u6E05\u7A7A</button>
                    </div>
                  </div>
                </div>
                <p class="zg-note">\u5207\u5230\u5176\u5B83\u9898\u53F7\u65F6\u4F1A\u81EA\u52A8\u5B58\u4E0B\u5F53\u524D\u8FD9\u4EFD\u3001\u5E76\u8F7D\u5165\u90A3\u9053\u9898\u5DF2\u5B58\u7684\u6807\u51C6\uFF1B\u6CA1\u5B58\u8FC7\u5219\u6E05\u7A7A\u7B54\u6848\u4E0E\u6807\u51C6\uFF0C\u907F\u514D\u62FF\u9519\u7B54\u6848\u3002</p>
              </section>
            </div>

            <div class="zg-page" data-page="api" hidden>
              <div class="zg-pagehead">
                <h2>\u63A5\u53E3\u4E0E\u94FE\u8DEF</h2>
                <p>\u8BC4\u5206\u53EA\u8D70\u591A\u6A21\u6001\u76F4\u8BC4\uFF1A\u628A\u4F5C\u7B54\u56FE\u76F4\u63A5\u4EA4\u7ED9\u89C6\u89C9\u6A21\u578B\uFF0C\u4E0D\u505A OCR \u4E2D\u8F6C\u3002</p>
              </div>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u5E73\u53F0\u9884\u8BBE</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u5E73\u53F0</span><span class="zg-rowdesc">\u5207\u6362\u4F1A\u6062\u590D\u8BE5\u5E73\u53F0\u8BB0\u4F4F\u7684 Key\u3001\u6A21\u578B\u4E0E\u601D\u8003\u6A21\u5F0F</span></div>
                    <span class="zg-select wide"><select data-field="pipeline.vlm.platform" data-platform-select aria-label="\u5E73\u53F0\u9884\u8BBE"></select></span>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u63A5\u53E3\u5730\u5740</span></div>
                    <input class="zg-input" data-field="pipeline.vlm.endpoint" style="max-width:340px" aria-label="\u63A5\u53E3\u5730\u5740">
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">API Key</span></div>
                    <span class="zg-inputwrap">
                      <input class="zg-input" data-field="pipeline.vlm.apiKey" type="password" aria-label="API Key">
                      <button data-act="toggle-key" aria-label="\u663E\u793A\u6216\u9690\u85CF API Key">\u663E\u793A</button>
                    </span>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u6A21\u578B</span><span class="zg-rowdesc">\u5FC5\u987B\u652F\u6301\u56FE\u7247\u8F93\u5165</span></div>
                    <input class="zg-input" data-field="pipeline.vlm.model" style="max-width:200px" aria-label="\u6A21\u578B\u540D\u79F0">
                  </div>
                  <div class="zg-row" data-model-options hidden>
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u6A21\u578B\u5217\u8868</span><span class="zg-rowdesc">\u9009\u62E9\u4E00\u4E2A\u586B\u5165\u4E0A\u65B9\u6A21\u578B</span></div>
                    <span class="zg-select"><select data-field-model-picker aria-label="\u9009\u62E9\u6A21\u578B"></select></span>
                    <button class="zg-btn small" data-act="apply-model">\u4F7F\u7528</button>
                  </div>
                </div>
                <div class="zg-inline" style="margin-top:8px">
                  <button class="zg-btn small" data-act="fetch-models">\u83B7\u53D6\u6A21\u578B\u5217\u8868</button>
                  <span class="zg-status" data-status="models"></span>
                  <button class="zg-btn small" data-test="vlm">\u6D4B\u8BD5\u591A\u6A21\u6001</button>
                  <span class="zg-status" data-status="vlm"></span>
                </div>
                <p class="zg-note">\u5E73\u53F0\u4E0D\u652F\u6301\u5728\u7EBF\u5217\u8868\u65F6\u53EA\u63D0\u793A\u624B\u52A8\u586B\u5199\uFF0C\u4E0D\u4F1A\u62A5\u9519\u4E2D\u65AD\u3002</p>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u601D\u8003\u6A21\u5F0F</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u601D\u8003\u7A0B\u5EA6</span><span class="zg-rowdesc">\u9ED8\u8BA4\u5173\u95ED\uFF0C\u957F\u94FE\u63A8\u7406\u6A21\u578B\u53EF\u80FD\u9700\u6570\u5341\u79D2</span></div>
                    <div class="zg-seg" data-seg="thinking" role="group" aria-label="\u601D\u8003\u6A21\u5F0F">
                      <button data-value="off" aria-pressed="true" title="${thinkingLevelLabel("off")}">${thinkingLevelLabel("off")}</button>
                      <button data-value="auto" aria-pressed="false" title="${thinkingLevelLabel("auto")}">${thinkingLevelLabel("auto").replace(/\uFF08.*$/, "")}</button>
                    </div>
                    <select data-field="pipeline.thinkingMode" hidden aria-hidden="true" tabindex="-1">
                      <option value="off">${thinkingLevelLabel("off")}</option>
                      <option value="auto">${thinkingLevelLabel("auto")}</option>
                    </select>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u751F\u6548\u68C0\u6D4B</span><span class="zg-rowdesc">GLM-5.3 \u7B49\u6A21\u578B\u4F1A\u5F3A\u5236\u601D\u8003\uFF0C\u9009\u5173\u95ED\u4E5F\u6309\u6A21\u578B\u9ED8\u8BA4\u8FD0\u884C</span></div>
                    <button class="zg-btn small" data-act="test-thinking">\u6D4B\u8BD5</button>
                    <span class="zg-status" data-status="thinking"></span>
                  </div>
                </div>
                <p class="zg-note">\u80FD\u4E0D\u80FD\u5173\u95ED\u53D6\u51B3\u4E8E\u6A21\u578B\u800C\u4E0D\u662F\u5E73\u53F0\uFF1B\u5982\u679C\u8FD4\u56DE\u201C\u4E0D\u652F\u6301\u5173\u95ED\u601D\u8003\u201D\uFF0C\u7A0B\u5E8F\u4F1A\u81EA\u52A8\u8BC6\u522B\u5E76\u8BB0\u4F4F\uFF0C\u4E0B\u6B21\u4E0D\u518D\u91CD\u590D\u8BD5\u9519\u3002</p>
              </section>
            </div>

            <div class="zg-page" data-page="generator" hidden>
              <div class="zg-pagehead">
                <h2>\u8BC4\u5206\u6807\u51C6\u751F\u6210</h2>
                <p>\u9009\u5B66\u79D1\u4E0E\u9898\u578B\uFF0C\u586B\u5199\u9898\u76EE\u4E0E\u5B66\u6821\u6807\u51C6\u7B54\u6848\uFF0C\u8BA9\u6A21\u578B\u751F\u6210\u7ED3\u6784\u5316\u8BC4\u5206\u6807\u51C6\u3002\u4F1A\u6D88\u8D39\u4E00\u6B21\u771F\u5B9E\u8BF7\u6C42\u3002</p>
              </div>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u751F\u6210\u6761\u4EF6</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u5B66\u79D1</span></div>
                    <span class="zg-select"><select data-gen="subject" aria-label="\u5B66\u79D1">${Object.keys(RUBRIC_SUBJECTS).map((name) => `<option value="${name}">${name}</option>`).join("")}</select></span>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u9898\u578B</span></div>
                    <span class="zg-select"><select data-gen="type" aria-label="\u9898\u578B"></select></span>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u6EE1\u5206</span><span class="zg-rowdesc">\u7559\u7A7A\u5219\u7531 AI \u5EFA\u8BAE</span></div>
                    <input class="zg-input zg-num" type="number" data-gen="maxScore" min="0" step="0.5" aria-label="\u6EE1\u5206">
                  </div>
                </div>
                <p class="zg-note" data-gen="rule-hint"></p>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u9898\u76EE\u4E0E\u6807\u51C6\u7B54\u6848</h3>
                <div class="zg-group">
                  <div class="zg-field">
                    <label>\u9898\u76EE <span class="zg-opt">\u4F5C\u6587\u7C7B\u5FC5\u586B</span></label>
                    <textarea data-gen="question" rows="3" placeholder="\u53EF\u7C98\u8D34\u9898\u76EE\u6587\u5B57\uFF0C\u6216\u7559\u7A7A\u4EC5\u7528\u56FE\u7247"></textarea>
                  </div>
                  <div class="zg-field">
                    <label>\u5B66\u6821\u6807\u51C6\u7B54\u6848</label>
                    <textarea data-gen="answer" rows="4" placeholder="\u5316\u5B66\u5F0F\u3001\u516C\u5F0F\u7B26\u53F7\u53EF\u76F4\u63A5\u7C98\u8D34"></textarea>
                  </div>
                  <div class="zg-field">
                    <label>\u6807\u51C6\u7B54\u6848\u56FE\u7247 <span class="zg-opt">\u53EF\u591A\u9009</span></label>
                    <label class="zg-drop">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M8 8l4-4 4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
                      <span>\u70B9\u51FB\u9009\u62E9\u56FE\u7247</span>
                      <small>\u652F\u6301\u591A\u5F20\uFF0C\u6309\u987A\u5E8F\u53D1\u9001\u7ED9\u6A21\u578B</small>
                      <input type="file" data-gen="images" accept="image/*" multiple>
                    </label>
                    <p class="zg-note" data-gen-thumbs></p>
                  </div>
                </div>
                <div class="zg-inline" style="margin-top:8px">
                  <button class="zg-btn primary" data-act="gen-run">\u751F\u6210\u8BC4\u5206\u6807\u51C6</button>
                  <span class="zg-status" data-status="gen"></span>
                </div>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u751F\u6210\u7ED3\u679C</h3>
                <div class="zg-group">
                  <div class="zg-field">
                    <label>\u53EF\u76F4\u63A5\u7F16\u8F91\uFF0C\u786E\u8BA4\u65E0\u8BEF\u540E\u4E00\u952E\u586B\u5165</label>
                    <textarea data-gen="result" rows="10" placeholder="\u751F\u6210\u7684\u6807\u51C6\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC"></textarea>
                  </div>
                </div>
                <div class="zg-inline" style="margin-top:8px">
                  <button class="zg-btn" data-act="gen-apply">\u4E00\u952E\u586B\u5165\u6279\u6539\u4E0A\u4E0B\u6587</button>
                  <button class="zg-btn ghost" data-act="gen-copy">\u590D\u5236</button>
                  <button class="zg-btn ghost" data-act="gen-clear">\u6E05\u7A7A</button>
                </div>
              </section>
            </div>

            <div class="zg-page" data-page="advanced" hidden>
              <div class="zg-pagehead">
                <h2>\u9AD8\u7EA7</h2>
                <p>\u56FE\u7247\u3001\u7F13\u5B58\u3001\u9650\u6D41\u4E0E\u7528\u91CF\u3002\u6539\u9519\u8FD9\u91CC\u4E0D\u4F1A\u5F04\u574F\u6570\u636E\uFF0C\u4F46\u53EF\u80FD\u8BA9\u6279\u6539\u53D8\u6162\u6216\u53D8\u8D35\u3002</p>
              </div>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u56FE\u7247\u4E0E\u63D0\u793A\u8BCD</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u56FE\u7247\u7CBE\u5EA6</span><span class="zg-rowdesc">\u624B\u5199\u5185\u5BB9\u5EFA\u8BAE\u9AD8\u7CBE\u5EA6</span></div>
                    <div class="zg-seg" data-seg="detail" role="group" aria-label="\u56FE\u7247\u7CBE\u5EA6">
                      <button data-value="high" aria-pressed="true">\u9AD8</button>
                      <button data-value="auto" aria-pressed="false">\u81EA\u52A8</button>
                      <button data-value="low" aria-pressed="false">\u4F4E</button>
                    </div>
                    <select data-field="image.detail" hidden aria-hidden="true" tabindex="-1">
                      <option value="high">\u9AD8\u7CBE\u5EA6</option>
                      <option value="auto">\u81EA\u52A8</option>
                      <option value="low">\u4F4E\u7CBE\u5EA6</option>
                    </select>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u56FE\u7247\u957F\u8FB9\u4E0A\u9650</span><span class="zg-rowdesc">\u53EA\u7B49\u6BD4\u7F29\u5C0F\uFF0C\u7EDD\u4E0D\u653E\u5927</span></div>
                    <input class="zg-input zg-num" data-field="image.maxEdge" type="number" aria-label="\u56FE\u7247\u957F\u8FB9\u4E0A\u9650">
                    <span class="zg-rowvalue">px</span>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">JPEG \u8D28\u91CF</span><span class="zg-rowdesc">\u4E0D\u5F71\u54CD\u8BA1\u8D39\uFF0C\u53EA\u5F71\u54CD\u4F53\u79EF</span></div>
                    <input class="zg-input zg-num" data-field="image.quality" type="number" step="0.01" aria-label="JPEG \u8D28\u91CF">
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u5386\u53F2\u4FDD\u7559\u6761\u6570</span></div>
                    <input class="zg-input zg-num" data-field="historyLimit" type="number" aria-label="\u5386\u53F2\u4FDD\u7559\u6761\u6570">
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u7F13\u5B58\u6709\u6548\u671F</span><span class="zg-rowdesc">\u8D85\u671F\u540E\u540C\u9898\u540C\u56FE\u9700\u91CD\u65B0\u8BF7\u6C42</span></div>
                    <input class="zg-input zg-num" data-field="cacheTtlDays" type="number" aria-label="\u7F13\u5B58\u6709\u6548\u671F">
                    <span class="zg-rowvalue">\u5929</span>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u7F13\u5B58\u6761\u6570\u4E0A\u9650</span><span class="zg-rowdesc">\u53CC\u8BC4\u5927\u5377\u53EF\u63D0\u5230 3000</span></div>
                    <input class="zg-input zg-num" data-field="cacheMaxEntries" type="number" aria-label="\u7F13\u5B58\u6761\u6570\u4E0A\u9650">
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u6309\u5B66\u79D1\u81EA\u52A8\u5957\u7528\u56FE\u7247\u7B56\u7565</span><span class="zg-rowdesc">\u6570\u5B66/\u7269\u7406/\u5316\u5B66 1600px\uFF0C\u8BED\u6587/\u82F1\u8BED/\u751F\u7269 1440px\uFF0C\u5386\u53F2/\u653F\u6CBB/\u5730\u7406 1280px</span></div>
                    <label class="zg-switch">
                      <input type="checkbox" data-field="image.autoBySubject" aria-label="\u6309\u5B66\u79D1\u81EA\u52A8\u5957\u7528\u56FE\u7247\u7B56\u7565">
                      <span class="zg-switch-track" aria-hidden="true"></span>
                    </label>
                  </div>
                </div>
                <p class="zg-note">\u56FE\u7247 token \u53EA\u53D7\u5C3A\u5BF8\u4E0E\u7CBE\u5EA6\u5F71\u54CD\uFF1B\u4F4E\u7CBE\u5EA6\u4E0E\u4F4E\u5206\u8FA8\u7387\u4F1A\u81EA\u52A8\u6807\u8BB0\u4EBA\u5DE5\u590D\u6838\u3002\u8F93\u51FA\u6863\u4F4D\u5DF2\u79FB\u5230\u4E3B\u9762\u677F\u5E95\u90E8\u3002</p>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u7D2F\u8BA1\u7528\u91CF</h3>
                <div class="zg-group"><p class="zg-statsline" data-stats>\u7D2F\u8BA1\u7528\u91CF\uFF1A\u6682\u65E0</p></div>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u9650\u901F\u4E0E\u8D85\u65F6</h3>
                <div class="zg-group">
                  ${fieldRow("\u5E76\u53D1\u4E0A\u9650", "pipeline.maxConcurrent", "number")}
                  ${fieldRow("RPM \u9884\u7B97", "pipeline.maxRpm", "number")}
                  ${fieldRow("TPM \u9884\u7B97", "pipeline.maxTpm", "number")}
                  ${fieldRow("\u8BF7\u6C42\u8D85\u65F6", "pipeline.timeoutMs", "number")}
                </div>
                <p class="zg-note">\u6240\u6709\u914D\u7F6E\u4EC5\u4FDD\u5B58\u5728\u5F53\u524D\u6CB9\u7334\u73AF\u5883\u4E2D\uFF0C\u4E0D\u4F1A\u8BFB\u53D6\u65E7\u63D2\u4EF6\u914D\u7F6E\uFF1B\u6E05\u7A7A\u6570\u636E\u540E\u9700\u91CD\u65B0\u586B\u5199\u3002</p>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u6570\u636E</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u91CD\u7F6E\u4E3A\u9ED8\u8BA4\u914D\u7F6E</span><span class="zg-rowdesc">\u542B\u63A5\u53E3\u5730\u5740\u4E0E\u56FE\u7247\u53C2\u6570\uFF0CAPI Key \u4E5F\u4F1A\u6E05\u7A7A</span></div>
                    <button class="zg-btn small danger" data-act="reset">\u91CD\u7F6E</button>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u6E05\u7A7A\u5168\u90E8\u6570\u636E</span><span class="zg-rowdesc">\u5386\u53F2\u3001\u7F13\u5B58\u3001\u6807\u51C6\u5E93\u4E0E\u914D\u7F6E\u4E00\u5E76\u5220\u9664</span></div>
                    <button class="zg-btn small danger" data-act="clear">\u6E05\u7A7A</button>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>

        <footer class="zg-foot">
          <div class="zg-foot-left">
            <button class="zg-btn small ghost" data-act="export">\u5BFC\u51FA\u914D\u7F6E</button>
            <button class="zg-btn small ghost" data-act="import">\u5BFC\u5165\u914D\u7F6E</button>
          </div>
          <div class="zg-foot-right">
            <button class="zg-btn" data-act="cancel">\u5173\u95ED</button>
            <button class="zg-btn primary" data-act="save">\u4FDD\u5B58\u914D\u7F6E</button>
          </div>
        </footer>
        <input type="file" data-config-file accept="application/json,.json" hidden>
        <div class="zygr-toast" data-toast hidden></div>
      </div>
    </div>`;
    }
    q(selector) {
      const element = this.shadow.querySelector(selector);
      if (!element) throw new Error(`\u8BBE\u7F6E\u754C\u9762\u5143\u7D20\u7F3A\u5931\uFF1A${selector}`);
      return element;
    }
    bind() {
      this.shadow.addEventListener("click", (event) => {
        const target = event.target;
        const tab = target.closest("[data-tab]");
        if (tab) {
          this.shadow.querySelectorAll("[data-tab]").forEach((item) => {
            const active = item === tab;
            item.classList.toggle("is-active", active);
            item.setAttribute("aria-selected", String(active));
          });
          this.shadow.querySelectorAll("[data-page]").forEach((page) => {
            const active = page.getAttribute("data-page") === tab.dataset.tab;
            page.hidden = !active;
            page.classList.toggle("is-active", active);
          });
          this.q(".zg-pane").scrollTop = 0;
          return;
        }
        const segButton = target.closest(".zg-seg button");
        if (segButton) {
          const seg = segButton.parentElement;
          seg.querySelectorAll("button").forEach((item) => {
            item.setAttribute("aria-pressed", String(item === segButton));
          });
          const select = seg.dataset.seg === "thinking"
            ? this.shadow.querySelector('[data-field="pipeline.thinkingMode"]')
            : seg.dataset.seg === "detail"
              ? this.shadow.querySelector('[data-field="image.detail"]')
              : null;
          if (select) select.value = segButton.dataset.value;
          return;
        }
        const test = target.closest("[data-test]");
        if (test) {
          void this.test(test.dataset.test);
          return;
        }
        const action = target.closest("[data-act]")?.dataset.act;
        if (action === "toggle-key") {
          const input = this.shadow.querySelector('[data-field="pipeline.vlm.apiKey"]');
          if (input) {
            const show = input.type === "password";
            input.type = show ? "text" : "password";
            target.textContent = show ? "\u9690\u85CF" : "\u663E\u793A";
          }
          return;
        }
        if (action === "gen-run") {
          void this.generateRubric();
          return;
        }
        if (action === "gen-apply") {
          const result = this.shadow.querySelector('[data-gen="result"]')?.value || "";
          if (!result.trim()) return this.toast("\u8BF7\u5148\u751F\u6210\u8BC4\u5206\u6807\u51C6");
          const genValue = (key) => String(this.shadow.querySelector(`[data-gen="${key}"]`)?.value ?? "").trim();
          const question = genValue("question");
          const answer = genValue("answer");
          const maxScore = Number(genValue("maxScore")) || 0;
          if (question) {
            const field = this.shadow.querySelector('[data-field="context.question"]');
            if (field) field.value = question;
          }
          if (answer) {
            const field = this.shadow.querySelector('[data-field="context.answer"]');
            if (field) field.value = answer;
          }
          if (maxScore > 0) {
            const field = this.shadow.querySelector('[data-field="context.maxScore"]');
            if (field) field.value = String(maxScore);
          }
          const rubricField = this.shadow.querySelector('[data-field="context.rubric"]');
          if (rubricField) rubricField.value = result;
          const contextTab = this.shadow.querySelector('[data-tab="context"]');
          if (contextTab) contextTab.click();
          this.toast("\u5DF2\u586B\u5165\u8BC4\u5206\u6807\u51C6\u3001\u9898\u76EE\u3001\u53C2\u8003\u7B54\u6848\u4E0E\u6EE1\u5206\uFF0C\u8BF7\u70B9\u300C\u4FDD\u5B58\u914D\u7F6E\u300D\u751F\u6548");
          return;
        }
        if (action === "rubric-save") {
          this.callbacks.onRubricSave?.(this.readContextDraft());
          return;
        }
        if (action === "rubric-load") {
          this.callbacks.onRubricLoad?.();
          // 载入后立刻用落盘的配置重填表单，否则界面上还是旧内容，看起来像没生效。
          this.show(loadConfig());
          return;
        }
        if (action === "rubric-clear") {
          this.callbacks.onRubricClear?.();
          return;
        }
        if (action === "gen-copy") {
          const result = this.shadow.querySelector('[data-gen="result"]')?.value || "";
          if (!result.trim()) return this.toast("\u8BF7\u5148\u751F\u6210\u8BC4\u5206\u6807\u51C6");
          void navigator.clipboard?.writeText(result).then(
            () => this.toast("\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F"),
            () => this.toast("\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u4E2D\u6587\u672C\u590D\u5236")
          );
          return;
        }
        if (action === "gen-clear") {
          this.shadow.querySelectorAll('[data-gen="question"], [data-gen="answer"], [data-gen="result"]').forEach((element) => { element.value = ""; });
          const maxScoreField = this.shadow.querySelector('[data-gen="maxScore"]');
          if (maxScoreField) maxScoreField.value = "";
          this.rubricImages = [];
          const thumbs = this.shadow.querySelector("[data-gen-thumbs]");
          if (thumbs) thumbs.textContent = "";
          return;
        }
        if (action === "fetch-models") {
          void this.fetchModels();
          return;
        }
        if (action === "test-thinking") {
          void this.testThinking();
          return;
        }
        if (action === "apply-model") {
          const picker = this.shadow.querySelector("[data-field-model-picker]");
          if (picker?.value) {
            const modelField = this.shadow.querySelector('[data-field="pipeline.vlm.model"]');
            if (modelField) modelField.value = picker.value;
            this.toast("\u6A21\u578B\u5DF2\u586B\u5165\uFF0C\u8BF7\u70B9\u300C\u4FDD\u5B58\u914D\u7F6E\u300D\u751F\u6548");
          }
          return;
        }
        if (action === "export") {
          this.exportConfig();
          return;
        }
        if (action === "import") {
          this.q("[data-config-file]").click();
          return;
        }
        if (action === "close" || action === "cancel") {
          if (this.confirmDiscard()) this.hide();
        }
        else if (action === "save") {
          this.callbacks.onSave(this.getDraft());
          this.toast("\u914D\u7F6E\u5DF2\u4FDD\u5B58");
        } else if (action === "reset") {
          this.callbacks.onReset();
          this.toast("\u5DF2\u6062\u590D\u9ED8\u8BA4\u503C\uFF0C\u8BF7\u91CD\u65B0\u586B\u5199\u63A5\u53E3\u4FE1\u606F");
        } else if (action === "clear") {
          this.callbacks.onClear();
          this.toast("\u5DF2\u6E05\u7A7A\u5168\u90E8\u6570\u636E");
        }
      });
      this.shadow.addEventListener("change", (event) => {
        const target = event.target;
        if (target.dataset.gen === "subject") this.populateRubricTypes();
        else if (target.dataset.gen === "type") this.refreshRuleHint();
        if (target.dataset.gen === "images") {
          void this.loadRubricImages(target.files);
          target.value = "";
        }
        if (target.hasAttribute("data-platform-select")) this.applyPlatform(target.dataset.field || "", target.value);
        if (target.hasAttribute("data-config-file") && target.files?.[0]) {
          void this.importConfig(target.files[0]);
          target.value = "";
        }
      });
    }
    // 分段控件只是显示层，真正的值仍写在隐藏的 select 里，getDraft / show / applyPlatform 不必改。
    syncSegments() {
      [["thinking", '[data-field="pipeline.thinkingMode"]'], ["detail", '[data-field="image.detail"]']].forEach(([name, selector]) => {
        const select = this.shadow.querySelector(selector);
        const seg = this.shadow.querySelector(`[data-seg="${name}"]`);
        if (!select || !seg) return;
        seg.querySelectorAll("button").forEach((button) => {
          button.setAttribute("aria-pressed", String(button.dataset.value === select.value));
        });
      });
    }
    // 思考只保留两档，历史配置里的 low/high/max 在回填时收敛为「模型默认」。
    clampThinkingSelect() {
      const element = this.shadow.querySelector('[data-field="pipeline.thinkingMode"]');
      if (element instanceof HTMLSelectElement) {
        element.value = clampThinkingLevel("", element.value);
        this.syncSegments();
      }
    }
    // 累计用量来自本地计数，不触发任何请求。
    refreshStats() {
      const element = this.shadow.querySelector("[data-stats]");
      if (!element) return;
      const stats = loadUsageStats();
      if (!stats.graded) {
        element.textContent = "\u7D2F\u8BA1\u7528\u91CF\uFF1A\u6682\u65E0";
        return;
      }
      const hitRate = stats.graded > 0 ? Math.round((stats.localHits / stats.graded) * 100) : 0;
      const cacheRate = stats.promptTokens > 0 ? Math.round((stats.cachedTokens / stats.promptTokens) * 100) : 0;
      const reasoning = stats.reasoningTokens > 0 ? ` \xB7 \u601D\u8003 ${stats.reasoningTokens} token` : "";
      element.textContent = `\u7D2F\u8BA1\uFF1A\u6279\u6539 ${stats.graded} \u6B21 \xB7 \u672C\u5730\u547D\u4E2D ${stats.localHits} \u6B21\uFF08${hitRate}%\uFF09 \xB7 \u8BF7\u6C42 ${stats.requests} \u6B21 \xB7 \u8F93\u5165 ${stats.promptTokens} token\uFF08\u524D\u7F00\u547D\u4E2D ${stats.cachedTokens}\uFF0C${cacheRate}%\uFF09 \xB7 \u8F93\u51FA ${stats.completionTokens} token${reasoning}`;
    }
    refreshPlatformSelects() {
      const presets = listPlatformPresets();
      this.shadow.querySelectorAll("[data-platform-select]").forEach((element) => {
        const current = getPath(this.config, element.dataset.field || "") || element.value;
        // 用 DOM 构造 option：预设名可能来自用户，拼进 innerHTML 会有注入风险。
        const fragment = document.createDocumentFragment();
        for (const preset of presets) {
          const option = document.createElement("option");
          option.value = preset.id;
          option.textContent = preset.label;
          fragment.appendChild(option);
        }
        element.replaceChildren(fragment);
        element.value = presets.some((preset) => preset.id === current) ? current : "custom";
      });
    }
    applyPlatform(path, id) {
      const preset = getPlatformPreset(id);
      if (!preset || !path.endsWith(".platform")) return;
      const base = path.slice(0, -".platform".length);
      const getField = (fieldPath) => this.shadow.querySelector(`[data-field="${fieldPath}"]`);
      const setField = (fieldPath, value) => {
        const element = getField(fieldPath);
        if (element) element.value = value;
      };
      const keyElement = getField(`${base}.apiKey`);
      const modelElement = getField(`${base}.model`);
      const thinkingElement = getField("pipeline.thinkingMode");
      const oldPlatform = keyElement?.dataset.platformBound || getPath(this.config, path) || "custom";
      if (keyElement?.value?.trim()) setPlatformKey(oldPlatform, keyElement.value.trim());
      if (modelElement?.value?.trim()) setPlatformModel(oldPlatform, modelElement.value.trim());
      if (thinkingElement?.value) setPlatformThinkingMode(oldPlatform, thinkingElement.value);
      const rememberedKey = getPlatformKey(id);
      const rememberedModel = getPlatformModel(id);
      const rememberedThinking = getPlatformThinkingMode(id);
      if (keyElement) {
        keyElement.value = rememberedKey;
        keyElement.dataset.platformBound = id;
      }
      if (modelElement) {
        modelElement.value = rememberedModel;
        modelElement.dataset.platformBound = id;
      }
      // 历史记忆里可能是 low/high/max，统一收敛为「模型默认」。
      if (thinkingElement) thinkingElement.value = clampThinkingLevel(id, rememberedThinking || thinkingElement.value || "off");
      if (preset.endpoint) setField(`${base}.endpoint`, preset.endpoint);
      this.syncSegments();
      this.toast(`\u5DF2\u5207\u6362\u5230\u300C${preset.label}\u300D\uFF0C\u5DF2\u6062\u590D\u8BE5\u5E73\u53F0\u8BB0\u5F55\u7684 API Key\u3001\u6A21\u578B\u4E0E\u601D\u8003\u6A21\u5F0F`);
    }
    exportConfig() {
      const data = {
        app: "zygr",
        version: 1,
        exportedAt: new Date().toISOString(),
        config: this.getDraft(),
        keys: loadPlatformKeys(),
        models: loadPlatformModels(),
        thinkingModes: loadPlatformThinkingModes(),
        rubrics: loadRubricLibrary()
      };
      const now = new Date();
      const pad = (value) => String(value).padStart(2, "0");
      const filename = `\u667A\u9605\u6279\u6539\u52A9\u624B-\u914D\u7F6E-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
      downloadText(filename, JSON.stringify(data, null, 2), "application/json;charset=utf-8");
      this.toast("\u914D\u7F6E\u5DF2\u5BFC\u51FA\uFF08\u542B API Key\uFF0C\u8BF7\u59A5\u5584\u4FDD\u7BA1\uFF09");
    }
    async importConfig(file) {
      try {
        const text = await file.text();
        const data = parseConfigBackup(text);
        if (!data) throw new Error("\u914D\u7F6E\u6587\u4EF6\u683C\u5F0F\u4E0D\u6B63\u786E");
        this.callbacks.onImport(data);
        this.show(loadConfig());
        this.toast("\u914D\u7F6E\u5DF2\u5BFC\u5165");
      } catch (error) {
        this.toast(`\u5BFC\u5165\u5931\u8D25\uFF1A${error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF"}`);
      }
    }
    async fetchModels() {
      const draft = this.getDraft();
      const status = this.shadow.querySelector('[data-status="models"]');
      const pickerWrap = this.shadow.querySelector("[data-model-options]");
      const picker = this.shadow.querySelector("[data-field-model-picker]");
      const setStatus = (text, state = "") => {
        if (!status) return;
        status.textContent = text;
        status.className = `zg-status${state ? ` ${state}` : ""}`;
      };
      setStatus("\u83B7\u53D6\u4E2D\u2026");
      try {
        const models = await this.callbacks.onFetchModels(draft);
        // 平台不支持在线列表时不提供任何候选，只提示手动填写模型名称。
        if (models.manual) {
          if (picker) picker.innerHTML = "";
          if (pickerWrap) pickerWrap.hidden = true;
          const message = models.message || "\u8BE5\u5E73\u53F0\u4E0D\u652F\u6301\u5728\u7EBF\u83B7\u53D6\u6A21\u578B\u5217\u8868\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u6A21\u578B\u540D\u79F0";
          setStatus(message);
          this.toast(message);
          return;
        }
        if (picker) {
          picker.innerHTML = models.map((id) => `<option value="${String(id).replace(/"/g, "&quot;")}">${String(id).replace(/</g, "&lt;")}</option>`).join("");
        }
        if (pickerWrap) pickerWrap.hidden = false;
        const label = `\u83B7\u53D6\u5230 ${models.length} \u4E2A\u6A21\u578B`;
        setStatus(label, "ok");
        this.toast(`${label}\uFF0C\u8BF7\u9009\u62E9`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "\u83B7\u53D6\u5931\u8D25";
        setStatus(message, "bad");
        this.toast(error?.providerMessage ? String(error.providerMessage).slice(0, 120) : message.slice(0, 120));
      }
    }
    populateRubricTypes() {
      const subjectSelect = this.shadow.querySelector('[data-gen="subject"]');
      const typeSelect = this.shadow.querySelector('[data-gen="type"]');
      if (!subjectSelect || !typeSelect) return;
      const types = RUBRIC_SUBJECTS[subjectSelect.value] || [];
      const previous = typeSelect.value;
      typeSelect.innerHTML = types.map((type) => `<option value="${type}">${type}</option>`).join("");
      if (types.includes(previous)) typeSelect.value = previous;
      this.refreshRuleHint();
    }
    // 题型到底影响什么：直接显示生成时用的评分方式与判分口径，别让人以为它只是摆设。
    refreshRuleHint() {
      const subjectSelect = this.shadow.querySelector('[data-gen="subject"]');
      const typeSelect = this.shadow.querySelector('[data-gen="type"]');
      const hint = this.shadow.querySelector('[data-gen="rule-hint"]');
      if (!subjectSelect || !typeSelect || !hint) return;
      const summary = typeof rubricRuleSummary === "function" ? rubricRuleSummary(subjectSelect.value, typeSelect.value) : "";
      hint.textContent = summary ? `\u751F\u6210\u53E3\u5F84\uFF1A${summary}` : "";
    }
    async loadRubricImages(files) {
      if (!files || !files.length) return;
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(new Error("read failed"));
            reader.readAsDataURL(file);
          });
          if (dataUrl) this.rubricImages.push(dataUrl);
        } catch { /* \u8BFB\u53D6\u5931\u8D25\u7684\u56FE\u7247\u8DF3\u8FC7 */ }
      }
      const thumbs = this.shadow.querySelector("[data-gen-thumbs]");
      if (thumbs) thumbs.textContent = `\u5DF2\u9009 ${this.rubricImages.length} \u5F20\u56FE\u7247`;
    }
    async generateRubric() {
      const draft = this.getDraft();
      const status = this.shadow.querySelector('[data-status="gen"]');
      const button = this.shadow.querySelector('[data-act="gen-run"]');
      const setStatus = (text, state = "") => {
        if (!status) return;
        status.textContent = text;
        status.className = `zg-status${state ? ` ${state}` : ""}`;
      };
      const value = (key) => String(this.shadow.querySelector(`[data-gen="${key}"]`)?.value ?? "").trim();
      const payload = {
        subject: value("subject"),
        questionType: value("type"),
        question: value("question"),
        answerText: value("answer"),
        maxScore: Number(value("maxScore")) || 0,
        answerImages: [...this.rubricImages]
      };
      if (!payload.subject || !payload.questionType) return this.toast("\u8BF7\u9009\u62E9\u5B66\u79D1\u4E0E\u9898\u578B");
      if (payload.questionType.indexOf("\u4F5C\u6587") >= 0 && !payload.question && payload.answerImages.length === 0) {
        return this.toast("\u4F5C\u6587\u7C7B\u8BF7\u586B\u5199\u9898\u76EE\u6216\u4E0A\u4F20\u56FE\u7247");
      }
      setStatus("\u751F\u6210\u4E2D\u2026");
      if (button) button.disabled = true;
      try {
        const result = await this.callbacks.onGenerateRubric(draft, payload);
        const resultField = this.shadow.querySelector('[data-gen="result"]');
        if (resultField) resultField.value = result;
        setStatus("\u751F\u6210\u5B8C\u6210", "ok");
        this.toast("\u751F\u6210\u5B8C\u6210\uFF0C\u8BF7\u68C0\u67E5\u5E76\u5FAE\u8C03");
      } catch (error) {
        const message = error instanceof Error ? error.message : "\u751F\u6210\u5931\u8D25";
        const detail = error?.configSummary ? ` | ${error.configSummary}` : "";
        setStatus(message + detail, "bad");
        this.toast(error?.providerMessage ? String(error.providerMessage).slice(0, 120) : message.slice(0, 120));
      } finally {
        if (button) button.disabled = false;
      }
    }
    async testThinking() {
      const draft = this.getDraft();
      const status = this.shadow.querySelector('[data-status="thinking"]');
      const button = this.shadow.querySelector('[data-act="test-thinking"]');
      const setStatus = (text, state = "") => {
        if (!status) return;
        status.textContent = text;
        status.className = `zg-status${state ? ` ${state}` : ""}`;
      };
      const startedAt = Date.now();
      setStatus("\u6D4B\u8BD5\u4E2D\u2026 0s\uFF08\u957F\u94FE\u63A8\u7406\u6A21\u578B\u53EF\u80FD\u9700\u6570\u5341\u79D2\uFF09");
      if (button) button.disabled = true;
      const ticker = window.setInterval(() => {
        setStatus(`\u6D4B\u8BD5\u4E2D\u2026 ${Math.round((Date.now() - startedAt) / 1000)}s\uFF08\u957F\u94FE\u63A8\u7406\u6A21\u578B\u53EF\u80FD\u9700\u6570\u5341\u79D2\uFF09`);
      }, 1000);
      try {
        const result = await this.callbacks.onTestThinking(draft);
        setStatus(`${result.verdict}${result.detail ? ` | ${result.detail}` : ""}`, result.ok ? "ok" : "bad");
        this.toast(result.verdict);
      } catch (error) {
        const message = error instanceof Error ? error.message : "\u6D4B\u8BD5\u5931\u8D25";
        const detail = error?.configSummary ? ` | ${error.configSummary}` : "";
        setStatus(message + detail, "bad");
        this.toast(error?.providerMessage ? String(error.providerMessage).slice(0, 120) : message.slice(0, 120));
      } finally {
        window.clearInterval(ticker);
        if (button) button.disabled = false;
      }
    }
    async test(kind) {
      const draft = this.getDraft();
      const status = this.shadow.querySelector(`[data-status="${kind}"]`);
      const button = this.shadow.querySelector(`[data-test="${kind}"]`);
      const setStatus = (text, state = "") => {
        if (!status) return;
        status.textContent = text;
        status.className = `zg-status${state ? ` ${state}` : ""}`;
      };
      setStatus("\u6D4B\u8BD5\u4E2D\u2026");
      if (button) button.disabled = true;
      this.toast("\u6B63\u5728\u6D4B\u8BD5\u8FDE\u63A5\u2026");
      try {
        const ok = await this.callbacks.onTest(draft);
        const message = ok ? "\u56FE\u7247\u8BFB\u53D6\u6B63\u5E38" : "\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u914D\u7F6E";
        setStatus(message, ok ? "ok" : "bad");
        this.toast(message);
      } catch (error) {
        const message = error instanceof Error ? error.message : "\u8FDE\u63A5\u5931\u8D25";
        const providerMessage = error?.providerMessage ? String(error.providerMessage) : "";
        const detail = error?.configSummary ? ` | \u5B9E\u9645\u914D\u7F6E: ${error.configSummary}` : "";
        setStatus(message + detail, "bad");
        this.toast(providerMessage ? providerMessage.slice(0, 120) : message.slice(0, 120));
      } finally {
        if (button) button.disabled = false;
      }
    }
    // 只取「批改上下文」这一块（题目/答案/标准/满分/学科），给标准库存取用。
    readContextDraft() {
      return this.getDraft().context;
    }
    getDraft() {
      const draft = JSON.parse(JSON.stringify(this.config));
      this.shadow.querySelectorAll("[data-field]").forEach((element) => {
        const path = element.dataset.field;
        if (!path) return;
        const value = element instanceof HTMLInputElement && element.type === "checkbox" ? element.checked : element instanceof HTMLInputElement && element.type === "number" ? Number(element.value) : element.value;
        setPath(draft, path, value);
      });
      return draft;
    }
    // 题目/答案/评分标准只有点「保存配置」或「保存本题标准」才会落盘；
    // 直接关窗口时提醒一次，避免整段标准白填。
    confirmDiscard() {
      try {
        const draft = this.getDraft();
        const saved = loadConfig();
        if (sameRubricContext(draft.context, saved.context)) return true;
        return window.confirm("\u6279\u6539\u4E0A\u4E0B\u6587\uFF08\u9898\u76EE / \u53C2\u8003\u7B54\u6848 / \u8BC4\u5206\u6807\u51C6\uFF09\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\uFF0C\u786E\u5B9A\u5173\u95ED\uFF1F");
      } catch {
        return true;
      }
    }
    toast(message) {
      const element = this.q("[data-toast]");
      element.textContent = message;
      element.hidden = false;
      window.clearTimeout(this.toastTimer);
      this.toastTimer = window.setTimeout(() => {
        element.hidden = true;
      }, 2600);
    }
    mount() {
      if (!this.host.isConnected) document.body.appendChild(this.host);
    }
    show(config) {
      this.config = config;
      this.mount();
      const boundPlatform = getPath(config, "pipeline.vlm.platform") || "custom";
      this.refreshPlatformSelects();
      this.shadow.querySelectorAll("[data-field]").forEach((element) => {
        const value = getPath(config, element.dataset.field ?? "");
        if (element instanceof HTMLInputElement && element.type === "checkbox") element.checked = Boolean(value);
        else element.value = value === void 0 || value === null ? "" : String(value);
      });
      this.clampThinkingSelect();
      this.syncSegments();
      const keyElement = this.shadow.querySelector('[data-field="pipeline.vlm.apiKey"]');
      // 钥匙默认遮住：只在本次打开期间允许「显示」，重新打开时回到密码态。
      if (keyElement instanceof HTMLInputElement) keyElement.type = "password";
      const reveal = this.shadow.querySelector('[data-act="toggle-key"]');
      if (reveal) reveal.textContent = "\u663E\u793A";
      const modelElement = this.shadow.querySelector('[data-field="pipeline.vlm.model"]');
      if (keyElement) keyElement.dataset.platformBound = boundPlatform;
      if (modelElement) modelElement.dataset.platformBound = boundPlatform;
      this.refreshStats();
      this.populateRubricTypes();
      this.q(".zygr-overlay").hidden = false;
    }
    hide() {
      this.q(".zygr-overlay").hidden = true;
    }
  };
