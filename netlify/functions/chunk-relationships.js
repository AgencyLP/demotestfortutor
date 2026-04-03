function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function buildConceptText(concept) {
  return `${cleanText(concept.name || "")}\n${cleanText(concept.description || "")}`;
}

function scoreConceptAgainstSegment(segment, concept) {
  return overlapScore(
    `${segment.title}\n${segment.text}`,
    buildConceptText(concept)
  );
}

function hasBridgeSignal(segment) {
  return /relationship|interaction|between|link|connect|bridge|connecting|versus|vs\.?|compare/i.test(
    `${segment.title}\n${segment.text}`
  );
}

function inferRelationshipType(segment, secondaryConcept, segmentsById) {
  const title = cleanText(segment.title || "").toLowerCase();
  const role = cleanText(segment.role || "");
  const deps = Array.isArray(segment.dependsOn) ? segment.dependsOn : [];

  if (hasBridgeSignal(segment) || role === "Comparison") {
    return "bridge";
  }

  if (
    /level\s+up|advanced|deeper|further|extension|stages?/i.test(title) ||
    role === "Application"
  ) {
    return "level-up";
  }

  if (
    deps.some((id) => {
      const depSeg = segmentsById.get(id);
      return depSeg && cleanText(depSeg.concept || "") === secondaryConcept;
    })
  ) {
    return "quick-reminder";
  }

  return "none";
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

    const segmentsById = new Map(
      segments.map((segment) => [Number(segment.segmentId), segment])
    );

    const enrichedSegments = segments.map((segment) => {
      const mainConcept = cleanText(segment.concept || "");
      const role = cleanText(segment.role || "");

      if (!mainConcept || role === "Introduction" || role === "Definition") {
        return {
          ...segment,
          relationshipType: "none"
        };
      }

      const scored = concepts
        .map((concept) => ({
          name: cleanText(concept.name || ""),
          score: scoreConceptAgainstSegment(segment, concept)
        }))
        .filter((item) => item.name && item.name !== mainConcept)
        .sort((a, b) => b.score - a.score);

      const bestSecondary = scored[0];
      const secondaryConcept =
        bestSecondary && bestSecondary.score >= 0.34 ? bestSecondary.name : "";

      if (!secondaryConcept) {
        return {
          ...segment,
          relationshipType: "none"
        };
      }

      const relationshipType = inferRelationshipType(
        segment,
        secondaryConcept,
        segmentsById
      );

      if (relationshipType === "none") {
        return {
          ...segment,
          relationshipType: "none"
        };
      }

      return {
        ...segment,
        secondaryConcept,
        relationshipType
      };
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "chunk-relationships-v3-fixed",
        document: {
          title: cleanText(document.title || "Untitled Document")
        },
        segments: enrichedSegments
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to determine chunk relationships.",
        details: error.message
      })
    };
  }
};