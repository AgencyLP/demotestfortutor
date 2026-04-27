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
const BACKUP_MODEL = process.env.GROQ_BACKUP_MODEL || "llama-3.1-8b-instant";
const MAX_SEGMENT_TEXT = Number(process.env.LESSON_SEGMENT_TEXT_LIMIT || 320);
const MAX_CONCEPT_DESC = 140;
const MAX_CONCEPTS_CAP = Number(process.env.LESSON_MAX_CONCEPTS || 6);

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
    .replace(/\s*\((.*?)\)\s*/g, " ")
    .replace(/[?]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function compactSegmentForPrompt(segment) {
  return {
    segmentId: Number(segment.segmentId),
    position: Number(segment.position),
    source: Number(segment.source),
    title: cleanText(segment.title || `Segment ${segment.segmentId}`),
    text: cleanText(segment.text || "").slice(0, MAX_SEGMENT_TEXT)
  };
}

function chooseBestTitleSeed(segment) {
  const rawTitle = cleanText(segment.title || "");
  if (rawTitle && !isMetaHeading(rawTitle)) {
    const normalized = normalizeTitleToConcept(rawTitle);
    if (normalized) return normalized;
  }

  const lines = cleanText(segment.text || "")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);

  for (const line of lines) {
    if (line.length < 4 || line.length > 70) continue;
    if (isMetaHeading(line)) continue;
    if (!/[.!?]$/.test(line)) {
      const normalized = normalizeTitleToConcept(line);
      if (normalized) return normalized;
    }
  }

  return rawTitle || `Concept ${segment.segmentId}`;
}

function inferRoleFromSegment(segment, index, total) {
  const title = cleanText(segment.title || "");
  const text = cleanText(segment.text || "");
  const combined = `${title}\n${text}`;

  if (index === 0) return "Introduction";
  if (/what is|defined as|definition|refers to|means\b/i.test(combined)) return "Definition";
  if (/for example|for instance|such as|case study|e\.g\./i.test(combined)) return "Example";
  if (/compare|versus|vs\.|difference|similarit/i.test(combined)) return "Comparison";
  if (/application|in practice|used in|real world|practical/i.test(combined)) return "Application";
  if (index === total - 1 && /summary|conclusion|wrap.?up|takeaway|overall/i.test(combined)) {
    return "Summary";
  }
  if (/summary|conclusion|recap|overall/i.test(combined)) return "Summary";

  return "Explanation";
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

    seen.add(key);
    normalized.push({ conceptId, name, description });
    conceptId += 1;
  }

  return normalized;
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

function fallbackConceptsFromSegments(segments, maxConcepts) {
  const concepts = [];
  const seen = new Set();

  for (const segment of segments) {
    if (concepts.length >= maxConcepts) break;

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

function bestConceptNameForSegment(segment, concepts) {
  if (!concepts.length) return "";

  let best = concepts[0];
  let bestScore = -1;

  for (const concept of concepts) {
    const score =
      overlapScore(`${segment.title}\n${segment.text}`, `${concept.name}\n${concept.description}`) +
      (cleanText(segment.title || "").toLowerCase() === cleanText(concept.name || "").toLowerCase() ? 1 : 0);

    if (score > bestScore) {
      best = concept;
      bestScore = score;
    }
  }

  return best.name;
}

function inferDependencies(segments) {
  return segments.map((segment, index) => {
    if (index === 0) return { ...segment, dependsOn: [] };

    const role = cleanText(segment.role || "");
    const concept = cleanText(segment.concept || "");

    if (role === "Introduction" || role === "Definition") {
      return { ...segment, dependsOn: [] };
    }

    const prevSameConcept = [...segments]
      .slice(0, index)
      .reverse()
      .find((item) => cleanText(item.concept || "") === concept);

    if (role === "Example" || role === "Application" || role === "Summary") {
      if (prevSameConcept) {
        return { ...segment, dependsOn: [prevSameConcept.segmentId] };
      }
    }

    if (role === "Comparison") {
      const recent = segments
        .slice(Math.max(0, index - 2), index)
        .map((item) => item.segmentId);

      return { ...segment, dependsOn: [...new Set(recent)] };
    }

    if (prevSameConcept) {
      return { ...segment, dependsOn: [prevSameConcept.segmentId] };
    }

    return { ...segment, dependsOn: [segments[index - 1].segmentId] };
  });
}

function buildFallbackLessonMap(segments) {
  const contentSegments = segments.filter((segment) => !isMetaHeading(segment.title || ""));
  const sourceSegments = contentSegments.length ? contentSegments : segments;
  const maxConcepts = Math.max(1, Math.min(sourceSegments.length, MAX_CONCEPTS_CAP));
  const concepts = fallbackConceptsFromSegments(sourceSegments, maxConcepts);

  const mapped = segments.map((segment, index) => ({
    ...segment,
    concept: bestConceptNameForSegment(segment, concepts),
    role: inferRoleFromSegment(segment, index, segments.length)
  }));

  return {
    concepts,
    segments: inferDependencies(mapped)
  };
}

function collapseOverlappingConcepts(concepts) {
  const kept = [];

  for (const concept of concepts) {
    const name = cleanText(concept.name);
    const lower = name.toLowerCase();

    const redundant = kept.some((existing) => {
      const a = cleanText(existing.name).toLowerCase();
      const b = lower;
      return a === b || a.includes(b) || b.includes(a) || overlapScore(a, b) >= 0.75;
    });

    if (!redundant) kept.push(concept);
  }

  return kept.map((concept, index) => ({
    conceptId: index + 1,
    name: concept.name,
    description: concept.description
  }));
}

function normalizeAiResult(parsed, originalSegments) {
  const fallback = buildFallbackLessonMap(originalSegments);
  let rawConcepts = dedupeConcepts(parsed?.concepts || [])
    .filter((item) => !isGenericFramingConcept(item.name))
    .filter((item) => !looksLikeNarrowDetailConcept(item, originalSegments));

  rawConcepts = collapseOverlappingConcepts(rawConcepts);

  const conceptPool = rawConcepts.length ? rawConcepts : fallback.concepts;
  const conceptNames = new Set(conceptPool.map((item) => item.name));

  const segments = originalSegments.map((segment, index) => {
    const aiSegment =
      (parsed?.segments || []).find(
        (item) => Number(item?.segmentId) === Number(segment.segmentId)
      ) || {};

    let concept = cleanText(aiSegment.concept || "");
    if (!conceptNames.has(concept)) {
      concept = bestConceptNameForSegment(segment, conceptPool);
    }

    let role = cleanText(aiSegment.role || "");
    if (!ALLOWED_ROLES.includes(role)) {
      role = inferRoleFromSegment(segment, index, originalSegments.length);
    }

    let dependsOn = Array.isArray(aiSegment.dependsOn)
      ? aiSegment.dependsOn.map((value) => Number(value))
      : [];

    dependsOn = [...new Set(dependsOn)]
      .filter((value) => Number.isInteger(value) && value > 0)
      .filter((value) => value < Number(segment.segmentId))
      .sort((a, b) => a - b);

    return {
      ...segment,
      concept,
      role,
      dependsOn
    };
  });

  return {
    concepts: conceptPool,
    segments: inferDependencies(segments)
  };
}

function buildPrompt(documentTitle, segments) {
  const compactSegments = segments.map(compactSegmentForPrompt);
  const maxConcepts = Math.max(1, Math.min(segments.length, MAX_CONCEPTS_CAP));

  return [
    "You are helping with STEPS 2, 3, 4, and 5 ONLY of a demo AI tutor ingestion pipeline.",
    "The segments have already been structurally segmented.",
    "Your job is to produce:",
    "- a small concept list for the whole document",
    "- one main concept per segment",
    "- one teaching role per segment",
    "- direct segment dependencies",
    "",
    "Important pipeline rules:",
    `- Return between 1 and ${maxConcepts} concepts.`,
    "- Keep concepts clear, teachable, distinct, and non-overlapping.",
    "- Prefer broader teachable lesson concepts over tiny sub-parts.",
    "- Do not create extra concepts for by-products, ingredients, or single details unless they are clearly taught as their own topic.",
    "- Use wording close to real segment topics.",
    "- Do not use meta headings such as agenda, objectives, overview, recap, welcome, Q&A, or thank you as concept names.",
    "- Each segment gets exactly one concept.",
    `- Each segment role must be one of: ${ALLOWED_ROLES.join(", ")}.`,
    "- dependsOn may only contain earlier segmentIds.",
    "- Keep dependency lists short and necessary.",
    "- Definition usually has no dependency.",
    "- Explanation often depends on an earlier definition/introduction.",
    "- Example often depends on earlier explanation/definition.",
    "- Comparison may depend on more than one earlier segment.",
    "- Return JSON only.",
    "",
    'Return JSON in this exact shape:',
    '{',
    '  "concepts": [',
    '    { "name": "Concept name", "description": "Short description" }',
    '  ],',
    '  "segments": [',
    '    { "segmentId": 1, "concept": "Concept name", "role": "Explanation", "dependsOn": [] }',
    '  ]',
    '}',
    "",
    `Document title: ${documentTitle}`,
    `Segments: ${JSON.stringify(compactSegments)}`
  ].join("\n");
}

async function callGroqModel({ model, prompt }) {
  const apiKey = process.env.GROQ_KEY;
  if (!apiKey) {
    throw new Error("Missing GROQ_KEY environment variable.");
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 1000,
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

  if (!content) {
    throw new Error(`Groq returned empty content for model ${model}.`);
  }

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
        const parsed = await callGroqModel({ model, prompt });
        const normalized = normalizeAiResult(parsed, segments);

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            debugVersion: "lesson-map-v8-enrich-fixed",
            document: { title: documentTitle },
            model,
            usedFallback: false,
            warnings,
            concepts: normalized.concepts,
            segments: normalized.segments
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

    const fallback = buildFallbackLessonMap(segments);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "lesson-map-v8-enrich-fallback-fixed",
        document: { title: documentTitle },
        usedFallback: true,
        warnings,
        concepts: fallback.concepts,
        segments: fallback.segments
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to enrich lesson map.",
        details: error.message
      })
    };
  }
};