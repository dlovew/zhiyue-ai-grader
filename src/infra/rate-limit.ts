  // src/infra/rate-limit.ts
  var RateLimiter = class {
    constructor(options) {
      this.options = options;
      this.active = 0;
      this.starts = [];
      this.tokens = [];
      this.now = options.now ?? Date.now;
      this.wait = options.wait ?? ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
    }
    prune() {
      const cutoff = this.now() - 6e4;
      this.starts = this.starts.filter((time) => time > cutoff);
      this.tokens = this.tokens.filter((entry) => entry.at > cutoff);
    }
    tokenUsed() {
      return this.tokens.reduce((sum, entry) => sum + entry.value, 0);
    }
    async acquire(estimatedTokens, timeoutMs = 3e4) {
      // 单次请求就超预算时永远等不到配额，直接拒绝比死循环好。
      if (this.options.maxTpm > 0 && estimatedTokens > this.options.maxTpm) {
        throw new Error(`\u5355\u6B21\u8BF7\u6C42\u9884\u4F30 ${estimatedTokens} token\uFF0C\u5DF2\u8D85\u8FC7 TPM \u9884\u7B97 ${this.options.maxTpm}\uFF0C\u8BF7\u8C03\u5927 TPM \u6216\u51CF\u5C11\u56FE\u7247`);
      }
      const deadline = this.now() + timeoutMs;
      for (; ; ) {
        this.prune();
        const rpmFull = this.starts.length >= this.options.maxRpm;
        const tpmFull = this.tokenUsed() + estimatedTokens > this.options.maxTpm;
        const concurrencyFull = this.active >= this.options.maxConcurrent;
        if (!rpmFull && !tpmFull && !concurrencyFull) break;
        // 配额一直不释放时给个上限，避免按钮永远卡在「处理中」。
        if (this.now() >= deadline) {
          throw new Error("\u7B49\u5F85\u9650\u6D41\u914D\u989D\u8D85\u65F6\uFF0830 \u79D2\uFF09\uFF0C\u8BF7\u8C03\u5927\u5E76\u53D1\uFF0FRPM \u6216 TPM");
        }
        await this.wait(200);
      }
      const time = this.now();
      this.starts.push(time);
      this.tokens.push({ at: time, value: estimatedTokens });
      this.active += 1;
    }
    async run(task, estimatedTokens = 0) {
      await this.acquire(estimatedTokens);
      try {
        return await task();
      } finally {
        this.active -= 1;
      }
    }
    get queuePressure() {
      this.prune();
      const rpm = this.options.maxRpm > 0 ? this.starts.length / this.options.maxRpm : 0;
      const tpm = this.options.maxTpm > 0 ? this.tokenUsed() / this.options.maxTpm : 0;
      return Math.max(rpm, tpm);
    }
  };

