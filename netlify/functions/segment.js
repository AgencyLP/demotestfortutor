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
    text.includes("international taxation in a nutshell") ||
    text.includes("international ll.b. program") ||
    text.includes("faculty of law") ||
    text.includes("thammasat university")
  );
}

function looksLikeCitationOrSourceLine(line) {
  const text = cleanText(line);
  const lower = text.toLowerCase();

  return (
    lower.includes("retrieved from") ||
    lower.startsWith("source:") ||
    lower.includes("http://") ||
    lower.includes("https://") ||
    lower.includes("www.") ||
    /\/[A-Za-z0-9._-]+\.(html|pdf|jpg|jpeg|png)\b/i.test(text) ||
    /^from\s+/i.test(text) ||
    /^retrieved\s+/i.test(text)
  );
}

function stripInlineSourceText(text) {
  return cleanText(
    String(text || "")
      .replace(/\bRetrieved from\b[\s\S]*$/gi, "")
      .replace(/\bSource:\b[\s\S]*$/gi, "")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\bwww\.\S+/gi, "")
      .replace(/\bcr:[A-Za-z0-9-]+\b/gi, "")
      .replace(/\/[A-Za-z0-9._/-]+\.(html|pdf|jpg|jpeg|png)\b/gi, "")
      .replace(/\bThe Phoenix emblem with[^.]*\./gi, "")
      .replace(/\bThe Monument to the Great Fire of London[^.]*\./gi, "")
      .replace(/\bThe Great Fire of London in 1666\.[^.]*\./gi, "")
      .replace(/\bFrom The Great Fire of London[^.]*\./gi, "")
      .replace(/\bRetrieved\b[^.]*\./gi, "")
      .replace(/\bFrom\b[^.]*https?:\/\/\S*/gi, "")
      .replace(/\bFrom\b[^.]*www\.\S*/gi, "")
      .replace(/\bFrom\b[^.]*$/gi, "")
      .replace(/\bbackground\b\.?/gi, "")
      .replace(/\bcr\b[:\s-]?[a-z0-9-]{8,}\b/gi, "")
      .replace(/\b[a-f0-9]{4,}-[a-f0-9-]{4,}\b/gi, "")
      .replace(/\b[a-z0-9]{8,}\b/gi, (match) => {
        return /[0-9]/.test(match) && /[a-z]/i.test(match) ? "" : match;
      })
      .replace(/\s+-\s+/g, " ")
      .replace(/\s{2,}/g, " ")
  ).trim();
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

function removeSlideFurniture(lines) {
  return lines.filter((line, index, arr) => {
    const normalized = normalizeLine(line);
    if (!normalized) return false;
    if (looksLikeBrandingLine(normalized)) return false;
    if (looksLikePageMarker(normalized)) return false;
    if (looksLikeCitationOrSourceLine(line)) return false;

    if (/^\d+$/.test(normalized)) {
      const nearTop = index <= 1;
      const nearBottom = index >= arr.length - 2;
      if (nearTop || nearBottom) return false;
    }

    return true;
  });
}

function buildSlideObjects(pages) {
  return pages
    .map((page) => {
      const cleanedLines = removeSlideFurniture(page.lines);
      const cleanedText = stripInlineSourceText(cleanedLines.join("\n"));

      return {
        source: page.pageNumber,
        text: cleanedText
      };
    })
    .filter((slide) => slide.text);
}

function fallbackSegments(slides) {
  const segments = [];
  let segmentId = 1;
  let position = 1;

  for (const slide of slides) {
    const lines = slide.text
      .split(/\n+/)
      .map((line) => cleanText(line))
      .filter(Boolean);

    if (!lines.length) continue;

    const title = lines[0];
    const text = cleanText(lines.slice(1).join(" ")) || title;

    const combinedWords = cleanText(`${title} ${text}`).split(/\s+/).filter(Boolean).length;

    if (combinedWords <= 8) continue;

    segments.push({
      segmentId,
      position,
      source: slide.source,
      title,
      text: text === title ? "" : text
    });

    segmentId += 1;
    position += 1;
  }

  return segments;
}

async function classifySlidesWithGroq(slides, documentTitle) {
  const apiKey = process.env.GROQ_KEY;

  if (!apiKey) {
    throw new Error("Missing GROQ_KEY environment variable.");
  }

  const prompt = `
You are helping with STEP 1 ONLY of a demo lesson-ingestion pipeline.

Task:
Given a list of cleaned slide texts from one PDF deck, decide which slides should become segments.

Rules:
- Ignore cover/title slides.
- Ignore divider/section-break/filler slides.
- Ignore slides that are only a short heading with no real teaching body.
- Keep real teaching slides.
- For kept slides, return a short title and the main body text.
- Do NOT invent content.
- Do NOT summarize.
- Do NOT include ignored slides in the segments list.
- Usually one kept slide = one segment.
- Keep source as the original slide number.

Return JSON only in this shape:
{
  "segments": [
    {
      "source": 2,
      "title": "The slide heading",
      "text": "Main teaching text from the slide"
    }
  ]
}

Document title: ${documentTitle}

Slides:
${JSON.stringify(slides, null, 2)}
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

function normalizeAiSegments(aiSegments) {
  const segments = [];
  let segmentId = 1;
  let position = 1;

  for (const item of aiSegments) {
    const source = Number(item?.source);
    const title = stripInlineSourceText(item?.title || "");
    const text = stripInlineSourceText(item?.text || "");

    if (!source || (!title && !text)) continue;

    segments.push({
      segmentId,
      position,
      source,
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

    const documentTitle = filenameToTitle(fileName);
    const slides = buildSlideObjects(pages);

    let segments;

    try {
      const aiSegments = await classifySlidesWithGroq(slides, documentTitle);
      segments = normalizeAiSegments(aiSegments);

      if (!segments.length) {
        segments = fallbackSegments(slides);
      }
    } catch (aiError) {
      segments = fallbackSegments(slides);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          debugVersion: "ai-deck-filter-v1-fallback",
          warning: aiError.message,
          document: {
            title: documentTitle
          },
          segments
        })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "ai-deck-filter-v1",
        document: {
          title: documentTitle
        },
        segments
      })
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