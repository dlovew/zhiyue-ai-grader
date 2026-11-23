  // src/core/prompt.ts
  var PROMPT_VERSION = "zygr-prompt-v3-vlm";
  function clip(text, max) {
    const value = String(text ?? "").trim();
    if (!value) return "\uFF08\u65E0\uFF09";
    return value.length > max ? `${value.slice(0, max)}
\u2026\u2026\uFF08\u5185\u5BB9\u5DF2\u622A\u65AD\uFF09` : value;
  }
  function subQuestionLines(question) {
    if (question.subQuestions.length === 0) return "\uFF08\u65E0\u5206\u5C0F\u9898\u4FE1\u606F\uFF09";
    return question.subQuestions.map((item) => `- ${item.label}\uFF1A\u6EE1\u5206 ${item.maxScore > 0 ? item.maxScore : "\u672A\u6307\u5B9A"}`).join("\n");
  }
  function maxScoreLine(context, question) {
    const max = context.maxScore > 0 ? context.maxScore : question.maxScore;
    return max > 0 ? `\u6EE1\u5206 ${max} \u5206` : "\u6EE1\u5206\u672A\u6307\u5B9A\uFF0C\u6309\u5E38\u89C4\u5224\u65AD";
  }
  function buildGradingPrompt(question, context, options) {
    const answer = "\u3010\u5B66\u751F\u4F5C\u7B54\u3011\n\u89C1\u968F\u9644\u56FE\u7247\uFF0C\u6309\u56FE\u7247\u5185\u5BB9\u5224\u65AD";
    const sections = [
      "\u4F60\u662F\u9605\u5377\u52A9\u624B\u3002\u53EA\u4F9D\u636E\u7ED9\u5B9A\u5185\u5BB9\u4E0E\u968F\u9644\u56FE\u7247\u8BC4\u5206\uFF0C\u4E0D\u8981\u81C6\u6D4B\u3002",
      "\u4E25\u683C\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981 Markdown \u4EE3\u7801\u5757\uFF0C\u4E0D\u8981\u989D\u5916\u89E3\u91CA\u3002",
      "\u5B57\u6BB5\uFF1Astatus\uFF08legible/partial/illegible/blank\uFF09\u3001score\uFF08\u6570\u5B57\uFF09\u3001subScores\uFF08\u6570\u7EC4\uFF1Alabel/score/maxScore/reason\uFF09\u3001reason\uFF08\u4E0D\u8D85\u8FC7 80 \u5B57\uFF09\u3001confidence\uFF080 \u5230 1\uFF09\u3002",
      "\u89C4\u5219\uFF1A\u672A\u4F5C\u7B54\u4E0D\u5F97\u7ED9\u6B63\u5206\uFF1B\u5212\u53BB\u7684\u5185\u5BB9\u4E0D\u8BA1\u5206\uFF1B\u7B49\u4EF7\u89E3\u6CD5\u5E94\u7ED9\u5206\uFF1B\u5206\u6570\u4E0D\u5F97\u8D85\u8FC7\u6EE1\u5206\uFF1B\u65E0\u6CD5\u8FA8\u8BA4\u65F6\u7ED9\u51FA legible/partial/illegible \u5E76\u8BF4\u660E\u3002",
      question.subQuestions.length > 0 ? "\u8BF7\u9010\u9879\u7ED9\u51FA subScores\uFF0Clabel \u5FC5\u987B\u4E0E\u8F93\u5165\u5C0F\u9898\u4E00\u81F4\uFF1B\u603B\u5206\u987B\u7B49\u4E8E\u5404\u5C0F\u9898\u5F97\u5206\u4E4B\u548C\u3002" : "subScores \u8FD4\u56DE\u7A7A\u6570\u7EC4\u5373\u53EF\u3002",
      "===== \u8F93\u5165 =====",
      `\u3010\u9898\u76EE\u3011
${clip(context.question || question.questionText, 6e3)}`,
      `\u3010\u53C2\u8003\u7B54\u6848\u3011
${clip(context.answer, 6e3)}`,
      `\u3010\u8BC4\u5206\u6807\u51C6\u3011
${clip(context.rubric, 6e3)}`,
      `\u3010\u5206\u503C\u3011
${maxScoreLine(context, question)}`,
      `\u3010\u5C0F\u9898\u3011
${subQuestionLines(question)}`,
      answer,
      "\u6CE8\u610F\uFF1A\u968F\u9644\u56FE\u7247\u4EC5\u4E3A\u672C\u6B21\u5B66\u751F\u4F5C\u7B54\uFF0C\u7B54\u5377\u4E0A\u7684\u5370\u5237\u9898\u5E72\u4E0D\u5C5E\u4E8E\u5B66\u751F\u4F5C\u7B54\u3002",
      options.removedImages && options.removedImages > 0 ? `\u3010\u56FE\u7247\u8BF4\u660E\u3011\u5DF2\u5254\u9664 ${options.removedImages} \u5F20\u5E9F\u56FE\uFF0C\u8BF7\u57FA\u4E8E\u5269\u4F59\u56FE\u7247\u8BC4\u5224\u3002` : "",
      "===== \u8F93\u51FA =====",
      "\u53EA\u8F93\u51FA JSON\u3002"
    ];
    return sections.filter(Boolean).join("\n\n");
  }
