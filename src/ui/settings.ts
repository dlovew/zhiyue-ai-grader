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
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      this.bind();
    }
    markup() {
      const field = (label, path, type = "text") => `
      <div class="zygr-field"><label>${label}</label><input data-field="${path}" type="${type}"></div>`;
      const area = (label, path, hint = "") => `
      <div class="zygr-field"><label>${label}</label><textarea data-field="${path}" rows="6"></textarea>${hint ? `<span class="zygr-hint">${hint}</span>` : ""}</div>`;
      const select = (label, path, options) => `
      <div class="zygr-field"><label>${label}</label><select data-field="${path}">
        ${options.map(([value, text]) => `<option value="${value}">${text}</option>`).join("")}
      </select></div>`;
      const platformSelect = (label, path) => `
      <div class="zygr-field"><label>${label}</label><select data-field="${path}" data-platform-select></select></div>`;
      return `<div class="zygr-overlay" hidden><div class="zygr-dialog zygr-wide">
      <div class="zygr-dialog-head"><h2>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u8BBE\u7F6E</h2><button class="zygr-icon" data-act="close" aria-label="\u5173\u95ED">\xD7</button></div>
      <div class="zygr-dialog-body">
        <div class="zygr-tabs">
          <button class="zygr-tab zygr-active" data-tab="context">\u6279\u6539\u4E0A\u4E0B\u6587</button>
          <button class="zygr-tab" data-tab="api">\u63A5\u53E3\u4E0E\u94FE\u8DEF</button>
          <button class="zygr-tab" data-tab="generator">\u8BC4\u5206\u6807\u51C6\u751F\u6210</button>
          <button class="zygr-tab" data-tab="advanced">\u9AD8\u7EA7</button>
        </div>

        <div class="zygr-section" data-page="context">
          <h3>\u9898\u76EE\u4E0E\u8BC4\u5377\u4F9D\u636E</h3>
          <p class="zygr-hint">\u9898\u53F7\u3001\u6EE1\u5206\u4E0E\u5C0F\u9898\u7531\u667A\u5B66\u7F51\u9605\u5377\u9875\u8BFB\u53D6\uFF1B\u8FD9\u91CC\u586B\u5199\u7684\u53C2\u8003\u7B54\u6848\u4E0E\u8BC4\u5206\u6807\u51C6\u4F1A\u968F\u6BCF\u6B21\u6279\u6539\u53D1\u9001\u7ED9\u6A21\u578B\u3002\u9898\u76EE\u5185\u5BB9\u53EF\u7559\u7A7A\uFF0C\u7559\u7A7A\u65F6\u4F7F\u7528\u9875\u9762\u9898\u53F7\u3002</p>
          ${area("\u9898\u76EE\u5185\u5BB9\uFF08\u53EF\u9009\uFF09", "context.question")}
          ${area("\u53C2\u8003\u7B54\u6848", "context.answer", "\u5FC5\u586B")}
          ${area("\u8BC4\u5206\u6807\u51C6", "context.rubric", "\u5FC5\u586B")}
          <div class="zygr-grid">${field("\u672C\u65B9\u6848\u6EE1\u5206", "context.maxScore", "number")}</div>
        </div>

        <div class="zygr-section" data-page="api" hidden>
          <h3>\u5E73\u53F0\u9884\u8BBE</h3>
          <p class="zygr-hint">\u9009\u62E9\u5E73\u53F0\u4F1A\u81EA\u52A8\u586B\u5165\u63A5\u53E3\u5730\u5740\uFF0C\u5E76\u6062\u590D\u8BE5\u5E73\u53F0\u4E0A\u6B21\u4F7F\u7528\u7684 API Key \u4E0E\u6A21\u578B\uFF08\u65B0\u5E73\u53F0\u5219\u7528\u63A8\u8350\u6A21\u578B\uFF09\u3002\u4FEE\u6539\u540E\u70B9\u300C\u4FDD\u5B58\u914D\u7F6E\u300D\u5373\u8BB0\u4F4F\u3002\u5185\u7F6E\u9884\u8BBE\u53EA\u8BFB\uFF1B\u81EA\u5B9A\u4E49\u9884\u8BBE\u53EF\u4FDD\u5B58\u3001\u4FEE\u6539\u4E0E\u5220\u9664\u3002</p>
          <div class="zygr-row"><button class="zygr-btn" data-act="preset-toggle">\u7BA1\u7406\u81EA\u5B9A\u4E49\u9884\u8BBE</button></div>
          <div data-preset-editor hidden>
            <div class="zygr-grid">
              <div class="zygr-field"><label>\u9884\u8BBE ID</label><input data-preset-field="id" placeholder="\u5982 my-proxy"></div>
              <div class="zygr-field"><label>\u663E\u793A\u540D\u79F0</label><input data-preset-field="label" placeholder="\u5982 \u6211\u7684\u4E2D\u8F6C"></div>
              <div class="zygr-field"><label>\u63A5\u53E3\u5730\u5740</label><input data-preset-field="endpoint"></div>
              <div class="zygr-field"><label>\u63A8\u8350\u6A21\u578B\uFF08\u9017\u53F7\u5206\u9694\uFF09</label><input data-preset-field="models"></div>
              <div class="zygr-field"><label>\u9274\u6743\u65B9\u5F0F</label><select data-preset-field="authHeader"><option value="bearer">Authorization: Bearer</option><option value="api-key">api-key</option><option value="none">\u65E0\u9700\u9274\u6743</option></select></div>
              <div class="zygr-field"><label>\u601D\u8003\u63A7\u5236\u5B57\u6BB5\u540D</label><input data-preset-field="disableThinkingKey" placeholder="\u7559\u7A7A\u8868\u793A\u4E0D\u6CE8\u5165\uFF0C\u5982 enable_thinking"></div>
              <div class="zygr-field"><label>\u601D\u8003\u591A\u5B57\u6BB5\u6620\u5C04\uFF08JSON\uFF0C\u53EF\u9009\uFF09</label><input data-preset-field="thinkingFields" placeholder='\u5982 {"low":{"thinking":{"type":"enabled"},"reasoning_effort":"low"}}'></div>
              <div class="zygr-field"><label>\u6D41\u5F0F\u8F93\u51FA</label><select data-preset-field="stream"><option value="false">\u5173\u95ED\uFF08\u63A8\u8350\uFF09</option><option value="true">\u5F00\u542F</option></select></div>
            </div>
            <div class="zygr-row">
              <select data-preset-field="existing" aria-label="\u9009\u62E9\u81EA\u5B9A\u4E49\u9884\u8BBE"></select>
              <button class="zygr-btn zygr-primary" data-act="preset-save">\u4FDD\u5B58\u9884\u8BBE</button>
              <button class="zygr-btn" data-act="preset-delete">\u5220\u9664\u6240\u9009</button>
              <button class="zygr-btn zygr-ghost" data-act="preset-new">\u6E05\u7A7A\u8868\u5355</button>
            </div>
          </div>

          <h3>\u591A\u6A21\u6001\u76F4\u8BC4</h3>
          <p class="zygr-hint">\u8BC4\u5206\u53EA\u4F7F\u7528\u591A\u6A21\u6001\u89C6\u89C9\u6A21\u578B\uFF1A\u76F4\u63A5\u8BFB\u53D6\u4F5C\u7B54\u56FE\u7247\u5E76\u6309\u8BC4\u5206\u6807\u51C6\u8F93\u51FA JSON\u3002\u6A21\u578B\u5FC5\u987B\u652F\u6301\u56FE\u7247\u8F93\u516E\u3002</p>
          ${select("\u601D\u8003\u6A21\u5F0F", "pipeline.thinkingMode", [["off", "\u5173\u95ED\u601D\u8003\uFF08\u7701 Token\u3001\u66F4\u5FEB\uFF09"], ["low", "low \u4F4E\u5F3A\u5EA6"], ["high", "high \u9AD8\u5F3A\u5EA6"], ["max", "max \u6700\u9AD8\u5F3A\u5EA6"], ["auto", "\u4E0D\u5E72\u9884\uFF08\u4F7F\u7528\u6A21\u578B\u9ED8\u8BA4\uFF09"]])}
          <div class="zygr-row"><button class="zygr-btn zygr-ghost" data-act="test-thinking">\u6D4B\u8BD5\u5F53\u524D\u601D\u8003\u6A21\u5F0F\u662F\u5426\u751F\u6548</button><span class="zygr-test-status" data-status="thinking"></span></div>
          <p class="zygr-hint">\u5173\u95ED\u9002\u7528\u4E8E\u9ED8\u8BA4\u5F00\u601D\u8003\u4E14\u5141\u8BB8\u5173\u95ED\u7684\u6A21\u578B\u3002\u667A\u8C31 glm-5 \u7B49\u300C\u59CB\u7EC8\u601D\u8003\u300D\u6A21\u578B\u4E0D\u652F\u6301\u5173\u95ED\uFF0C\u8BF7\u9009 low / high / max\uFF08\u53D1\u9001 thinking: "low" \u7B49\uFF09\uFF0C\u5426\u5219\u4F1A\u62A5 HTTP 400\u3002\u9009\u300C\u4E0D\u5E72\u9884\u300D\u5219\u4E0D\u53D1\u9001\u4EFB\u4F55\u601D\u8003\u53C2\u6570\u3002\u70B9\u51FB\u6D4B\u8BD5\u4F1A\u53D1\u9001\u4E00\u4E2A\u9700\u8981\u63A8\u7406\u7684\u95EE\u9898\u9A8C\u8BC1\u3002</p>

          ${platformSelect("\u5E73\u53F0\u9884\u8BBE", "pipeline.vlm.platform")}
          <h3>\u591A\u6A21\u6001\u670D\u52A1</h3>
          <div class="zygr-grid">
            ${field("\u63A5\u53E3\u5730\u5740", "pipeline.vlm.endpoint")}${field("API Key", "pipeline.vlm.apiKey", "password")}
            ${field("\u6A21\u578B", "pipeline.vlm.model")}
          </div>
          <p class="zygr-hint">\u63A5\u53E3\u5730\u5740\u4E3A OpenAI \u517C\u5BB9 Chat Completions \u5730\u5740\uFF08\u5982 https://api.siliconflow.cn/v1/chat/completions\uFF09\u3002\u6A21\u578B\u5FC5\u987B\u662F\u652F\u6301\u56FE\u7247\u8F93\u5165\u7684\u89C6\u89C9\u6A21\u578B\u3002Cloudflare Workers AI \u9700\u628A\u63A5\u53E3\u5730\u5740\u4E2D\u7684 {account_id} \u66FF\u6362\u4E3A\u81EA\u5DF1\u7684 Cloudflare \u8D26\u6237 ID\uFF0CAPI Key \u586B\u5177\u5907 Workers AI \u6743\u9650\u7684 API Token\u3002\u8BE5\u5E73\u53F0\u65E0 /models \u7AEF\u70B9\uFF0C\u83B7\u53D6\u6A21\u578B\u4F1A\u5217\u51FA\u9884\u8BBE\u63A8\u8350\u503C\uFF1B\u601D\u8003\u5F3A\u5EA6\u4EC5\u5BF9 gpt-oss \u63A8\u7406\u6A21\u578B\u751F\u6548\uFF08reasoning_effort\uFF09\uFF0C\u5176\u4ED6\u6A21\u578B\u8BF7\u9009\u300C\u4E0D\u5E72\u9884\u300D\u3002</p>
          <div class="zygr-row"><button class="zygr-btn" data-act="fetch-models">\u83B7\u53D6\u6A21\u578B\u5217\u8868</button><span class="zygr-test-status" data-status="models"></span></div>
          <div data-model-options hidden><select data-field-model-picker aria-label="\u9009\u62E9\u6A21\u578B"></select><button class="zygr-btn" data-act="apply-model">\u4F7F\u7528\u6240\u9009\u6A21\u578B</button></div>
          <div class="zygr-row"><button class="zygr-btn" data-test="vlm">\u6D4B\u8BD5\u591A\u6A21\u6001</button><span class="zygr-test-status" data-status="vlm"></span></div>
        </div>

        <div class="zygr-section" data-page="generator" hidden>
          <h3>\u8BC4\u5206\u6807\u51C6\u751F\u6210\u5668</h3>
          <p class="zygr-hint">\u9009\u5B66\u79D1\u4E0E\u9898\u578B\uFF0C\u586B\u5199\u9898\u76EE\u4E0E\u5B66\u6821\u6807\u51C6\u7B54\u6848\uFF08\u6587\u5B57\u6216\u56FE\u7247\u4EFB\u9009\uFF09\uFF0C\u8BA9 AI \u751F\u6210\u7ED3\u6784\u5316\u8BC4\u5206\u6807\u51C6\u3002\u751F\u6210\u540E\u53EF\u76F4\u63A5\u7F16\u8F91\uFF0C\u786E\u8BA4\u65E0\u8BEF\u540E\u4E00\u952E\u586B\u5165\u300C\u6279\u6539\u4E0A\u4E0B\u6587 \xB7 \u8BC4\u5206\u6807\u51C6\u300D\u3002\u4F7F\u7528\u4E0E\u6279\u6539\u76F8\u540C\u7684\u591A\u6A21\u6001\u670D\u52A1\uFF0C\u4F1A\u6D88\u8D39\u4E00\u6B21\u771F\u5B9E\u8BF7\u6C42\u3002</p>
          <div class="zygr-grid">
            <div class="zygr-field"><label>\u5B66\u79D1</label><select data-gen="subject">${Object.keys(RUBRIC_SUBJECTS).map((name) => `<option value="${name}">${name}</option>`).join("")}</select></div>
            <div class="zygr-field"><label>\u9898\u578B</label><select data-gen="type"></select></div>
            <div class="zygr-field"><label>\u6EE1\u5206\uFF08\u53EF\u9009\uFF09</label><input type="number" data-gen="maxScore" min="0" step="0.5" placeholder="\u7559\u7A7A\u5219\u7531 AI \u5EFA\u8BAE"></div>
          </div>
          <div class="zygr-field" data-gen-field><label>\u9898\u76EE\uFF08\u4F5C\u6587\u7C7B\u5FC5\u586B\uFF0C\u5176\u4ED6\u53EF\u9009\uFF09</label><textarea data-gen="question" rows="3" placeholder="\u53EF\u7C98\u8D34\u9898\u76EE\u6587\u5B57\uFF0C\u6216\u7559\u7A7A\u4EC5\u7528\u56FE\u7247"></textarea></div>
          <div class="zygr-field" data-gen-field><label>\u5B66\u6821\u6807\u51C6\u7B54\u6848\uFF08\u6587\u5B57\uFF09</label><textarea data-gen="answer" rows="4" placeholder="\u53EF\u7C98\u8D34\u6807\u51C6\u7B54\u6848\u6587\u5B57\uFF0C\u5316\u5B66\u5F0F\u3001\u516C\u5F0F\u7B26\u53F7\u53EF\u76F4\u63A5\u7C98\u8D34"></textarea></div>
          <div class="zygr-field" data-gen-field><label>\u6807\u51C6\u7B54\u6848\u56FE\u7247\uFF08\u53EF\u591A\u9009\uFF09</label><input type="file" data-gen="images" accept="image/*" multiple><div data-gen-thumbs class="zygr-row"></div></div>
          <div class="zygr-row"><button class="zygr-btn zygr-primary" data-act="gen-run">\u751F\u6210\u8BC4\u5206\u6807\u51C6</button><span class="zygr-test-status" data-status="gen"></span></div>
          <div class="zygr-field" data-gen-field><label>\u751F\u6210\u7ED3\u679C\uFF08\u53EF\u76F4\u63A5\u7F16\u8F91\uFF09</label><textarea data-gen="result" rows="14" placeholder="\u751F\u6210\u540E\u5728\u6B64\u4FEE\u6539\uFF0C\u786E\u8BA4\u65E0\u8BEF\u540E\u70B9\u300C\u4E00\u952E\u586B\u5165\u300D"></textarea></div>
          <div class="zygr-row"><button class="zygr-btn" data-act="gen-apply">\u4E00\u952E\u586B\u5165\u9898\u76EE\u3001\u53C2\u8003\u7B54\u6848\u3001\u8BC4\u5206\u6807\u51C6</button><button class="zygr-btn zygr-ghost" data-act="gen-copy">\u590D\u5236\u7ED3\u679C</button><button class="zygr-btn zygr-ghost" data-act="gen-clear">\u6E05\u7A7A</button></div>
        </div>

        <div class="zygr-section" data-page="advanced" hidden>
          <h3>\u56FE\u7247\u4E0E\u63D0\u793A\u8BCD</h3>
          <div class="zygr-grid">
            ${select("\u7701 Token \u6863\u4F4D", "image.profile", [["clarity", "\u6E05\u6670\u4F18\u5148"], ["balanced", "\u5747\u8861"], ["saving", "\u7701 Token"]])}
            ${field("\u56FE\u7247\u957F\u8FB9\u4E0A\u9650\uFF08px\uFF09", "image.maxEdge", "number")}
            ${field("JPEG \u8D28\u91CF\uFF080.5-1\uFF09", "image.quality", "number")}
            ${field("\u5386\u53F2\u4FDD\u7559\u6761\u6570", "historyLimit", "number")}
            ${field("\u7F13\u5B58\u6709\u6548\u671F\uFF08\u5929\uFF09", "cacheTtlDays", "number")}
          </div>
          <label class="zygr-row"><input type="checkbox" data-field="image.cropToAnswer"> \u81EA\u52A8\u88C1\u5207\u767D\u8FB9\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF0C\u4FDD\u6301\u7B54\u5377\u539F\u8C8C\uFF09</label>
          <h3>\u9650\u901F\u4E0E\u8D85\u65F6</h3>
          <div class="zygr-grid">
            ${field("\u5E76\u53D1\u4E0A\u9650", "pipeline.maxConcurrent", "number")}
            ${field("RPM \u9884\u7B97", "pipeline.maxRpm", "number")}
            ${field("TPM \u9884\u7B97", "pipeline.maxTpm", "number")}
            ${field("\u8BF7\u6C42\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", "pipeline.timeoutMs", "number")}
          </div>
          <p class="zygr-hint">\u6240\u6709\u914D\u7F6E\u4EC5\u4FDD\u5B58\u5728\u5F53\u524D\u6CB9\u7334\u73AF\u5883\u4E2D\uFF0C\u4E0D\u4F1A\u8BFB\u53D6\u65E7\u63D2\u4EF6\u914D\u7F6E\uFF1B\u6E05\u7A7A\u6570\u636E\u540E\u9700\u91CD\u65B0\u586B\u5199\u3002</p>
        </div>
      </div>
      <div class="zygr-dialog-foot">
        <button class="zygr-btn zygr-ghost" data-act="export">\u5BFC\u51FA\u914D\u7F6E</button>
        <button class="zygr-btn zygr-ghost" data-act="import">\u5BFC\u5165\u914D\u7F6E</button>
        <button class="zygr-btn zygr-ghost" data-act="reset">\u91CD\u7F6E\u9ED8\u8BA4</button>
        <button class="zygr-btn zygr-ghost" data-act="clear">\u6E05\u7A7A\u6570\u636E</button>
        <button class="zygr-btn" data-act="cancel">\u5173\u95ED</button>
        <button class="zygr-btn zygr-primary" data-act="save">\u4FDD\u5B58\u914D\u7F6E</button>
      </div>
      <input type="file" data-config-file accept="application/json,.json" hidden>
      <div class="zygr-toast" data-toast hidden></div>
    </div></div>`;
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
          this.shadow.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("zygr-active", item === tab));
          this.shadow.querySelectorAll("[data-page]").forEach((page) => {
            page.hidden = page.getAttribute("data-page") !== tab.dataset.tab;
          });
          return;
        }
        const preset = target.closest("[data-preset]");
        if (preset) {
          const setField = (path, value) => {
            const element = this.shadow.querySelector(`[data-field="${path}"]`);
            if (element) element.value = value;
          };
          return;
        }
        const test = target.closest("[data-test]");
        if (test) {
          void this.test(test.dataset.test);
          return;
        }
        const action = target.closest("[data-act]")?.dataset.act;
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
          if (thumbs) thumbs.innerHTML = "";
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
        if (action === "preset-toggle") {
          const editor = this.shadow.querySelector("[data-preset-editor]");
          if (editor) {
            editor.hidden = !editor.hidden;
            if (!editor.hidden) this.refreshPlatformSelects();
          }
          return;
        }
        if (action === "preset-new") {
          this.loadPresetIntoForm(null);
          return;
        }
        if (action === "preset-save") {
          const presetData = this.collectPresetForm();
          if (!presetData.id) return this.toast("\u8BF7\u586B\u5199\u9884\u8BBE ID");
          if (isBuiltinPreset(presetData.id)) return this.toast("\u5185\u7F6E\u9884\u8BBE\u4E0D\u53EF\u8986\u76D6\uFF0C\u8BF7\u66F4\u6362 ID");
          if (upsertPlatformPreset(presetData)) {
            this.refreshPlatformSelects();
            this.toast(`\u9884\u8BBE\u300C${presetData.label}\u300D\u5DF2\u4FDD\u5B58`);
          } else this.toast("\u9884\u8BBE\u4FDD\u5B58\u5931\u8D25");
          return;
        }
        if (action === "preset-delete") {
          const selected = this.shadow.querySelector('[data-preset-field="existing"]')?.value;
          if (!selected) return this.toast("\u8BF7\u5148\u9009\u62E9\u81EA\u5B9A\u4E49\u9884\u8BBE");
          if (deletePlatformPreset(selected)) {
            this.refreshPlatformSelects();
            this.loadPresetIntoForm(null);
            this.toast("\u9884\u8BBE\u5DF2\u5220\u9664");
          }
          return;
        }
        if (action === "close" || action === "cancel") this.hide();
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
        if (target.dataset.gen === "images") {
          void this.loadRubricImages(target.files);
          target.value = "";
        }
        if (target.hasAttribute("data-platform-select")) this.applyPlatform(target.dataset.field || "", target.value);
        if (target.dataset.presetField === "existing") this.loadPresetIntoForm(target.value);
        if (target.hasAttribute("data-config-file") && target.files?.[0]) {
          void this.importConfig(target.files[0]);
          target.value = "";
        }
      });
    }
    refreshPlatformSelects() {
      const presets = listPlatformPresets();
      const options = presets.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("");
      this.shadow.querySelectorAll("[data-platform-select]").forEach((element) => {
        const current = getPath(this.config, element.dataset.field || "") || element.value;
        element.innerHTML = options;
        element.value = presets.some((preset) => preset.id === current) ? current : "custom";
      });
      const existing = this.shadow.querySelector('[data-preset-field="existing"]');
      if (existing) {
        const customs = loadCustomPresets();
        existing.innerHTML = customs.length
          ? customs.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("")
          : '<option value="">\uFF08\u6682\u65E0\u81EA\u5B9A\u4E49\u9884\u8BBE\uFF09</option>';
      }
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
      const oldPlatform = keyElement?.dataset.platformBound || getPath(this.config, path) || "custom";
      if (keyElement?.value?.trim()) setPlatformKey(oldPlatform, keyElement.value.trim());
      if (modelElement?.value?.trim()) setPlatformModel(oldPlatform, modelElement.value.trim());
      const rememberedKey = getPlatformKey(id);
      const rememberedModel = getPlatformModel(id);
      if (keyElement) {
        keyElement.value = rememberedKey;
        keyElement.dataset.platformBound = id;
      }
      if (modelElement) {
        modelElement.value = rememberedModel || (preset.models && preset.models.length ? preset.models[0] : "");
        modelElement.dataset.platformBound = id;
      }
      if (preset.endpoint) setField(`${base}.endpoint`, preset.endpoint);
      this.toast(`\u5DF2\u5207\u6362\u5230\u300C${preset.label}\u300D\uFF0C\u5DF2\u6062\u590D\u8BE5\u5E73\u53F0\u8BB0\u5F55\u7684 API Key \u4E0E\u6A21\u578B`);
    }
    loadPresetIntoForm(id) {
      const preset = id ? getPlatformPreset(id) : null;
      const value = (key, fallback = "") => String(preset?.[key] ?? fallback);
      const set = (key, val) => {
        const element = this.shadow.querySelector(`[data-preset-field="${key}"]`);
        if (element) element.value = val;
      };
      set("id", value("id"));
      set("label", value("label"));
      set("endpoint", value("endpoint"));
      set("models", Array.isArray(preset?.models) ? preset.models.join(", ") : "");
      set("authHeader", value("authHeader", "bearer"));
      set("disableThinkingKey", preset?.disableThinkingKey || "");
      set("thinkingFields", preset?.thinkingFields && Object.keys(preset.thinkingFields).length ? JSON.stringify(preset.thinkingFields) : "");
      set("stream", String(Boolean(preset?.stream)));
    }
    collectPresetForm() {
      const value = (key) => String(this.shadow.querySelector(`[data-preset-field="${key}"]`)?.value ?? "").trim();
      let thinkingFields = {};
      try {
        const parsed = JSON.parse(value("thinkingFields") || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) thinkingFields = parsed;
      } catch { /* 无效 JSON 时忽略映射 */ }
      return {
        id: value("id"),
        label: value("label") || value("id"),
        endpoint: value("endpoint"),
        models: value("models").split(/[,，]/).map((item) => item.trim()).filter(Boolean),
        authHeader: ["bearer", "api-key", "none"].includes(value("authHeader")) ? value("authHeader") : "bearer",
        disableThinkingKey: value("disableThinkingKey"),
        thinkingValues: {},
        thinkingFields,
        jsonModeKey: "response_format",
        stream: value("stream") === "true"
      };
    }
    exportConfig() {
      const data = {
        app: "zygr",
        version: 1,
        exportedAt: new Date().toISOString(),
        config: this.getDraft(),
        presets: loadCustomPresets(),
        keys: loadPlatformKeys(),
        models: loadPlatformModels()
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
        status.className = `zygr-test-status${state ? ` zygr-${state}` : ""}`;
      };
      setStatus("\u83B7\u53D6\u4E2D\u2026");
      try {
        const models = await this.callbacks.onFetchModels(draft);
        if (picker) {
          picker.innerHTML = models.map((id) => `<option value="${String(id).replace(/"/g, "&quot;")}">${String(id).replace(/</g, "&lt;")}</option>`).join("");
        }
        if (pickerWrap) pickerWrap.hidden = false;
        const label = models.fallback
          ? `\u8BE5\u5E73\u53F0\u4E0D\u652F\u6301\u5728\u7EBF\u62C9\u53D6\uFF0C\u5DF2\u5217\u51FA\u9884\u8BBE\u63A8\u8350\u7684 ${models.length} \u4E2A\u6A21\u578B`
          : `\u83B7\u53D6\u5230 ${models.length} \u4E2A\u6A21\u578B`;
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
      typeSelect.innerHTML = types.map((type) => `<option value="${type}">${type}</option>`).join("");
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
        status.className = `zygr-test-status${state ? ` zygr-${state}` : ""}`;
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
        status.className = `zygr-test-status${state ? ` zygr-${state}` : ""}`;
      };
      setStatus("\u6D4B\u8BD5\u4E2D\u2026");
      if (button) button.disabled = true;
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
        status.className = `zygr-test-status${state ? ` zygr-${state}` : ""}`;
      };
      setStatus("\u6D4B\u8BD5\u4E2D\u2026");
      if (button) button.disabled = true;
      this.toast("\u6B63\u5728\u6D4B\u8BD5\u8FDE\u63A5\u2026");
      try {
        const ok = await this.callbacks.onTest(draft);
        const message = ok ? "\u8FDE\u63A5\u6B63\u5E38" : "\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u914D\u7F6E";
        setStatus(message, ok ? "ok" : "bad");
        this.toast(message);
      } catch (error) {
        const message = error instanceof Error ? error.message : "\u8FDE\u63A5\u5931\u8D25";
        const providerMessage = error?.providerMessage ? String(error.providerMessage) : "";
        const detail = error?.configSummary ? ` | 实际配置: ${error.configSummary}` : "";
        setStatus(message + detail, "bad");
        this.toast(providerMessage ? providerMessage.slice(0, 120) : message.slice(0, 120));
      } finally {
        if (button) button.disabled = false;
      }
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
      this.shadow.querySelectorAll("[data-field]").forEach((element) => {
        const value = getPath(config, element.dataset.field ?? "");
        if (element instanceof HTMLInputElement && element.type === "checkbox") element.checked = Boolean(value);
        else element.value = value === void 0 || value === null ? "" : String(value);
      });
      const boundPlatform = getPath(config, "pipeline.vlm.platform") || "custom";
      const keyElement = this.shadow.querySelector('[data-field="pipeline.vlm.apiKey"]');
      const modelElement = this.shadow.querySelector('[data-field="pipeline.vlm.model"]');
      if (keyElement) keyElement.dataset.platformBound = boundPlatform;
      if (modelElement) modelElement.dataset.platformBound = boundPlatform;
      this.refreshPlatformSelects();
      this.populateRubricTypes();
      this.q(".zygr-overlay").hidden = false;
    }
    hide() {
      this.q(".zygr-overlay").hidden = true;
    }
  };

