const pdfParse = require("pdf-parse");

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[•▪◦●]/g, "•")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function filenameToTitle(fileName) {
  return String(fileName || "Untitled Document")
    .replace(/\.pdf$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  return cleanText(text).split(/\s+/).filter(Boolean).length;
}

function normalizeLine(line) {
  return cleanText(line).toLowerCase();
}

function splitIntoLines(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
}

function looksLikePageMarker(line) {
  const text = normalizeLine(line);
  return (
    /slide\s+\d+\s+of\s+\d+/.test(text) ||
    /page\s+\d+\s+of\s+\d+/.test(text) ||
    /^page\s+\d+$/.test(text) ||
    /^slide\s+\d+$/.test(text) ||
    /^\d+\s*\/\s*\d+$/.test(text) ||
    /^\d+$/.test(text)
  );
}

function looksLikeBrandingLine(line) {
  const text = normalizeLine(line);
  return (
    text.includes("international ll.b. program") ||
    text.includes("business law") ||
    text.includes("faculty of law") ||
    text.includes("thammasat university")
  );
}

function isLikelyCoverTitleSlide(lines) {
  const joined = cleanText(lines.join(" "));
  const words = wordCount(joined);

  if (lines.length === 0) return true;

  const hasBodySentence =
    /[.!?]/.test(joined) ||
    /\b(unlike|because|however|therefore|during|between|against|without|could|were|was|had|have|means|includes)\b/i.test(joined);

  return lines.length <= 4 && words <= 20 && !hasBodySentence;
}

function isLikelyDividerSlide(lines) {
  if (!lines.length) return false;

  const nonFurniture = lines.filter(
    (line) => !looksLikePageMarker(line) && !looksLikeBrandingLine(line)
  );

  if (nonFurniture.length === 0) return true;

  const joined = cleanText(nonFurniture.join(" "));
  const words = wordCount(joined);

  const hasBodySentence =
    /[.!?]/.test(joined) ||
    /\b(unlike|because|however|therefore|during|between|against|without|could|were|was|had|have|means|includes)\b/i.test(joined);

  const numberedHeadingOnly =
    nonFurniture.length <= 2 &&
    words <= 8 &&
    /^\d+\s*[\.\)]/.test(nonFurniture[0]);

  const shortHeadingOnly =
    nonFurniture.length <= 2 &&
    words <= 10 &&
    !hasBodySentence;

  return numberedHeadingOnly || shortHeadingOnly;
}

function groupItemsIntoLines(items) {
  const lineMap = new Map();

  for (const item of items) {
    const str = cleanText(item.str);
    if (!str) continue;

    const y = Math.round(item.transform[5]);
    if (!lineMap.has(y)) {
      lineMap.set(y, []);
    }

    lineMap.get(y).push({
      x: item.transform[4],
      text: str
    });
  }

  const sortedY = Array.from(lineMap.keys()).sort((a, b) => b - a);

  const lines = sortedY.map((y) => {
    const parts = lineMap
      .get(y)
      .sort((a, b) => a.x - b.x)
      .map((part) => part.text);

    return cleanText(parts.join(" "));
  });

  return lines.filter(Boolean);
}

function findRepeatedRemovableLines(pages) {
  const counts = new Map();
  const totalPages = pages.length;
  const threshold = Math.max(2, Math.ceil(totalPages * 0.8));

  for (const page of pages) {
    const uniqueLines = new Set(page.lines.map(normalizeLine));

    for (const line of uniqueLines) {
      if (!line) continue;
      counts.set(line, (counts.get(line) || 0) + 1);
    }
  }

  const removable = new Set();

  for (const [line, count] of counts.entries()) {
    if (count >= threshold && (looksLikePageMarker(line) || looksLikeBrandingLine(line))) {
      removable.add(line);
    }
  }

  return removable;
}

function removeSlideFurniture(lines, repeatedRemovableLines) {
  return lines.filter((line, index, arr) => {
    const normalized = normalizeLine(line);
    if (!normalized) return false;

    if (repeatedRemovableLines.has(normalized)) return false;

    // Remove lone page numbers especially at top/bottom
    if (/^\d+$/.test(normalized)) {
      const nearTop = index <= 1;
      const nearBottom = index >= arr.length - 2;
      if (nearTop || nearBottom) return false;
    }

    if (looksLikePageMarker(normalized)) return false;

    return true;
  });
}

function splitTitleAndBody(lines) {
  if (lines.length === 0) {
    return { title: "", text: "" };
  }

  if (lines.length === 1) {
    return { title: lines[0], text: "" };
  }

  const first = cleanText(lines[0]);
  const restLines = lines.slice(1);
  const rest = cleanText(restLines.join(" "));
  const firstWords = wordCount(first);

  const looksLikeHeading =
    firstWords <= 12 &&
    first.length <= 120 &&
    !/[.!?]$/.test(first);

  if (looksLikeHeading) {
    return {
      title: first,
      text: rest
    };
  }

  return {
    title: "",
    text: cleanText(lines.join(" "))
  };
}

function buildSegments(pages) {
  const repeatedRemovableLines = findRepeatedRemovableLines(pages);
  const segments = [];
  let segmentId = 1;
  let position = 1;

  for (const page of pages) {
    let lines = removeSlideFurniture(page.lines, repeatedRemovableLines);
    if (lines.length === 0) continue;

    if (page.pageNumber === 1 && isLikelyCoverTitleSlide(lines)) {
      continue;
    }

    if (isLikelyDividerSlide(lines)) {
      continue;
    }

    const { title, text } = splitTitleAndBody(lines);

    if (!title && !text) continue;

    segments.push({
      segmentId,
      position,
      source: page.pageNumber,
      title,
      text
    });

    segmentId += 1;
    position += 1;
  }

  return segments;
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
    const { fileName, pdfBase64 } = body;

    if (!pdfBase64) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing PDF data." })
      };
    }

    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    const pages = [];

    await pdfParse(pdfBuffer, {
      pagerender: async (pageData) => {
        const textContent = await pageData.getTextContent();
        const lines = groupItemsIntoLines(textContent.items);

        pages.push({
          pageNumber: pages.length + 1,
          lines
        });

        return lines.join("\n");
      }
    });

    const result = {
      document: {
        title: filenameToTitle(fileName)
      },
      segments: buildSegments(pages)
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to process PDF.",
        details: error.message
      })
    };
  }
};
