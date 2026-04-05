function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ALLOWED_ROLES = [
  "Introduction",
  "Definition",
  "Explanation",
  "Example",
  "Comparison",
  "Application",
  "Summary"
];

const PRIMARY_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const BACKUP_MODEL = process.env.GROQ_BACKUP_MODEL || "llama-3.3-70b-versatile";
const MAX_SEGMENT_TEXT = Number(process.env.LESSON_SEGMENT_TEXT_LIMIT || 450);

function compactSegment(segment) {
  return {
    segmentId: Number(segment.segmentId),
    position: Number(segment.position),
    title: cleanText(segment.title || ""),
    text: cleanText(segment.text || "").slice(0, MAX_SEGMENT_TEXT),
    concept: cleanText(segment.concept || "")
  };
}

function inferRole(segment, index, total) {
  const title = cleanText(segment.title || "");
  const text = cleanText(segment.text || "");
  const combined = `${title}\n${text}`;
  const lowerTitle = title.toLowerCase();
  const lowerCombined = combined.toLowerCase();

  if (
    /what is|defined as|definition|refers to|means\b/.test(lowerCombined) ||
    /^what is\b/.test(lowerTitle)
  ) {
    return "Definition";
  }

  if (
    /compare|comparison|versus|vs\.?|difference|not the same|here'?s the difference|similarit/.test(lowerCombined)
  ) {
    return "Comparison";
  }

  if (
    /for example|for instance|such as|e\.g\.|examples?\b/.test(lowerCombined)
  ) {
    return "Example";
  }

  if (
    /application|in practice|real world|used in practice|practical/.test(lowerCombined)
  ) {
    return "Application";
  }

  if (
    /summary|conclusion|recap|overall|takeaway|wrap.?up/.test(lowerCombined) ||
    (index === total - 1 && /summary|conclusion|recap|overall|takeaway|wrap.?up/.test(lowerCombined))
  ) {
    return "Summary";
  }

  if (index === 0) {
    return "Introduction";
  }

  return "Explanation";
}

function normalizeMatchedRoles(aiSegments, originalSegments) {
  const originalById = new Map(
    originalSegments.map((segment) => [Number(segment.segmentId), segment])
  );
  const matchedById = new Map();

  for (const item of aiSegments || []) {
    const segmentId = Number(item?.segmentId);
    const role = cleanText(item?.role || "");
    const original = originalById.get(segmentId);

    if (!original) continue;
    if (!ALLOWED_ROLES.includes(role)) continue;

    matchedById.set(segmentId, { ...original, role });
  }

  return originalSegments.map((segment, index) => {
    const found = matchedById.get(segment.segmentId);
    const base = found || segment;

    return {
      ...base,
      role: inferRole(base, index, originalSegments.length)
    };
  });
}

function fallbackRoles(segments) {
  return segments.map((segment, index) => ({
    ...segment,
    role: inferRole(segment, index, segments.length)
  }));
}

function buildPrompt(documentTitle, segments) {
  return [
    "You are helping with STEP 4 ONLY of a demo lesson-ingestion pipeline.",
    "Task: assign exactly one teaching role to each segment.",
    "Return valid JSON only.",
    "",
    "Allowed roles only:",
    ...ALLOWED_ROLES.map((role) => `- ${role}`),
    "",
    "Rules:",
    "- Choose one main role only.",
    "- Use only the allowed role list.",
    "- Keep the original segmentId.",
    "- A 'What is ...' slide is usually Definition, even if it is early in the lesson.",
    "- A side-by-side distinction slide is usually Comparison.",
    "- A bridge or advanced slide is usually Explanation unless it truly fits another role better.",
    "",
    'Return JSON in this exact shape:',
    '{',
    '  "segments": [',
    '    { "segmentId": 1, "role": "Explanation" }',
    '  ]',
    '}',
    "",
    `Document title: ${documentTitle}`,
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

    if (!segments.length) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing segments." })
      };
    }

    const documentTitle = cleanText(document.title || "Untitled Document");
    const prompt = buildPrompt(documentTitle, segments);
    const warnings = [];

    for (const model of [PRIMARY_MODEL, BACKUP_MODEL]) {
      try {
        const aiSegments = await callGroq(model, prompt);
        const matchedSegments = normalizeMatchedRoles(aiSegments, segments);

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            debugVersion: "roles-v4",
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

    const matchedSegments = fallbackRoles(segments);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "roles-v4-fallback",
        document: { title: documentTitle },
        warning: "Used fallback role tagging.",
        warnings,
        segments: matchedSegments
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to assign roles.",
        details: error.message
      })
    };
  }
};