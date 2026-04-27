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
  const segmentText = `${cleanText(segment.title || "")}\n${cleanText(segment.text || "")}`;
  const conceptText = buildConceptText(concept);
  let score = overlapScore(segmentText, conceptText);

  const title = cleanText(segment.title || "").toLowerCase();
  const conceptName = cleanText(concept.name || "").toLowerCase();

  if (title && conceptName) {
    if (title === conceptName) score += 1.0;
    else if (title.includes(conceptName) || conceptName.includes(title)) score += 0.45;
  }

  return score;
}

function getBestSecondaryConcept(segment, concepts, mainConcept) {
  const scored = concepts
    .map((concept) => ({
      name: cleanText(concept.name || ""),
      score: scoreConceptAgainstSegment(segment, concept)
    }))
    .filter((item) => item.name && item.name !== mainConcept)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return "";

  return best.score >= 0.42 ? best.name : "";
}

function hasBridgeSignal(title, text) {
  const value = `${title}\n${text}`.toLowerCase();

  return (
    /^bridge\b/.test(title.toLowerCase()) ||
    /connecting the pieces|all connected|how .* connected|connection between|link between/.test(value)
  );
}

function hasLevelUpSignal(title, text) {
  const value = `${title}\n${text}`.toLowerCase();

  return (
    /^level up\b/.test(title.toLowerCase()) ||
    /\b(advanced|deeper|further|extension|beyond the basics|next level|edge case|edge cases)\b/.test(value) ||
    /\b(stage|step|phase|part)\s+\d+\b/.test(value)
  );
}

function isQuickReminder(segment, secondaryConcept, segmentsById) {
  const deps = Array.isArray(segment.dependsOn) ? segment.dependsOn : [];

  return deps.some((id) => {
    const depSeg = segmentsById.get(Number(id));
    return depSeg && cleanText(depSeg.concept || "") === secondaryConcept;
  });
}

function inferRelationship(segment, secondaryConcept, segmentsById) {
  const title = cleanText(segment.title || "");
  const text = cleanText(segment.text || "");
  const role = cleanText(segment.role || "");
  const mainConcept = cleanText(segment.concept || "");

  if (!mainConcept) {
    return { relationshipType: "none" };
  }

  if (hasLevelUpSignal(title, text)) {
    return {
      relationshipType: "level-up",
      secondaryConcept: secondaryConcept || undefined
    };
  }

  if (hasBridgeSignal(title, text)) {
    return {
      relationshipType: "bridge",
      secondaryConcept: secondaryConcept || undefined
    };
  }

  if (!secondaryConcept || mainConcept === secondaryConcept) {
    return { relationshipType: "none" };
  }

  if (role === "Comparison") {
    return {
      relationshipType: "bridge",
      secondaryConcept
    };
  }

  if (isQuickReminder(segment, secondaryConcept, segmentsById)) {
    return {
      relationshipType: "quick-reminder",
      secondaryConcept
    };
  }

  return { relationshipType: "none" };
}

function detectMixedTopicSegment(segment, concepts, mainConcept, role) {
  const title = cleanText(segment.title || "").toLowerCase();
  const text = cleanText(segment.text || "").toLowerCase();

  if (/^two topics\b/.test(title)) return true;
  if (/\btopic 1\b/.test(text) && /\btopic 2\b/.test(text)) return true;

  if (role === "Comparison") return false;

  const strongMatches = concepts
    .filter((concept) => cleanText(concept.name || "") !== mainConcept)
    .map((concept) => scoreConceptAgainstSegment(segment, concept))
    .filter((score) => score >= 0.48);

  if (strongMatches.length >= 2) return true;

  return false;
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

    const warnings = [];

    const enrichedSegments = segments.map((segment) => {
      const mainConcept = cleanText(segment.concept || "");
      const role = cleanText(segment.role || "");

      if (!mainConcept || role === "Introduction" || role === "Definition") {
        return {
          ...segment,
          relationshipType: "none"
        };
      }

      const secondaryConcept = getBestSecondaryConcept(segment, concepts, mainConcept);
      const relationship = inferRelationship(
        segment,
        secondaryConcept,
        segmentsById
      );

      if (
        relationship.relationshipType === "none" &&
        detectMixedTopicSegment(segment, concepts, mainConcept, role)
      ) {
        warnings.push(
          `Segment ${segment.segmentId} appears to contain multiple competing topics.`
        );

        return {
          ...segment,
          relationshipType: "none",
          mixedTopic: true
        };
      }

      if (relationship.relationshipType === "none") {
        return {
          ...segment,
          relationshipType: "none"
        };
      }

      return {
        ...segment,
        secondaryConcept: relationship.secondaryConcept,
        relationshipType: relationship.relationshipType
      };
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "chunk-relationships-v4-fixed",
        document: {
          title: cleanText(document.title || "Untitled Document")
        },
        warnings,
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