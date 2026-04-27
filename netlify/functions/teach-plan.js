function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const PRIMARY_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const BACKUP_MODEL = process.env.GROQ_BACKUP_MODEL || "llama-3.1-8b-instant";
const MAX_CONTEXT_TEXT = Number(process.env.TEACH_PLAN_TEXT_LIMIT || 1100);

function segmentTextForChunk(chunk, segments) {
  const ids = new Set((chunk.segmentIds || []).map((id) => Number(id)));

  return segments
    .filter((segment) => ids.has(Number(segment.segmentId)))
    .map((segment) => {
      const title = cleanText(segment.title || `Segment ${segment.segmentId}`);
      const text = cleanText(segment.text || "");
      return `${title}\n${text}`;
    })
    .join("\n\n")
    .slice(0, MAX_CONTEXT_TEXT);
}

function fallbackTeachPlan(document, chunk, segments) {
  const concept = cleanText(chunk.mainConcept || chunk.title || "this topic");
  const sourceText = segmentTextForChunk(chunk, segments);
  const shortSource = sourceText.split(/\n+/).filter(Boolean).slice(0, 4).join(" ");
  const chunkTitle = cleanText(chunk.title || "");
  const firstUsefulLine = sourceText
    .split(/\n+/)
    .map((line) => cleanText(line))
    .find((line) =>
      wordLike(line) &&
      line !== chunkTitle &&
      !/^what\s+(is|are)\b/i.test(line)
    ) || concept;

  return {
    debugVersion: "teach-plan-v1-fallback",
    document: {
      title: cleanText(document.title || "Untitled Document")
    },
    chunkId: Number(chunk.chunkId),
    chunkTitle: chunkTitle || concept,
    chunkType: cleanText(chunk.chunkType || "standard"),
    objective: `Understand ${concept} well enough to explain the main idea and use it in a simple example.`,
    orient: `Today we are going to learn ${concept}. This matters because it is one of the key ideas in this part of the lesson. By the end, you should be able to explain the main idea in your own words.`,
    probeQuestion: `What do you already know about ${concept}?`,
    startingRoutes: {
      beginner: "Use the simple explanation and go slowly.",
      partial: "Acknowledge what is correct, then fill the missing part.",
      strong: "Confirm the idea quickly and move to the application task."
    },
    subIdeas: [
      {
        title: concept,
        levelPaths: {
          beginner: {
            teach: `Start simply: ${shortSource || `Explain ${concept} in everyday language.`}`,
            teachOrder: [
              {
                move: "ground",
                text: `When you learn any process, it helps to ask what goes in, what changes, and what comes out. ${concept} is easier when you look for those parts instead of trying to memorize the name.`
              },
              {
                move: "incremental",
                text: shortSource || `The main idea is ${concept}. We can understand it by breaking it into smaller pieces.`
              },
              {
                move: "concrete",
                text: `Here is a simple example from this chunk: ${firstUsefulLine}`
              },
              {
                move: "contrast",
                text: `${concept} is not just a label to repeat. The important part is knowing what happens, what result it creates, and why that result matters.`
              }
            ],
            check: `What is one important thing to remember about ${concept}?`
          },
          partial: {
            teach: `Build on what the learner knows, then fill the missing part: ${shortSource || concept}`,
            check: `What missing detail completes the idea of ${concept}?`
          },
          strong: {
            teach: `Move faster and add a useful distinction or application: ${shortSource || concept}`,
            check: `How would you apply ${concept} in a slightly different example?`
          }
        },
        misconceptionToWatchFor: "The learner may repeat words from the lesson without showing that they can use the idea."
      }
    ],
    applyTasks: {
      beginner: `Use this guided frame: ${concept} is about ___. One important part is ___.`,
      partial: `Use ${concept} in one short example from the lesson. Include the missing detail you just learned.`,
      strong: `Apply ${concept} to a new but similar situation and explain your reasoning.`
    },
    consolidatePrompt: "Summarize what the learner understood, mention any mistake that was corrected, and say what they can now do.",
    warning: "Used fallback teach plan because Groq was unavailable or rate-limited."
  };
}

function compactPayload(document, chunk, segments, concepts) {
  const chunkConcept = cleanText(chunk.mainConcept || "");
  const relatedConcept = (concepts || []).find(
    (concept) => cleanText(concept.name || "") === chunkConcept
  );

  return {
    documentTitle: cleanText(document.title || "Untitled Document"),
    chunk: {
      chunkId: Number(chunk.chunkId),
      title: cleanText(chunk.title || ""),
      chunkType: cleanText(chunk.chunkType || "standard"),
      mainConcept: chunkConcept,
      secondaryConcept: cleanText(chunk.secondaryConcept || ""),
      dependsOn: Array.isArray(chunk.dependsOn) ? chunk.dependsOn : []
    },
    concept: relatedConcept
      ? {
          name: cleanText(relatedConcept.name || ""),
          description: cleanText(relatedConcept.description || "")
        }
      : null,
    sourceText: segmentTextForChunk(chunk, segments)
  };
}

function wordLike(text) {
  return /[A-Za-z]{3,}/.test(cleanText(text));
}

function buildPrompt(document, chunk, segments, concepts) {
  const payload = compactPayload(document, chunk, segments, concepts);

  return `
You are generating ONE small teach plan for an AI tutor demo.

Use the lesson chunk below. Keep the output short and practical.

Teaching model:
- Orient: introduce the topic, why it matters, and what the learner should be able to do.
- Probe: ask one short open question to find the learner's starting level.
- Teach: break the chunk into 1-2 sub-ideas.
- Check: ask one useful question per sub-idea after teaching.
- Apply: ask the learner to use the idea in a simple scenario.

Use these teaching moves where useful:
- ground: connect to something familiar
- build-incrementally: one step at a time
- contrast: show what the idea is NOT or what it is commonly confused with
- make-concrete: give a small concrete example

Free-plan constraint:
- Return only a compact JSON object.
- Use at most 2 subIdeas.
- Keep beginner teach under 150 words.
- Keep partial and strong teach under 110 words.

Important teaching quality rules:
- Do not make teaching feel like a rapid quiz.
- Each teach field must explain before asking.
- Write actual tutor messages, not instructions to the tutor.
- Bad: "Connect this to something familiar."
- Good: "Think of this like a small kitchen: ingredients go in, and something useful comes out."
- Orient must be 2-3 short sentences: topic, why it matters, and what the learner should be able to do.
- Probe must be one open question under 16 words. It should not sound like a quiz.
- Beginner path: warm, slow, concrete, no assumed knowledge. Use 3-5 short sentences. Name the learner's likely misconception if the source suggests one. Explain the parts before asking.
- Partial path: acknowledge what the learner probably knows, then fill the missing gap. Use 2-4 short sentences.
- Strong path: move faster, add nuance, contrast, or a transfer example. Use 2-4 short sentences.
- For beginner only, create teachOrder with exactly 4 moves in this order: ground, incremental, concrete, contrast.
- Ground must connect the concept to everyday knowledge or a familiar experience that genuinely fits the topic. Do not use a random analogy. Make the mapping clear in 2-3 short sentences, 35-60 words.
- Incremental must build the idea one piece at a time in 2-3 short sentences, 35-65 words.
- Concrete must give a tiny subject-specific scenario or application, not a restatement, in 1-2 short sentences, 25-45 words.
- Contrast must correct a likely confusion or boundary in 1-2 short sentences, 25-45 words.
- The beginner check must come after all 4 teaching moves and should test the exact ideas taught.
- Beginner contrast should correct the most likely confusion from the chunk, not introduce a random advanced comparison.
- If no obvious comparison is needed, contrast "what helps the process" vs "what the actual result is."
- Check questions should match the path difficulty.
- Beginner check should ask for one simple piece or a short list that was just taught. Keep it under 18 words.
- Partial check should target the missing piece.
- Strong check should test why/how or transfer.
- Apply tasks should also match the learner level.
- Beginner apply must be scaffolded: one sentence frame, fill-in-the-blanks, or guided scenario with clear parts to include.
- Partial apply should be one short scenario with one reminder.
- Strong apply should be one open-ended transfer task.

Return JSON only in this exact shape:
{
  "chunkId": 1,
  "chunkTitle": "Title",
  "chunkType": "standard | bridge | level-up",
  "objective": "One sentence ability goal",
  "orient": "2-3 short tutor sentences: topic, why it matters, ability goal",
  "probeQuestion": "One open question under 16 words",
  "startingRoutes": {
    "beginner": "What the tutor should do",
    "partial": "What the tutor should do",
    "strong": "What the tutor should do"
  },
  "subIdeas": [
    {
      "title": "Sub idea title",
      "levelPaths": {
        "beginner": {
          "teach": "Warm step-by-step explanation. Start from basics, use a concrete example, and clearly separate inputs/parts from outputs/results when relevant.",
          "teachOrder": [
            { "move": "ground", "text": "Actual learner-facing tutor message" },
            { "move": "incremental", "text": "Actual learner-facing tutor message" },
            { "move": "concrete", "text": "Actual learner-facing tutor message with tiny application" },
            { "move": "contrast", "text": "Actual learner-facing tutor message" }
          ],
          "check": "Easy question about the exact idea just taught"
        },
        "partial": {
          "teach": "Gap-filling explanation that builds on partial knowledge",
          "check": "Targeted check question"
        },
        "strong": {
          "teach": "Faster explanation with nuance, contrast, or transfer",
          "check": "Harder thinking question"
        }
      },
      "misconceptionToWatchFor": "Likely mistake"
    }
  ],
  "applyTasks": {
    "beginner": "Guided fill-in or sentence-frame task",
    "partial": "Short scenario task with a small scaffold",
    "strong": "Open-ended transfer task"
  },
  "consolidatePrompt": "Instruction for final summary"
}

Lesson chunk:
${JSON.stringify(payload)}
`.trim();
}

function normalizePlan(plan, document, chunk, segments) {
  const fallback = fallbackTeachPlan(document, chunk, segments);
  const subIdeas = Array.isArray(plan?.subIdeas) ? plan.subIdeas.slice(0, 2) : [];

  const looksLikePlaceholderInstruction = (text) => {
    const value = cleanText(text).toLowerCase();
    return /^(connect|build|give|show|clarify|explain|use)\b/.test(value) &&
      /(familiar|example|confus|learner|tutor|idea|before defining)/.test(value);
  };

  const normalizeTeachOrder = (order, fallbackOrder) => {
    const source = Array.isArray(order) && order.length ? order : fallbackOrder;
    return (source || [])
      .slice(0, 4)
      .map((item, index) => {
        const fallbackItem = fallbackOrder?.[index] || {};
        const text = cleanText(item?.text || "");
        return {
          move: cleanText(item?.move || fallbackItem.move || ""),
          text: looksLikePlaceholderInstruction(text)
            ? cleanText(fallbackItem.text || text)
            : text
        };
      })
      .filter((item) => item.move && item.text);
  };

  const normalizeLevelPath = (path, fallbackPath, includeTeachOrder = false) => {
    const normalized = {
      teach: cleanText(path?.teach || fallbackPath?.teach || fallback.subIdeas[0].levelPaths.beginner.teach),
      check: cleanText(path?.check || fallbackPath?.check || fallback.subIdeas[0].levelPaths.beginner.check)
    };

    if (includeTeachOrder) {
      normalized.teachOrder = normalizeTeachOrder(path?.teachOrder, fallbackPath?.teachOrder);
    }

    return normalized;
  };

  return {
    debugVersion: "teach-plan-v1",
    document: fallback.document,
    chunkId: Number(plan?.chunkId || chunk.chunkId),
    chunkTitle: cleanText(plan?.chunkTitle || chunk.title || fallback.chunkTitle),
    chunkType: cleanText(plan?.chunkType || chunk.chunkType || "standard"),
    objective: cleanText(plan?.objective || fallback.objective),
    orient: cleanText(plan?.orient || fallback.orient),
    probeQuestion: cleanText(plan?.probeQuestion || fallback.probeQuestion),
    startingRoutes: {
      beginner: cleanText(plan?.startingRoutes?.beginner || fallback.startingRoutes.beginner),
      partial: cleanText(plan?.startingRoutes?.partial || fallback.startingRoutes.partial),
      strong: cleanText(plan?.startingRoutes?.strong || fallback.startingRoutes.strong)
    },
    subIdeas: subIdeas.length
      ? subIdeas.map((item, index) => ({
          title: cleanText(item?.title || `Sub-idea ${index + 1}`),
          levelPaths: {
            beginner: normalizeLevelPath(
              item?.levelPaths?.beginner,
              fallback.subIdeas[0].levelPaths.beginner,
              true
            ),
            partial: normalizeLevelPath(
              item?.levelPaths?.partial,
              fallback.subIdeas[0].levelPaths.partial
            ),
            strong: normalizeLevelPath(
              item?.levelPaths?.strong,
              fallback.subIdeas[0].levelPaths.strong
            )
          },
          misconceptionToWatchFor: cleanText(
            item?.misconceptionToWatchFor || fallback.subIdeas[0].misconceptionToWatchFor
          )
        }))
      : fallback.subIdeas,
    applyTasks: {
      beginner: cleanText(plan?.applyTasks?.beginner || plan?.applyTask || fallback.applyTasks.beginner),
      partial: cleanText(plan?.applyTasks?.partial || plan?.applyTask || fallback.applyTasks.partial),
      strong: cleanText(plan?.applyTasks?.strong || plan?.applyTask || fallback.applyTasks.strong)
    },
    consolidatePrompt: cleanText(plan?.consolidatePrompt || fallback.consolidatePrompt)
  };
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
      temperature: 0.2,
      max_tokens: 1100,
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

    const body = JSON.parse(event.body || "{}");
    const document = body.document || {};
    const chunk = body.chunk || {};
    const segments = Array.isArray(body.segments) ? body.segments : [];
    const concepts = Array.isArray(body.concepts) ? body.concepts : [];

    if (!chunk.chunkId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing selected chunk." })
      };
    }

    if (!segments.length) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing segments." })
      };
    }

    const prompt = buildPrompt(document, chunk, segments, concepts);
    const warnings = [];

    for (const model of [PRIMARY_MODEL, BACKUP_MODEL]) {
      if (warnings.some((warning) => warning.includes(`Groq error (${model})`))) {
        continue;
      }

      try {
        const plan = await callGroq(model, prompt);
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...normalizePlan(plan, document, chunk, segments),
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
        ...fallbackTeachPlan(document, chunk, segments),
        warnings
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to generate teach plan.",
        details: error.message
      })
    };
  }
};