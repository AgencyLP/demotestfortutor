function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function uniq(arr) {
  return [...new Set(arr)];
}

function buildChunkTitle(mainConcept, chunkType, segments, secondaryConcept) {
  const firstTitle = cleanText(segments[0]?.title || "");

  if (chunkType === "bridge") {
    if (!secondaryConcept && firstTitle) return firstTitle;
    return secondaryConcept
      ? `${mainConcept} ↔ ${secondaryConcept}`
      : `${mainConcept}: bridge`;
  }

  if (chunkType === "level-up") {
    if (firstTitle) return firstTitle;
    return `${mainConcept}: advanced`;
  }

  return firstTitle || mainConcept || "Chunk";
}

function collectChunkDependencies(segmentGroup) {
  const groupIds = new Set(segmentGroup.map((segment) => Number(segment.segmentId)));
  const deps = [];

  for (const segment of segmentGroup) {
    for (const dep of segment.dependsOn || []) {
      if (!groupIds.has(Number(dep))) deps.push(Number(dep));
    }
  }

  return uniq(deps).sort((a, b) => a - b);
}

function shouldBreak(prev, next, currentGroup) {
  const prevConcept = cleanText(prev.concept || "");
  const nextConcept = cleanText(next.concept || "");
  const prevRel = cleanText(prev.relationshipType || "none");
  const nextRel = cleanText(next.relationshipType || "none");
  const nextMixed = Boolean(next.mixedTopic);

  if (nextMixed) return true;
  if (prevRel === "bridge" || nextRel === "bridge") return true;
  if (prevRel === "level-up" || nextRel === "level-up") return true;
  if (nextRel === "quick-reminder") return true;
  if (prevConcept !== nextConcept) return true;
  if (currentGroup.length >= 3) return true;

  return false;
}

function assembleChunks(segments) {
  if (!segments.length) return { chunks: [], warnings: [] };

  const groups = [];
  const warnings = [];
  let current = [segments[0]];

  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1];
    const next = segments[i];

    if (shouldBreak(prev, next, current)) {
      groups.push(current);
      current = [next];
    } else {
      current.push(next);
    }
  }

  if (current.length) groups.push(current);

  const chunks = [];

  for (const group of groups) {
    const first = group[0];
    const rel = cleanText(first.relationshipType || "none");
    const mainConcept = cleanText(first.concept || "Main Concept");
    const secondaryConcept = cleanText(first.secondaryConcept || "");

    let chunkType = "standard";
    if (rel === "bridge") chunkType = "bridge";
    if (rel === "level-up") chunkType = "level-up";

    let dependsOn = collectChunkDependencies(group);

    if ((rel === "quick-reminder" || rel === "bridge" || rel === "level-up") && secondaryConcept) {
      const priorSecondary = segments
        .filter(
          (segment) =>
            cleanText(segment.concept || "") === secondaryConcept &&
            Number(segment.segmentId) < Number(first.segmentId)
        )
        .map((segment) => Number(segment.segmentId));

      if (priorSecondary.length) {
        dependsOn = uniq([
          ...dependsOn,
          priorSecondary[priorSecondary.length - 1]
        ]).sort((a, b) => a - b);
      }
    }

    if (first.mixedTopic) {
      warnings.push(
        `Segment ${first.segmentId} looked mixed-topic, so it was isolated as its own chunk.`
      );
    }

    chunks.push({
      chunkId: chunks.length + 1,
      title: buildChunkTitle(mainConcept, chunkType, group, secondaryConcept),
      chunkType,
      mainConcept,
      secondaryConcept: secondaryConcept || undefined,
      segmentIds: group.map((segment) => Number(segment.segmentId)),
      dependsOn
    });
  }

  return { chunks, warnings };
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

    const result = assembleChunks(segments);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "chunks-v5-fixed",
        document: {
          title: cleanText(document.title || "Untitled Document")
        },
        warnings: result.warnings,
        chunks: result.chunks
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to assemble chunks.",
        details: error.message
      })
    };
  }
};