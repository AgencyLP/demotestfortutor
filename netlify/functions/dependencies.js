function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const PRIMARY_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const BACKUP_MODEL = process.env.GROQ_BACKUP_MODEL || "llama3-8b-8192";
const MAX_SEGMENT_TEXT = Number(process.env.LESSON_SEGMENT_TEXT_LIMIT || 400);

function compactSegment(segment) {
  return {
    segmentId: Number(segment.segmentId),
    position: Number(segment.position),
    title: cleanText(segment.title || ""),
    text: cleanText(segment.text || "").slice(0, MAX_SEGMENT_TEXT),
    concept: cleanText(segment.concept || ""),
    role: cleanText(segment.role || "")
  };
}

function normalizeMatchedDependencies(aiSegments, originalSegments) {
  const originalById = new Map(
    originalSegments.map((segment) => [Number(segment.segmentId), segment])
  );
  const normalizedById = new Map();

  for (const item of aiSegments || []) {
    const segmentId = Number(item?.segmentId);
    const original = originalById.get(segmentId);
    if (!original) continue;

    let dependsOn = Array.isArray(item?.dependsOn) ? item.dependsOn : [];
    dependsOn = dependsOn
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
      .filter((value) => value < segmentId);

    normalizedById.set(segmentId, {
      ...original,
      dependsOn: [...new Set(dependsOn)].sort((a, b) => a - b)
    });
  }

  return originalSegments.map((segment, index) => {
    const found = normalizedById.get(segment.segmentId);
    if (found) return found;

    return {
      ...segment,
      dependsOn: inferDependencyForSegment(originalSegments, index)
    };
  });
}

function inferDependencyForSegment(segments, index) {
  const segment = segments[index];
  if (!segment || index === 0) return [];

  const role = cleanText(segment.role || "");
  const concept = cleanText(segment.concept || "");

  if (role === "Introduction" || role === "Definition") return [];

  const prevSameConcept = [...segments]
    .slice(0, index)
    .reverse()
    .find((item) => cleanText(item.concept || "") === concept);

  if (role === "Example" || role === "Application" || role === "Summary") {
    if (prevSameConcept) return [prevSameConcept.segmentId];
  }

  if (role === "Comparison") {
    const recent = segments
      .slice(Math.max(0, index - 2), index)
      .map((item) => item.segmentId);
    return [...new Set(recent)];
  }

  if (prevSameConcept) return [prevSameConcept.segmentId];

  return [segments[index - 1].segmentId];
}

function fallbackDependencies(segments) {
  return segments.map((segment, index) => ({
    ...segment,
    dependsOn: inferDependencyForSegment(segments, index)
  }));
}

function buildPrompt(documentTitle, segments, concepts) {
  return [
    "You are helping with STEP 5 ONLY of a demo lesson-ingestion pipeline.",
    "Task: decide which earlier segments each segment depends on.",
    "Return valid JSON only.",
    "",
    "Rules:",
    "- Use only earlier segmentIds, never later ones.",
    "- Return only direct, necessary dependencies.",
    "- Keep dependency lists small.",
    "- Introduction and Definition often have no dependency.",
    "- Explanation often depends on an earlier Introduction or Definition.",
    "- Example often depends on the thing being explained first.",
    "- Summary often depends on earlier segments.",
    "- Do not invent segmentIds.",
    "",
    'Return JSON in this exact shape:',
    '{',
    '  "segments": [',
    '    { "segmentId": 1, "dependsOn": [] }',
    '  ]',
    '}',
    "",
    `Document title: ${documentTitle}`,
    `Concepts: ${JSON.stringify((concepts || []).map((c) => ({ name: cleanText(c.name || "") })))}`,
    `Segments: ${JSON.stringify(segments.map(compactSegment))}`
  ].join("\n");
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

  const parsed = JSON.parse(content);
  return Array.isArray(parsed.segments) ? parsed.segments : [];
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
    const segments = Array.isArray(body.segments) ? body.segments : [];
    const concepts = Array.isArray(body.concepts) ? body.concepts : [];

    if (!segments.length) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing segments." })
      };
    }

    const documentTitle = cleanText(document.title || "Untitled Document");
    const prompt = buildPrompt(documentTitle, segments, concepts);
    const warnings = [];

    for (const model of [PRIMARY_MODEL, BACKUP_MODEL]) {
      try {
        const aiSegments = await callGroq(model, prompt);
        const matchedSegments = normalizeMatchedDependencies(aiSegments, segments);

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            debugVersion: "dependencies-v2",
            document: { title: documentTitle },
            model,
            warnings,
            segments: matchedSegments
          })
        };
      } catch (error) {
        warnings.push(error.message);

        const isRateLimited =
          error.statusCode === 429 ||
          /rate limit|tokens per day|rate_limit_exceeded/i.test(error.message);

        if (!isRateLimited) break;
      }
    }

    const matchedSegments = fallbackDependencies(segments);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "dependencies-v2-fallback",
        document: { title: documentTitle },
        warning: "Used fallback dependency tagging.",
        warnings,
        segments: matchedSegments
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to assign dependencies.",
        details: error.message
      })
    };
  }
};