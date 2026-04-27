function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const TEACH_MODEL = process.env.GROQ_TEACH_MODEL || "openai/gpt-oss-20b";
const BACKUP_MODEL = process.env.GROQ_TEACH_BACKUP_MODEL || process.env.GROQ_MODEL || "llama-3.1-8b-instant";

function tokenize(value) {
  const stopwords = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
    "by", "is", "are", "was", "were", "be", "this", "that", "these", "those",
    "it", "its", "as", "at", "from", "into", "than", "then", "also", "about"
  ]);

  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token && token.length > 2 && !stopwords.has(token));
}

function overlapScore(a, b) {
  const aSet = new Set(tokenize(a));
  const bSet = new Set(tokenize(b));
  if (!aSet.size || !bSet.size) return 0;

  let overlap = 0;
  for (const token of aSet) {
    if (bSet.has(token)) overlap += 1;
  }

  return overlap / Math.max(1, Math.min(aSet.size, bSet.size));
}

function fallbackEvaluation(payload) {
  const stage = cleanText(payload.stage || "check");
  const answer = cleanText(payload.learnerAnswer || "");
  const expected = cleanText(payload.expectedUnderstanding || "");
  const score = overlapScore(answer, expected);

  let result = "wrong";
  if (stage === "probe") {
    result = score >= 0.55 ? "strong" : score >= 0.2 ? "partial" : "beginner";
  } else if (score >= 0.55) {
    result = "correct";
  } else if (score >= 0.2) {
    result = "partial";
  }

  const feedbackByResult = {
    strong: "Good, you already have the main idea. I can move faster and add a little depth.",
    partial: "You have part of it. I will keep what is right and fill in the missing piece.",
    beginner: "No problem. I will start from the basics and build it step by step.",
    correct: "Yes, that shows the main idea.",
    wrong: "Not quite yet. The key idea is different, so I will explain it another way."
  };

  return {
    debugVersion: "teach-evaluate-v1-fallback",
    stage,
    result,
    diagnosis: score > 0
      ? "The answer overlaps with the expected idea, but the fallback evaluator cannot deeply judge reasoning."
      : "The answer does not mention enough of the expected idea.",
    feedback: feedbackByResult[result] || feedbackByResult.partial,
    nextTutorMove: result === "wrong"
      ? "Use a different teaching move and ask a simpler follow-up."
      : "Continue to the next teaching step.",
    warning: "Used fallback evaluation because Groq was unavailable or rate-limited."
  };
}

function buildPrompt(payload) {
  return `
You are the evaluator for a small AI tutor demo.

Judge the learner answer and decide what the tutor should do next.
Be kind, short, and specific.

Stage rules:
- If stage is "probe", result must be beginner, partial, or strong.
- If stage is "check", "apply", or "summary", result must be correct, partial, or wrong.

Probe feedback rules:
- If the learner has a misconception, directly name and correct it in friendly language.
- Make the feedback a bridge into teaching, not a quiz question.
- Do not end probe feedback with a question.
- Example: "Good thought. Soil helps plants grow, but it is not the food plants make. In photosynthesis, the plant makes glucose using sunlight, water, and carbon dioxide."

Probe classification rubric:
- beginner: no answer, "I don't know", a wrong mental model, a confused concept, or a major misconception.
- partial: at least one correct core piece, but important pieces are missing or vague.
- strong: the main idea is basically correct and includes the key mechanism or key parts.
- If an answer contains one correct piece plus a major misconception, choose beginner, not partial.
- If the learner only names one correct part with no wrong idea, choose partial.

Teaching moves available:
- ground: connect to familiar experience
- build-incrementally: explain one step at a time
- contrast: show what the idea is not
- make-concrete: give a small example

Return JSON only:
{
  "stage": "probe | check | apply | summary",
  "result": "beginner | partial | strong | correct | wrong",
  "diagnosis": "What the learner understands or misses",
  "feedback": "What the tutor should say to the learner",
  "nextTutorMove": "What the tutor should do next"
}

Context:
${JSON.stringify({
    stage: payload.stage,
    chunkTitle: payload.teachPlan?.chunkTitle,
    objective: payload.teachPlan?.objective,
    question: payload.question,
    expectedUnderstanding: payload.expectedUnderstanding,
    learnerAnswer: payload.learnerAnswer
  })}
`.trim();
}

function normalizeResultForStage(stage, result) {
  const cleanStage = cleanText(stage || "check");
  const cleanResult = cleanText(result || "").toLowerCase();

  if (cleanStage === "probe") {
    if (["beginner", "partial", "strong"].includes(cleanResult)) return cleanResult;
    if (cleanResult === "correct") return "strong";
    if (cleanResult === "wrong") return "beginner";
    return "partial";
  }

  if (["correct", "partial", "wrong"].includes(cleanResult)) return cleanResult;
  if (cleanResult === "beginner") return "wrong";
  if (cleanResult === "strong") return "correct";
  return "partial";
}

async function callGroq(model, prompt) {
  const apiKey = process.env.GROQ_KEY;
  if (!apiKey) throw new Error("Missing GROQ_KEY environment variable.");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 350,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return valid JSON only." },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`Groq error (${model}): ${errorText}`);
    error.statusCode = response.status;
    throw error;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Groq returned empty content for ${model}.`);

  return JSON.parse(content);
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Method not allowed." })
      };
    }

    const payload = JSON.parse(event.body || "{}");
    const learnerAnswer = cleanText(payload.learnerAnswer || "");

    if (!learnerAnswer) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing learner answer." })
      };
    }

    const prompt = buildPrompt(payload);
    const warnings = [];

    for (const model of [TEACH_MODEL, BACKUP_MODEL]) {
      if (warnings.some((warning) => warning.includes(`Groq error (${model})`))) {
        continue;
      }

      try {
        const evaluation = await callGroq(model, prompt);

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            debugVersion: "teach-evaluate-v1",
            stage: cleanText(evaluation.stage || payload.stage || "check"),
            result: normalizeResultForStage(payload.stage, evaluation.result),
            diagnosis: cleanText(evaluation.diagnosis || ""),
            feedback: cleanText(evaluation.feedback || ""),
            nextTutorMove: cleanText(evaluation.nextTutorMove || ""),
            model,
            warnings
          })
        };
      } catch (error) {
        warnings.push(error.message);
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...fallbackEvaluation(payload),
        warnings
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to evaluate learner answer.",
        details: error.message
      })
    };
  }
};