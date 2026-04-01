function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeMatchedDependencies(aiSegments, originalSegments) {
  const originalById = new Map(
    originalSegments.map((segment) => [Number(segment.segmentId), segment])
  );

  const normalized = [];

  for (const item of aiSegments) {
    const segmentId = Number(item?.segmentId);
    const original = originalById.get(segmentId);

    if (!original) continue;

    let dependsOn = Array.isArray(item?.dependsOn) ? item.dependsOn : [];
    dependsOn = dependsOn
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
      .filter((value) => value < segmentId);

    const uniqueDependsOn = [...new Set(dependsOn)].sort((a, b) => a - b);

    normalized.push({
      ...original,
      dependsOn: uniqueDependsOn
    });
  }

  if (normalized.length === originalSegments.length) {
    return normalized.sort((a, b) => a.position - b.position);
  }

  return originalSegments.map((segment) => {
    const found = normalized.find(
      (matched) => matched.segmentId === segment.segmentId
    );

    if (found) return found;

    return {
      ...segment,
      dependsOn: []
    };
  });
}

function fallbackDependencies(segments) {
  return segments.map((segment, index) => {
    let dependsOn = [];

    if (index === 0) {
      dependsOn = [];
    } else if (segment.role === "Introduction" || segment.role === "Definition") {
      dependsOn = [];
    } else {
      dependsOn = [segments[index - 1].segmentId];
    }

    return {
      ...segment,
      dependsOn
    };
  });
}

async function matchDependenciesWithGroq(documentTitle, segments, concepts) {
  const apiKey = process.env.GROQ_KEY;

  if (!apiKey) {
    throw new Error("Missing GROQ_KEY environment variable.");
  }

  const prompt = `
You are helping with STEP 5 ONLY of a demo lesson-ingestion pipeline.

Task:
Given a document title, a concept list, and a list of segments that already have concept and role assigned, decide which earlier segments each segment depends on.

Meaning of dependsOn:
- A dependency is something the learner should understand first before this segment can be taught well.
- Use only earlier segmentIds.
- If the segment stands alone, return an empty array.

Rules:
- Only depend on EARLIER segments, never later ones.
- Return only direct, necessary dependencies.
- Keep dependency lists small.
- Introduction and Definition often have no dependency.
- Explanation often depends on an earlier Introduction or Definition.
- Example often depends on the thing being explained first.
- Summary often depends on earlier segments.
- Do NOT invent segmentIds.
- Keep the original segmentId.
- Return JSON only.

Return JSON in this exact shape:
{
  "segments": [
    {
      "segmentId": 1,
      "dependsOn": []
    },
    {
      "segmentId": 2,
      "dependsOn": [1]
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

    const documentTitle = cleanText(document.title || "Untitled Document");

    let matchedSegments;

    try {
      const aiSegments = await matchDependenciesWithGroq(
        documentTitle,
        segments,
        concepts
      );
      matchedSegments = normalizeMatchedDependencies(aiSegments, segments);
    } catch (aiError) {
      matchedSegments = fallbackDependencies(segments);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          debugVersion: "dependencies-v1-fallback",
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
        debugVersion: "dependencies-v1",
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
        error: "Failed to assign dependencies.",
        details: error.message
      })
    };
  }
};