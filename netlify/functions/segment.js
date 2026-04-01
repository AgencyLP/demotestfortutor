const pdfParse = require("pdf-parse");

function cleanText(text) {
  return text
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
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function isFillerSlide(text) {
  const normalized = text.toLowerCase().trim();
  const words = wordCount(normalized);

  const fillerPatterns = [
    /^agenda$/,
    /^contents$/,
    /^questions\??$/,
    /^q&a$/,
    /^thank you$/,
    /^thanks$/,
    /^next session$/,
    /^overview$/,
    /^section \d+$/,
    /^part \d+$/,
    /^appendix$/,
    /^title$/,
    /^introduction$/
  ];

  if (fillerPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  if (words <= 6) {
    const shortFillerPatterns = [
      /agenda/,
      /questions?/,
      /q&a/,
      /thank you/,
      /next session/,
      /overview/,
      /appendix/
    ];

    if (shortFillerPatterns.some((pattern) => pattern.test(normalized))) {
      return true;
    }
  }

  return false;
}

function splitIntoMeaningfulParts(pageText) {
  const blocks = pageText
    .split(/\n\s*\n/)
    .map((part) => cleanText(part))
    .filter(Boolean);

  if (blocks.length < 2) {
    return [pageText];
  }

  const strongBlocks = blocks.filter((block) => wordCount(block) >= 8);

  if (strongBlocks.length >= 2 && strongBlocks.length <= 3) {
    return strongBlocks;
  }

  return [pageText];
}

function buildSegments(pages) {
  const segments = [];
  let segmentId = 1;
  let position = 1;

  for (const page of pages) {
    const pageText = cleanText(page.text);

    if (!pageText) {
      continue;
    }

    if (isFillerSlide(pageText)) {
      continue;
    }

    const parts = splitIntoMeaningfulParts(pageText);

    for (const part of parts) {
      const cleanedPart = cleanText(part);

      if (!cleanedPart) {
        continue;
      }

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
