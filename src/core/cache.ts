  // src/core/cache.ts
  function hashString(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  function makeGradeCacheKey(input) {
    const payload = JSON.stringify({
      question: input.context.question || input.question.questionText,
      answer: input.context.answer,
      rubric: input.context.rubric,
      maxScore: input.context.maxScore,
      subs: input.question.subQuestions,
      images: input.question.images,
      model: input.model,
      pipeline: "vlm"
    });
    return `grade:${hashString(payload)}:${input.promptVersion}`;
  }
  var CacheStore = class {
    constructor(ttlDays, maxEntries = 300) {
      this.ttlDays = ttlDays;
      this.maxEntries = maxEntries;
      this.data = readJson(STORAGE_KEYS.cache, {});
      this.prune();
    }
    prune() {
      const now = Date.now();
      const limit = this.ttlDays * 864e5;
      for (const [key, envelope] of Object.entries(this.data)) {
        if (!envelope || now - envelope.savedAt > limit) delete this.data[key];
      }
      const keys = Object.keys(this.data);
      if (keys.length > this.maxEntries) {
        keys.sort((a, b) => this.data[a].savedAt - this.data[b].savedAt).slice(0, keys.length - this.maxEntries).forEach((key) => delete this.data[key]);
      }
    }
    get(key) {
      const envelope = this.data[key];
      if (!envelope) return void 0;
      return envelope.data;
    }
    set(key, data) {
      this.data[key] = { v: 1, savedAt: Date.now(), data };
      this.prune();
      writeJson(STORAGE_KEYS.cache, this.data);
    }
    clear() {
      this.data = {};
      removeKey(STORAGE_KEYS.cache);
    }
  };

