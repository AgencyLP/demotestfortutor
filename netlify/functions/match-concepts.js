function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeMatchedSegments(aiSegments, originalSegments, concepts) {
  const allowedConcepts = new Set(
    concepts.map((concept) => cleanText(concept.name).toLowerCase())
  );

  const originalById = new Map(
    originalSegments.map((segment) => [Number(segment.segmentId), segment])
  );

  const matchedSegments = [];

  for (const item of aiSegments) {
    const segmentId = Number(item?.segmentId);
    const concept = cleanText(item?.concept || "");
    const original = originalById.get(segmentId);

    if (!original) continue;
    if (!concept) continue;
    if (!allowedConcepts.has(concept.toLowerCase())) continue;

    matchedSegments.push({
      ...original,
      concept
    });
  }

  if (matchedSegments.length === originalSegments.length) {
    return matchedSegments.sort((a, b) => a.position - b.position);
  }

  return originalSegments.map((segment) => {
    const found = matchedSegments.find(
      (matched) => matched.segmentId === segment.segmentId
    );

    if (found) return found;

    return {
      ...segment,
      concept: ""
    };
  });
}

function fallbackMatchedSegments(segments, concepts) {
  return segments.map((segment, index) => ({
    ...segment,
    concept: concepts[index]?.name || concepts[0]?.name || ""
  }));
}

async function matchConceptsWithGroq(documentTitle, segments, concepts) {
  const apiKey = process.env.GROQ_KEY;

  if (!apiKey) {
    throw new Error("Missing GROQ_KEY environment variable.");
  }

  const prompt = `
You are helping with STEP 3 ONLY of a demo lesson-ingestion pipeline.

Task:
Given a document title, a list of segments, and a fixed concept list, assign exactly ONE main concept to each segment.

Rules:
- Use only concepts from the provided concept list.
- Do NOT invent a new concept.
- Choose one main concept only for each segment.
- Match based on the segment's main teaching focus.
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
${JSON.stringify(concepts, null, 2)}

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

    let matchedSegments;

    try {
      const aiSegments = await matchConceptsWithGroq(documentTitle, segments, concepts);
      matchedSegments = normalizeMatchedSegments(aiSegments, segments, concepts);
    } catch (aiError) {
      matchedSegments = fallbackMatchedSegments(segments, concepts);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          debugVersion: "match-concepts-v1-fallback",
          warning: aiError.message,
          document: {
            title: documentTitle
          },
          segments: matchedSegments
        })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "match-concepts-v1",
        document: {
          title: documentTitle
        },
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