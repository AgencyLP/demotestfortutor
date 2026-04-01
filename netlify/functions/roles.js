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

function normalizeMatchedRoles(aiSegments, originalSegments) {
  const originalById = new Map(
    originalSegments.map((segment) => [Number(segment.segmentId), segment])
  );

  const matchedSegments = [];

  for (const item of aiSegments) {
    const segmentId = Number(item?.segmentId);
    const role = cleanText(item?.role || "");
    const original = originalById.get(segmentId);

    if (!original) continue;
    if (!ALLOWED_ROLES.includes(role)) continue;

    matchedSegments.push({
      ...original,
      role
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
      role: ""
    };
  });
}

function fallbackRoles(segments) {
  return segments.map((segment, index) => {
    let role = "Explanation";

    if (index === 0) {
      role = "Introduction";
    } else if (/what is|means|defined as|definition/i.test(segment.text || "")) {
      role = "Definition";
    } else if (/for example|for instance|such as/i.test(segment.text || "")) {
      role = "Example";
    } else if (/in conclusion|overall|in summary|legacy|impact/i.test(segment.title || "")) {
      role = "Summary";
    }

    return {
      ...segment,
      role
    };
  });
}

async function matchRolesWithGroq(documentTitle, segments) {
  const apiKey = process.env.GROQ_KEY;

  if (!apiKey) {
    throw new Error("Missing GROQ_KEY environment variable.");
  }

  const prompt = `
You are helping with STEP 4 ONLY of a demo lesson-ingestion pipeline.

Task:
Given a document title and a list of segments that already have concepts assigned, assign exactly ONE teaching role to each segment.

Allowed roles only:
- Introduction = opens the topic, frames what is coming, or gives orientation
- Definition = states what something is
- Explanation = explains how or why something works
- Example = gives a concrete case or instance
- Comparison = contrasts two or more things
- Application = shows use in practice or consequence in action
- Summary = wraps up or restates key takeaways

Rules:
- Use ONLY the allowed roles above.
- Assign exactly ONE role per segment.
- Do NOT invent a new role.
- Choose the single best fit based on the segment’s main teaching job.
- Keep the original segmentId.
- Return JSON only.

Return JSON in this exact shape:
{
  "segments": [
    {
      "segmentId": 1,
      "role": "Explanation"
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

    let matchedSegments;

    try {
      const aiSegments = await matchRolesWithGroq(documentTitle, segments);
      matchedSegments = normalizeMatchedRoles(aiSegments, segments);
    } catch (aiError) {
      matchedSegments = fallbackRoles(segments);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          debugVersion: "roles-v1-fallback",
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
        debugVersion: "roles-v1",
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
        error: "Failed to assign roles.",
        details: error.message
      })
    };
  }
};