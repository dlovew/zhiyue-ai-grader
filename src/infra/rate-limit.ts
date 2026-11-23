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
    async acquire(estimatedTokens) {
      for (; ; ) {
        this.prune();
        const rpmFull = this.starts.length >= this.options.maxRpm;
        const tpmFull = this.tokenUsed() + estimatedTokens > this.options.maxTpm;
        const concurrencyFull = this.active >= this.options.maxConcurrent;
        if (!rpmFull && !tpmFull && !concurrencyFull) break;
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

