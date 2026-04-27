function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function uniqueSortedNumbers(values) {
  return [...new Set(values.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))].sort(
    (a, b) => a - b
  );
}

function inferDependencyForSegment(segments, index) {
  const segment = segments[index];
  if (!segment || index === 0) return [];

  const role = cleanText(segment.role || "");
  const concept = cleanText(segment.concept || "");
  const title = cleanText(segment.title || "").toLowerCase();
  const text = cleanText(segment.text || "").toLowerCase();

  const previousSegments = segments.slice(0, index);

  const prevSameConcept = [...previousSegments]
    .reverse()
    .find((s) => cleanText(s.concept || "") === concept);

  const prevDefinitionOrIntro = [...previousSegments]
    .reverse()
    .find((s) => {
      const r = cleanText(s.role || "");
      return r === "Definition" || r === "Introduction";
    });

  const prevExplanation = [...previousSegments]
    .reverse()
    .find((s) => cleanText(s.role || "") === "Explanation");

  const prevCore = prevSameConcept || prevDefinitionOrIntro || prevExplanation;

  if (role === "Introduction" || role === "Definition") {
    return [];
  }

  if (role === "Example" || role === "Application" || role === "Summary") {
    if (prevCore) return [prevCore.segmentId];
    return [segments[index - 1].segmentId];
  }

  if (role === "Comparison") {
    const deps = [];

    if (prevSameConcept) deps.push(prevSameConcept.segmentId);
    if (prevDefinitionOrIntro) deps.push(prevDefinitionOrIntro.segmentId);
    if (!deps.length && prevExplanation) deps.push(prevExplanation.segmentId);
    if (!deps.length) deps.push(segments[index - 1].segmentId);

    return uniqueSortedNumbers(deps);
  }

  if (/^bridge\b/.test(title) || /connecting the pieces|all connected|link|bridge/.test(text)) {
    const deps = [];

    if (prevSameConcept) deps.push(prevSameConcept.segmentId);

    const recentSupport = previousSegments
      .filter((s) => cleanText(s.role || "") === "Comparison" || cleanText(s.concept || "") !== concept)
      .slice(-2)
      .map((s) => s.segmentId);

    deps.push(...recentSupport);

    if (!deps.length && prevDefinitionOrIntro) deps.push(prevDefinitionOrIntro.segmentId);
    if (!deps.length && prevExplanation) deps.push(prevExplanation.segmentId);
    if (!deps.length) deps.push(segments[index - 1].segmentId);

    return uniqueSortedNumbers(deps);
  }

  if (
    /^level up\b/.test(title) ||
    /\b(advanced|deeper|further|extension|beyond the basics|next level|edge case|edge cases)\b/.test(text) ||
    /\b(stage|step|phase|part)\s+\d+\b/.test(text)
  ) {
    const deps = [];

    if (prevSameConcept) deps.push(prevSameConcept.segmentId);

    const recentBridgeOrSupport = previousSegments
      .filter((s) => {
        const rel = cleanText(s.relationshipType || "");
        return rel === "bridge" || cleanText(s.concept || "") !== concept;
      })
      .slice(-2)
      .map((s) => s.segmentId);

    deps.push(...recentBridgeOrSupport);

    if (!deps.length && prevDefinitionOrIntro) deps.push(prevDefinitionOrIntro.segmentId);
    if (!deps.length && prevExplanation) deps.push(prevExplanation.segmentId);
    if (!deps.length) deps.push(segments[index - 1].segmentId);

    return uniqueSortedNumbers(deps);
  }

  if (prevSameConcept) {
    return [prevSameConcept.segmentId];
  }

  if (prevDefinitionOrIntro) {
    return [prevDefinitionOrIntro.segmentId];
  }

  if (prevExplanation) {
    return [prevExplanation.segmentId];
  }

  return [segments[index - 1].segmentId];
}

function inferDependencies(segments) {
  return segments.map((segment, index) => ({
    ...segment,
    dependsOn: inferDependencyForSegment(segments, index)
  }));
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

    const enrichedSegments = inferDependencies(segments);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "dependencies-v4-heuristic",
        document: {
          title: cleanText(document.title || "Untitled Document")
        },
        warning: "Used deterministic dependency inference to save tokens.",
        segments: enrichedSegments
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to determine dependencies.",
        details: error.message
      })
    };
  }
};