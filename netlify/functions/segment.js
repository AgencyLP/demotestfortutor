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

function lineCount(text) {
  return cleanText(text).split(/\n+/).filter(Boolean).length;
}

function normalizeForMatch(text) {
  return cleanText(text).toLowerCase();
}

function isLikelyCoverTitleSlide(text) {
  const lines = cleanText(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const joined = normalizeForMatch(text);
  const words = wordCount(text);

  if (lines.length === 0) return true;

  const hasOverviewPhrase =
    joined.includes("overview") ||
    joined.includes("four-part overview") ||
    joined.includes("part overview");

  const hasLongBodySentence =
    /[.!?]/.test(text) ||
    /\b(because|therefore|however|unlike|during|between|against|through|without|could|were|was|had|have)\b/i.test(
      text
    );

  const looksLikeShortTitleBlock =
    lines.length <= 4 &&
    words <= 20 &&
    !hasLongBodySentence;

  return looksLikeShortTitleBlock || (hasOverviewPhrase && words <= 30);
}

function isFillerSlide(text, pageNumber) {
  const normalized = normalizeForMatch(text);
  const words = wordCount(text);

  const exactFillerPatterns = [
    /^agenda$/,
    /^contents$/,
    /^questions\??$/,
    /^q&a$/,
    /^thank you$/,
    /^thanks$/,
    /^next session$/,
    /^overview$/,
    /^appendix$/,
    /^section \d+$/,
    /^part \d+$/,
    /^introduction$/
  ];

  if (exactFillerPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const shortFillerPatterns = [
    /agenda/,
    /questions?/,
    /q&a/,
    /thank you/,
    /next session/,
    /appendix/
  ];

  if (words <= 8 && shortFillerPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  // Stronger rule for first-slide cover/title pages
  if (pageNumber === 1 && isLikelyCoverTitleSlide(text)) {
    return true;
  }

  return false;
}

function splitIntoMeaningfulParts(pageText) {
  const cleanedPage = cleanText(pageText);

  const blocks = cleanedPage
    .split(/\n\s*\n/)
    .map((part) => cleanText(part))
    .filter(Boolean);

  if (blocks.length < 2) {
    return [cleanedPage];
  }

  const strongBlocks = blocks.filter((block) => wordCount(block) >= 8);

  if (strongBlocks.length >= 2 && strongBlocks.length <= 3) {
    return strongBlocks;
  }

  return [cleanedPage];
}

function buildSegments(pages) {
  const segments = [];
  let segmentId = 1;
  let position = 1;

  for (const page of pages) {
    const pageText = cleanText(page.text);

    if (!pageText) continue;
    if (isFillerSlide(pageText, page.pageNumber)) continue;

    const parts = splitIntoMeaningfulParts(pageText);

    for (const part of parts) {
      const cleanedPart = cleanText(part);
      if (!cleanedPart) continue;

      segments.push({
        segmentId,
        position,
        source: page.pageNumber,
        text: cleanedPart
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
