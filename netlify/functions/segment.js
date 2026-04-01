const pdfParse = require("pdf-parse");

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[•▪◦●]/g, "•")
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
    /^\d+\s*\/\s*\d+$/.test(text)
  );
}

function isLikelyCoverTitleSlide(text) {
  const lines = splitIntoLines(text);
  const words = wordCount(text);
  const joined = normalizeLine(text);

  if (lines.length === 0) return true;

  const hasBodyLikeSentence =
    /[.!?]/.test(text) ||
    /\b(unlike|because|however|therefore|during|between|against|without|could|were|was|had|have)\b/i.test(text);

  const looksLikeShortCover =
    lines.length <= 4 &&
    words <= 20 &&
    !hasBodyLikeSentence;

  const hasOverviewPhrase =
    joined.includes("overview") && words <= 30;

  return looksLikeShortCover || hasOverviewPhrase;
}

function isFillerSlide(text, pageNumber) {
  const normalized = normalizeLine(text);
  const words = wordCount(text);

  const exactShortFiller = [
    /^agenda$/,
    /^contents$/,
    /^questions\??$/,
    /^q&a$/,
    /^thank you$/,
    /^thanks$/,
    /^next session$/
  ];

  if (exactShortFiller.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  if (pageNumber === 1 && isLikelyCoverTitleSlide(text)) {
    return true;
  }

  if (words <= 3 && looksLikePageMarker(normalized)) {
    return true;
  }

  return false;
}

function findRepeatedRemovableLines(pages) {
  const counts = new Map();
  const totalPages = pages.length;
  const threshold = Math.max(2, Math.ceil(totalPages * 0.9));

  for (const page of pages) {
    const uniqueLines = new Set(splitIntoLines(page.text).map(normalizeLine));

    for (const line of uniqueLines) {
      if (!line) continue;
      counts.set(line, (counts.get(line) || 0) + 1);
    }
  }

  const repeatedRemovable = new Set();

  for (const [line, count] of counts.entries()) {
    const repeatedOnMostSlides = count >= threshold;

    if (repeatedOnMostSlides && looksLikePageMarker(line)) {
      repeatedRemovable.add(line);
    }
  }

  return repeatedRemovable;
}

function removeRepeatedSlideFurniture(text, repeatedRemovableLines) {
  const lines = splitIntoLines(text);

  return lines.filter((line) => {
    const normalized = normalizeLine(line);

    if (!normalized) return false;
    if (looksLikePageMarker(normalized) && repeatedRemovableLines.has(normalized)) {
      return false;
    }

    return true;
  });
}

function splitTitleAndBody(lines) {
  if (lines.length === 0) {
    return { title: "", text: "" };
  }

  if (lines.length === 1) {
    return {
      title: lines[0],
      text: ""
    };
  }

  return {
    title: cleanText(lines[0]),
    text: cleanText(lines.slice(1).join(" "))
  };
}

function splitIntoMeaningfulParts(segment) {
  const blocks = segment.text
    .split(/\n\s*\n/)
    .map((part) => cleanText(part))
    .filter(Boolean);

  if (blocks.length < 2) {
    return [segment];
  }

  const strongBlocks = blocks.filter((block) => wordCount(block) >= 8);

  if (strongBlocks.length >= 2 && strongBlocks.length <= 3) {
    return strongBlocks.map((block, index) => {
      if (index === 0) {
        return {
          title: segment.title,
          text: block
        };
      }

      return {
        title: segment.title,
        text: block
      };
    });
  }

  return [segment];
}

function buildSegments(pages) {
  const repeatedRemovableLines = findRepeatedRemovableLines(pages);
  const segments = [];
  let segmentId = 1;
  let position = 1;

  for (const page of pages) {
    const rawText = cleanText(page.text);

    if (!rawText) continue;
    if (isFillerSlide(rawText, page.pageNumber)) continue;

    const cleanedLines = removeRepeatedSlideFurniture(rawText, repeatedRemovableLines);
    const { title, text } = splitTitleAndBody(cleanedLines);

    if (!title && !text) continue;

    const initialSegment = {
      title,
      text
    };

    const parts = splitIntoMeaningfulParts(initialSegment);

    for (const part of parts) {
      const partTitle = cleanText(part.title);
      const partText = cleanText(part.text);

      if (!partTitle && !partText) continue;

      segments.push({
        segmentId,
        position,
        source: page.pageNumber,
        title: partTitle,
        text: partText
      });

      segmentId += 1;
      position += 1;
    }
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
        const text = textContent.items.map((item) => item.str).join(" ");
        pages.push({
          pageNumber: pages.length + 1,
          text
        });
        return text;
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
