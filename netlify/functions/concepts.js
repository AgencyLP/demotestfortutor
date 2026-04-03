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
const MAX_SEGMENT_TEXT = Number(process.env.LESSON_SEGMENT_TEXT_LIMIT || 420);
const MAX_CONCEPT_DESC = 160;
const MAX_CONCEPTS_CAP = Number(process.env.LESSON_MAX_CONCEPTS || 8);

const META_TITLE_PATTERNS = [
  /^agenda$/i,
  /^outline$/i,
  /^overview$/i,
  /^contents?$/i,
  /^objectives?$/i,
  /^(learning\s+)?objectives?$/i,
  /^today['’]?s?\s+topics?$/i,
  /^summary$/i,
  /^recap$/i,
  /^review$/i,
  /^(q\s*&\s*a|questions?)$/i,
  /^thank\s+you$/i,
  /^references?$/i,
  /^appendix$/i,
  /^welcome$/i
];

function isMetaHeading(title) {
  const value = cleanText(title).replace(/[:\-–—.!]+$/g, "").trim();
  if (!value) return true;
  return META_TITLE_PATTERNS.some((pattern) => pattern.test(value));
}

function tokenize(value) {
  const stopwords = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
    "by", "is", "are", "was", "were", "be", "this", "that", "these", "those",
    "their", "from", "into", "than", "then", "also", "such", "using", "about"
  ]);

  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s&]/g, " ")
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

function normalizeTitleToConcept(title) {
  let value = cleanText(title || "");
  if (!value) return "";

  value = value
    .replace(/^what(?:'s| is)\s+/i, "")
    .replace(/^what are\s+/i, "")
    .replace(/^types of\s+/i, "Types of ")
    .replace(/^kinds of\s+/i, "Types of ")
    .replace(/^role of\s+/i, "Role of ")
    .replace(/[?]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function chooseBestTitleSeed(segment) {
  const rawTitle = cleanText(segment.title || "");
  if (rawTitle && !isMetaHeading(rawTitle)) {
    const normalized = normalizeTitleToConcept(rawTitle);
    if (normalized) return normalized;
  }
  return rawTitle || `Concept ${segment.segmentId}`;
}

function fallbackConceptsFromSegments(segments, maxConcepts) {
  const concepts = [];
  const seen = new Set();

  for (const segment of segments) {
    if (concepts.length >= maxConcepts) break;

    const name = chooseBestTitleSeed(segment);
    const description = cleanText(segment.text || "").slice(0, MAX_CONCEPT_DESC);
    const key = name.toLowerCase();

    if (!name || !description || seen.has(key) || isMetaHeading(name)) continue;

    concepts.push({
      conceptId: concepts.length + 1,
      name,
      description
    });

    seen.add(key);
  }

  if (!concepts.length) {
    concepts.push({
      conceptId: 1,
      name: "Main Concept",
      description: "Primary topic of the document."
    });
  }

  return concepts;
}

function compactSegmentsForPrompt(segments) {
  return segments.map((segment) => ({
    segmentId: Number(segment.segmentId),
    position: Number(segment.position),
    source: Number(segment.source),
    title: cleanText(segment.title || `Segment ${segment.segmentId}`),
    text: cleanText(segment.text || "").slice(0, MAX_SEGMENT_TEXT)
  }));
}

function normalizeConcepts(aiConcepts, segments, maxConcepts) {
  const fallback = fallbackConceptsFromSegments(segments, maxConcepts);
  const concepts = [];
  const seen = new Set();

  for (const item of aiConcepts || []) {
    const name = cleanText(item?.name || "");
    const description = cleanText(item?.description || "").slice(0, MAX_CONCEPT_DESC);
    const key = name.toLowerCase();

    if (!name || !description || seen.has(key)) continue;
    if (isMetaHeading(name)) continue;
    if (concepts.length >= maxConcepts) break;

    concepts.push({
      conceptId: concepts.length + 1,
      name,
      description
    });

    seen.add(key);
  }

  for (const item of fallback) {
    if (concepts.length >= maxConcepts) break;
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;

    concepts.push({
      conceptId: concepts.length + 1,
      name: item.name,
      description: item.description
    });

    seen.add(key);
  }

  return concepts;
}

function buildPrompt(documentTitle, segments, maxConcepts) {
  return `
You are helping with STEP 2 ONLY of a demo AI tutor ingestion pipeline.

Task:
Given a document title and a list of already segmented lesson segments, identify the main teachable concepts.

Rules:
- Return between 1 and ${maxConcepts} concepts.
- Keep the concept list small, clear, teachable, distinct, and non-overlapping.
- Use wording close to actual segment topics.
- Do not use meta headings such as objectives, agenda, overview, recap, welcome, Q&A, or thank you as concept names.
- Return JSON only.

Return JSON in this exact shape:
{
  "concepts": [
    {
      "name": "Concept name",
      "description": "Short description of the concept."
    }
  ]
}

Document title: ${documentTitle}

Segments:
${JSON.stringify(compactSegmentsForPrompt(segments))}
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
      max_tokens: 900,
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
  return Array.isArray(parsed.concepts) ? parsed.concepts : [];
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

    const contentSegments = segments.filter((segment) => !isMetaHeading(segment.title || ""));
    const sourceSegments = contentSegments.length ? contentSegments : segments;
    const maxConcepts = Math.max(1, Math.min(sourceSegments.length, MAX_CONCEPTS_CAP));
    const documentTitle = cleanText(document.title || "Untitled Document");
    const prompt = buildPrompt(documentTitle, sourceSegments, maxConcepts);
    const warnings = [];

    for (const model of [PRIMARY_MODEL, BACKUP_MODEL]) {
      try {
        const aiConcepts = await callGroq(model, prompt);
        const concepts = normalizeConcepts(aiConcepts, sourceSegments, maxConcepts);

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            debugVersion: "concepts-v11",
            document: { title: documentTitle },
            model,
            warnings,
            concepts
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

    const concepts = fallbackConceptsFromSegments(sourceSegments, maxConcepts);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "concepts-v11-fallback",
        document: { title: documentTitle },
        warnings,
        concepts
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to extract concepts.",
        details: error.message
      })
    };
  }
};