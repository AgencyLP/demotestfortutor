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
    text.includes("thammasat university") ||
    text.includes("international taxation in a nutshell")
  );
}

function looksLikeShortHeading(line) {
  const text = cleanText(line);
  const words = wordCount(text);

  return words > 0 && words <= 8 && text.length <= 80 && !/[.!?]$/.test(text);
}

function looksLikeNumberedSectionHeading(line) {
  const text = cleanText(line);
  return /^\d+\s*[\.\)]?\s*[A-Za-z]/.test(text) && wordCount(text) <= 8;
}

function hasBodyLikeContent(lines) {
  const joined = cleanText(lines.join(" "));
  const words = wordCount(joined);

  if (words >= 20) return true;
  if (/[.!?]/.test(joined)) return true;
  if (/[:;]/.test(joined) && words >= 10) return true;

  const bodySignals =
    /\b(means|includes|such|under|because|however|therefore|during|between|against|without|could|were|was|had|have|received|computed|benefit|amount|paid|taxpayer)\b/i;

  return bodySignals.test(joined);
}

function isLikelyCoverTitleSlide(lines) {
  const contentLines = lines.filter(
    (line) => !looksLikePageMarker(line) && !looksLikeBrandingLine(line)
  );

  if (contentLines.length === 0) return true;

  const joined = cleanText(contentLines.join(" "));
  const words = wordCount(joined);

  return contentLines.length <= 4 && words <= 20 && !hasBodyLikeContent(contentLines);
}

function isTwoLineSplitHeading(lines) {
  if (lines.length !== 2) return false;

  const first = cleanText(lines[0]);
  const second = cleanText(lines[1]);
  const joined = cleanText(`${first} ${second}`);

  const bothShort = looksLikeShortHeading(first) && looksLikeShortHeading(second);
  const totalShort = wordCount(joined) <= 8;
  const noBody = !hasBodyLikeContent(lines);

  return bothShort && totalShort && noBody;
}

function isLikelyDividerSlide(lines) {
  const contentLines = lines.filter(
    (line) => !looksLikePageMarker(line) && !looksLikeBrandingLine(line)
  );

  if (contentLines.length === 0) return true;

  const joined = cleanText(contentLines.join(" "));
  const words = wordCount(joined);

  // If there is any real teaching/body content, keep it
  if (hasBodyLikeContent(contentLines)) return false;

  // Strong simple rule:
  // very short slide with no body = divider
  if (words <= 8) return true;

  // Slightly looser fallback for short heading-only slides
  if (
    words <= 12 &&
    contentLines.length <= 3 &&
    contentLines.every((line) => looksLikeShortHeading(line) || looksLikeNumberedSectionHeading(line))
  ) {
    return true;
  }

  return false;
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

  return sortedY
    .map((y) => {
      const parts = lineMap
        .get(y)
        .sort((a, b) => a.x - b.x)
        .map((part) => part.text);

      return cleanText(parts.join(" "));
    })
    .filter(Boolean);
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
    if (looksLikeBrandingLine(normalized)) return false;

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
    const lines = removeSlideFurniture(page.lines, repeatedRemovableLines);
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
