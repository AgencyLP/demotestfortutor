function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeConcepts(aiConcepts, maxConcepts) {
  const concepts = [];
  let conceptId = 1;
  const seen = new Set();

  for (const item of aiConcepts) {
    const name = cleanText(item?.name || "");
    const description = cleanText(item?.description || "");
    const key = name.toLowerCase();

    if (!name || !description) continue;
    if (seen.has(key)) continue;
    if (concepts.length >= maxConcepts) break;

    concepts.push({
      conceptId,
      name,
      description
    });

    seen.add(key);
    conceptId += 1;
  }

  return concepts;
}

function fallbackConceptsFromSegments(segments, maxConcepts) {
  const concepts = [];

  for (let i = 0; i < Math.min(segments.length, maxConcepts); i += 1) {
    const segment = segments[i];

    concepts.push({
      conceptId: i + 1,
      name: cleanText(segment.title || `Concept ${i + 1}`),
      description: cleanText(segment.text || "").slice(0, 160)
    });
  }

  return concepts;
}

async function extractConceptsWithGroq(documentTitle, segments, maxConcepts) {
  const apiKey = process.env.GROQ_KEY;

  if (!apiKey) {
    throw new Error("Missing GROQ_KEY environment variable.");
  }

  const prompt = `
You are helping with STEP 2 ONLY of a demo lesson-ingestion pipeline.

Task:
Given a document title and a list of already-created lesson segments, identify the main teachable concepts across the whole document.

Rules:
- Return BETWEEN 1 AND ${maxConcepts} concepts only.
- NEVER return more concepts than there are segments.
- Prefer one main concept per segment at most.
- Concepts must be mutually distinct and not overlap in meaning.
- Keep all concepts at a similar level of abstraction.
- Prefer mid-level document themes, not overly broad labels and not overly narrow examples.
- Stay close to the segment structure.
- Usually, one segment should map to one main concept.
- If a segment contains several examples, subtopics, or campaigns, prefer one broader concept that covers them instead of splitting each example into a separate concept.
- Prefer concept names that stay close to the actual segment wording.
- Do NOT use broad generic labels like "History", "Overview", "Science", "Technology", or "Tactics" unless the segments clearly focus on that exact idea.
- Do NOT use example-level labels unless the entire document is mainly about that one example.
- Do NOT invent ideas that are not supported by the segments.
- Keep names short.
- Keep descriptions short and clear.
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
${JSON.stringify(segments, null, 2)}
`.trim();

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Return valid JSON only."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq error: ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Groq returned empty content.");
  }

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
    const maxConcepts = Math.max(1, segments.length);

    let concepts;

    try {
      const aiConcepts = await extractConceptsWithGroq(
        documentTitle,
        segments,
        maxConcepts
      );
      concepts = normalizeConcepts(aiConcepts, maxConcepts);

      if (!concepts.length) {
        concepts = fallbackConceptsFromSegments(segments, maxConcepts);
      }
    } catch (aiError) {
      concepts = fallbackConceptsFromSegments(segments, maxConcepts);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          debugVersion: "concepts-v4-fallback",
          warning: aiError.message,
          document: {
            title: documentTitle
          },
          concepts
        })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "concepts-v4",
        document: {
          title: documentTitle
        },
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