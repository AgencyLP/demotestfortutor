function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const PRIMARY_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const BACKUP_MODEL = process.env.GROQ_BACKUP_MODEL || "llama-3.3-70b-versatile";
const MAX_SEGMENT_TEXT = Number(process.env.LESSON_SEGMENT_TEXT_LIMIT || 450);

function compactSegment(segment) {
  return {
    segmentId: Number(segment.segmentId),
    position: Number(segment.position),
    title: cleanText(segment.title || ""),
    text: cleanText(segment.text || "").slice(0, MAX_SEGMENT_TEXT)
  };
}

function compactConcept(concept) {
  return {
    conceptId: Number(concept.conceptId),
    name: cleanText(concept.name || ""),
    description: cleanText(concept.description || "")
  };
}

function tokenize(value) {
  const stopwords = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
    "by", "is", "are", "was", "were", "be", "this", "that", "these", "those",
    "into", "from", "their", "than", "then", "also", "such", "using"
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

function titleBoost(segment, concept) {
  const segTitle = cleanText(segment.title || "").toLowerCase();
  const conceptName = cleanText(concept.name || "").toLowerCase();

  if (!segTitle || !conceptName) return 0;
  if (segTitle === conceptName) return 1.0;
  if (segTitle.includes(conceptName) || conceptName.includes(segTitle)) return 0.6;
  return 0;
}

function bestConceptForSegment(segment, concepts) {
  if (!concepts.length) return "";

  let best = concepts[0];
  let bestScore = -1;

  for (const concept of concepts) {
    const score =
      overlapScore(`${segment.title}\n${segment.text}`, `${concept.name}\n${concept.description}`) +
      titleBoost(segment, concept);

    if (score > bestScore) {
      best = concept;
      bestScore = score;
    }
  }

  return best.name;
}

function normalizeMatchedSegments(aiSegments, originalSegments, concepts) {
  const allowedConcepts = new Set(
    concepts.map((concept) => cleanText(concept.name).toLowerCase())
  );

  const originalById = new Map(
    originalSegments.map((segment) => [Number(segment.segmentId), segment])
  );

  const matchedById = new Map();

  for (const item of aiSegments || []) {
    const segmentId = Number(item?.segmentId);
    const concept = cleanText(item?.concept || "");
    const original = originalById.get(segmentId);

    if (!original) continue;
    if (!concept) continue;
    if (!allowedConcepts.has(concept.toLowerCase())) continue;

    matchedById.set(segmentId, {
      ...original,
      concept
    });
  }

  return originalSegments.map((segment) => {
    const found = matchedById.get(segment.segmentId);
    if (found) return found;

    return {
      ...segment,
      concept: bestConceptForSegment(segment, concepts)
    };
  });
}

function fallbackMatchedSegments(segments, concepts) {
  return segments.map((segment) => ({
    ...segment,
    concept: bestConceptForSegment(segment, concepts)
  }));
}

function buildPrompt(documentTitle, segments, concepts) {
  return `
You are helping with STEP 3 ONLY of a demo lesson-ingestion pipeline.

Task:
Assign exactly one main concept to each segment using only the provided concept list.

Rules:
- Use ONLY concepts from the provided list.
- Do NOT invent a new concept.
- Choose ONE main concept only for each segment.
- Match based on the segment's main teaching focus.
- If a segment contains multiple examples or named cases, prefer the broader concept if that better reflects the whole segment.
- Avoid matching a segment to a concept that is only one sub-example inside that segment.
- Keep the original segmentId.
- Return JSON only.

Return JSON in this exact shape:
{
  "segments": [
    {
      "segmentId": 1,
      "concept": "Concept name from the provided list"
    }
  ]
}

Document title: ${documentTitle}

Concepts:
${JSON.stringify(concepts.map(compactConcept))}

Segments:
${JSON.stringify(segments.map(compactSegment))}
`.trim();
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

    if (!concepts.length) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing concepts." })
      };
    }

    const documentTitle = cleanText(document.title || "Untitled Document");
    const prompt = buildPrompt(documentTitle, segments, concepts);
    const warnings = [];

    for (const model of [PRIMARY_MODEL, BACKUP_MODEL]) {
      try {
        const aiSegments = await callGroq(model, prompt);
        const matchedSegments = normalizeMatchedSegments(aiSegments, segments, concepts);

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            debugVersion: "match-concepts-v3",
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

    const matchedSegments = fallbackMatchedSegments(segments, concepts);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "match-concepts-v3-fallback",
        document: { title: documentTitle },
        warning: "Groq limit hit or concept matching failed. Used fallback matching.",
        warnings,
        segments: matchedSegments
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to match concepts.",
        details: error.message
      })
    };
  }
};