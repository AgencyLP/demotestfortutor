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
const MAX_SEGMENT_TEXT = Number(process.env.LESSON_SEGMENT_TEXT_LIMIT || 420);
const MAX_CONCEPT_DESC = 160;
const MAX_CONCEPTS_CAP = Number(process.env.LESSON_MAX_CONCEPTS || 5);

const META_TITLE_PATTERNS = [
  /^agenda$/i,
  /^outline$/i,
  /^overview$/i,
  /^contents?$/i,
  /^objectives?$/i,
  /^(learning\s+)?objectives?$/i,
  /^today['’]?s?\s+topics?$/i,
  /^topics?$/i,
  /^summary$/i,
  /^recap$/i,
  /^review$/i,
  /^(q\s*&\s*a|questions?)$/i,
  /^thank\s+you$/i,
  /^references?$/i,
  /^appendix$/i,
  /^welcome$/i,
  /^lesson\s+review$/i
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
    .replace(/^bridge[:\-]?\s*/i, "")
    .replace(/^level\s+up[:\-]?\s*/i, "")
    .replace(/^two\s+topics[:\-]?\s*/i, "")
    .replace(/[?]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function chooseBestTitleSeed(segment) {
  const rawTitle = cleanText(segment.title || "");
  if (rawTitle && !isMetaHeading(rawTitle)) {
    return normalizeTitleToConcept(rawTitle);
  }
  return rawTitle || `Concept ${segment.segmentId}`;
}

function isGenericFramingConcept(name) {
  const value = cleanText(name).toLowerCase();

  return (
    value === "bridge" ||
    value === "connecting the pieces" ||
    value === "two topics" ||
    value === "level up" ||
    value === "what goes in — what comes out" ||
    value === "what goes in what comes out" ||
    value === "inputs and outputs"
  );
}

function looksLikeNarrowDetailConcept(concept, segments) {
  const name = cleanText(concept.name || concept);
  const description = cleanText(concept.description || "");
  const tokens = tokenize(name);

  if (!tokens.length) return true;
  if (tokens.length > 3) return false;

  const supportCount = segments.filter((segment) => {
    const segmentText = `${cleanText(segment.title || "")}\n${cleanText(segment.text || "")}`;
    return overlapScore(segmentText, `${name}\n${description}`) >= 0.5;
  }).length;

  const detailNouns = /\b(input|inputs|output|outputs|source|sources|ingredient|ingredients|byproduct|byproducts|component|components|part|parts|step|steps)\b/i;

  return supportCount <= 1 && detailNouns.test(name);
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

function fallbackConceptsFromSegments(segments, maxConcepts) {
  const concepts = [];
  const seen = new Set();

  for (const segment of segments) {
    if (concepts.length >= maxConcepts) break;
    if (segment.meta) continue;

    const name = chooseBestTitleSeed(segment);
    const description = cleanText(segment.text || "").slice(0, MAX_CONCEPT_DESC);
    const key = cleanText(name).toLowerCase();

    if (!name || !description || seen.has(key)) continue;
    if (isMetaHeading(name)) continue;
    if (isGenericFramingConcept(name)) continue;

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

function dedupeConcepts(concepts) {
  const seen = new Set();
  const normalized = [];
  let conceptId = 1;

  for (const item of concepts || []) {
    const name = cleanText(item?.name || "");
    const description = cleanText(item?.description || "").slice(0, MAX_CONCEPT_DESC);
    const key = name.toLowerCase();

    if (!name || !description || seen.has(key)) continue;
    if (isMetaHeading(name)) continue;
    if (isGenericFramingConcept(name)) continue;

    seen.add(key);
    normalized.push({ conceptId, name, description });
    conceptId += 1;
  }

  return normalized;
}

function collapseOverlappingConcepts(concepts) {
  const kept = [];

  for (const concept of concepts) {
    const currentName = cleanText(concept.name);
    const currentDesc = cleanText(concept.description);
    const currentLower = currentName.toLowerCase();

    const redundant = kept.some((existing) => {
      const existingName = cleanText(existing.name);
      const existingDesc = cleanText(existing.description);
      const existingLower = existingName.toLowerCase();

      if (existingLower === currentLower) return true;
      if (existingLower.includes(currentLower) || currentLower.includes(existingLower)) return true;

      const nameOverlap = overlapScore(existingName, currentName);
      const descOverlap = overlapScore(existingDesc, currentDesc);

      if (nameOverlap >= 0.74) return true;
      if (nameOverlap >= 0.52 && descOverlap >= 0.42) return true;

      return false;
    });

    if (!redundant) kept.push(concept);
  }

  return kept.map((concept, index) => ({
    conceptId: index + 1,
    name: concept.name,
    description: concept.description
  }));
}

function normalizeConcepts(aiConcepts, segments, maxConcepts) {
  const fallback = fallbackConceptsFromSegments(segments, maxConcepts);

  let concepts = dedupeConcepts(aiConcepts || []);
  concepts = collapseOverlappingConcepts(concepts);
  concepts = concepts.filter((concept) => !looksLikeNarrowDetailConcept(concept, segments));

  const seen = new Set(concepts.map((c) => cleanText(c.name).toLowerCase()));

  for (const item of fallback) {
    if (concepts.length >= maxConcepts) break;
    const key = cleanText(item.name).toLowerCase();
    if (seen.has(key)) continue;

    concepts.push({
      conceptId: concepts.length + 1,
      name: item.name,
      description: item.description
    });

    seen.add(key);
  }

  concepts = collapseOverlappingConcepts(concepts);
  concepts = concepts.filter((concept) => !looksLikeNarrowDetailConcept(concept, segments));

  if (concepts.length > maxConcepts) {
    concepts = concepts.slice(0, maxConcepts).map((concept, index) => ({
      conceptId: index + 1,
      name: concept.name,
      description: concept.description
    }));
  }

  if (!concepts.length) {
    return fallbackConceptsFromSegments(segments, Math.max(1, Math.min(maxConcepts, 3)));
  }

  return concepts.map((concept, index) => ({
    conceptId: index + 1,
    name: concept.name,
    description: cleanText(concept.description).slice(0, MAX_CONCEPT_DESC)
  }));
}

function buildPrompt(documentTitle, segments, maxConcepts) {
  return `
You are helping with STEP 2 ONLY of a demo AI tutor ingestion pipeline.

Task:
Given a document title and a list of already segmented lesson segments, identify the main teachable concepts.

Rules:
- Return between 1 and ${maxConcepts} concepts.
- Keep the concept list small, clear, teachable, distinct, and non-overlapping.
- Prefer broader lesson concepts over slide-local framing labels.
- Do not create separate concepts for by-products, ingredients, inputs/outputs framing, or one small output unless the lesson truly teaches them as their own topic.
- Use wording close to actual segment topics.
- Do not use meta headings such as objectives, agenda, overview, recap, welcome, Q&A, or thank you as concept names.
- Do not use bridge labels, level-up labels, or generic placeholders as concept names.
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

    const documentTitle = cleanText(document.title || "Untitled Document");
    const maxConcepts = Math.max(1, Math.min(MAX_CONCEPTS_CAP, segments.length));
    const prompt = buildPrompt(documentTitle, segments, maxConcepts);
    const warnings = [];

    for (const model of [PRIMARY_MODEL, BACKUP_MODEL]) {
      try {
        const aiConcepts = await callGroq(model, prompt);
        const concepts = normalizeConcepts(aiConcepts, segments, maxConcepts);

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            debugVersion: "concepts-v5",
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

    const concepts = normalizeConcepts([], segments, maxConcepts);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "concepts-v5-fallback",
        document: { title: documentTitle },
        warning: "Used fallback concept extraction.",
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