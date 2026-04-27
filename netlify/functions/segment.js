const pdfParse = require("pdf-parse");

function cleanText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[•▪◦●]/g, "•")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeLine(line) {
  return cleanText(line).toLowerCase();
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

function sentenceCount(text) {
  return cleanText(text)
    .split(/[.!?]+/)
    .map((part) => cleanText(part))
    .filter(Boolean).length;
}

function uniqueWordCount(text) {
  return new Set(
    cleanText(text)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
  ).size;
}

function isMostlyUppercase(text) {
  const letters = String(text || "").replace(/[^A-Za-z]/g, "");
  if (letters.length < 6) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.72;
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

function looksLikeCitationOrSourceLine(line) {
  const text = cleanText(line);
  const lower = text.toLowerCase();

  return (
    lower.includes("retrieved from") ||
    lower.startsWith("source:") ||
    lower.startsWith("sources:") ||
    lower.includes("http://") ||
    lower.includes("https://") ||
    lower.includes("www.") ||
    /\/[A-Za-z0-9._/-]+\.(html|pdf|jpg|jpeg|png)\b/i.test(text)
  );
}

function looksLikeBrandingLine(line) {
  const text = normalizeLine(line);
  if (!text) return false;

  const genericBrandSignals = [
    /copyright/,
    /all rights reserved/,
    /faculty of/,
    /university$/,
    /school of/,
    /department of/,
    /prepared by/,
    /presented by/
  ];

  return genericBrandSignals.some((pattern) => pattern.test(text));
}

function hasUsefulLatinOrNumber(text) {
  return /[A-Za-z0-9]/.test(String(text || ""));
}

function looksLikeUnreadableSymbolLine(line) {
  const compact = cleanText(line).replace(/\s/g, "");
  if (!compact) return true;
  if (/[A-Za-z0-9]/.test(compact)) return false;
  if (compact.length <= 8) return true;

  const symbolCount = (compact.match(/[^\p{L}\p{N}]/gu) || []).length;
  return symbolCount / compact.length >= 0.6;
}

function looksLikeFontEncodingArtifact(line) {
  const text = cleanText(line);
  if (!text) return true;

  const compact = text.replace(/\s/g, "");
  if (!compact) return true;

  const latinOrNumberCount = (compact.match(/[A-Za-z0-9]/g) || []).length;
  const cjkCount = (compact.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  const symbolCount = (compact.match(/[=+\-*/×÷%()[\]{}<>]/g) || []).length;
  const readableWords = (text.match(/[A-Za-z]{3,}/g) || []).length;

  if (cjkCount >= 3 && latinOrNumberCount === 0) return true;
  if (cjkCount >= 3 && symbolCount > 0 && cjkCount > latinOrNumberCount) return true;
  if (cjkCount >= 2 && readableWords === 0 && cjkCount >= latinOrNumberCount) return true;

  return false;
}

function stripFormulaFontArtifacts(line) {
  const text = cleanText(line);
  const cjkPattern = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g;
  const cjkCount = (text.match(cjkPattern) || []).length;

  if (cjkCount >= 1) {
    const withoutArtifacts = cleanText(text.replace(cjkPattern, " "));
    const readableWords = (withoutArtifacts.match(/[A-Za-z]{3,}/g) || []).length;

    if (!withoutArtifacts || readableWords === 0) return "";
    return withoutArtifacts;
  }

  return text;
}

function looksLikeBrokenFormulaFragment(line) {
  const text = cleanText(line);
  if (!text) return true;
  if (/^[′'`´’]+$/.test(text)) return true;
  if (/[×÷=]/.test(text) && wordCount(text) <= 3 && !/\d/.test(text)) return true;
  return false;
}

function stripInlineNoise(text) {
  return cleanText(
    String(text || "")
      .replace(/\bRetrieved from\b[\s\S]*$/gi, "")
      .replace(/\bSource:\b[\s\S]*$/gi, "")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\bwww\.\S+/gi, "")
      .replace(/[⚡☀️🌬️🌱🍃🍬💧💨🔬🔄]+/g, " ")
      .replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, " ")
      .replace(/\b[a-f0-9]{4,}(?:\s*-\s*[a-f0-9]{4,})+\b/gi, " ")
      .replace(/\b[a-z]*\d+[a-z\d-]*\b/gi, (match) => {
        const hasLetters = /[a-z]/i.test(match);
        const hasDigits = /\d/.test(match);
        return hasLetters && hasDigits && match.length >= 6 ? " " : match;
      })
      .replace(/\s{2,}/g, " ")
  );
}

function groupItemsIntoLines(items) {
  const lineMap = new Map();

  for (const item of items) {
    const str = cleanText(item.str);
    if (!str) continue;

    const y = Math.round(item.transform[5]);
    if (!lineMap.has(y)) lineMap.set(y, []);

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
    if (looksLikeUnreadableSymbolLine(line)) return false;
    if (!hasUsefulLatinOrNumber(line) && looksLikeFontEncodingArtifact(line)) return false;
    if (looksLikeFontEncodingArtifact(line)) return false;
    if (looksLikeBrandingLine(line)) return false;
    if (looksLikePageMarker(line)) return false;
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
      const cleanedText = stripInlineNoise(cleanedLines.join("\n"));
      const lines = cleanedText
        .split(/\n+/)
        .map((line) => stripFormulaFontArtifacts(line))
        .filter((line) => !looksLikeBrokenFormulaFragment(line))
        .filter(Boolean);

      return {
        source: page.pageNumber,
        lines,
        text: cleanText(lines.join("\n"))
      };
    })
    .filter((slide) => slide.text);
}

const META_TITLE_PATTERNS = [
  /^agenda$/i,
  /^outline$/i,
  /^overview$/i,
  /^contents?$/i,
  /^objectives?$/i,
  /^(learning\s+)?objectives?$/i,
  /^today['’]?s?\s+topics?$/i,
  /^topics?$/i,
  /^introduction$/i,
  /^summary$/i,
  /^recap$/i,
  /^review$/i,
  /^(next\s+steps?|wrap[\s-]?up)$/i,
  /^(q\s*&\s*a|questions?)$/i,
  /^thank\s+you$/i,
  /^references?$/i,
  /^appendix$/i,
  /^welcome$/i,
  /^lesson\s+review$/i,
  /^course\s+(overview|outline|objectives?)$/i,
  /^lesson\s+(overview|outline|objectives?)$/i,
  /^module\s+(overview|outline|objectives?)$/i
];

function isMetaHeading(title) {
  const value = cleanText(title).replace(/[:\-–—.!]+$/g, "").trim();
  if (!value) return true;
  return META_TITLE_PATTERNS.some((pattern) => pattern.test(value));
}

function bulletLineCount(lines) {
  return lines.filter((line) => {
    const text = cleanText(line);
    return (
      /^[\u2022\u2023\u25E6\u2043•\-–—*]\s*/.test(text) ||
      /^\d+[.)-]\s+/.test(text) ||
      /✓|✔|☑|□|■|▪/.test(text)
    );
  }).length;
}

function numberedTopicLineCount(lines) {
  return lines.filter((line) => {
    const text = cleanText(line);
    if (!/^\d+[.)-]\s+/.test(text)) return false;
    return wordCount(text.replace(/^\d+[.)-]\s+/, "")) <= 8;
  }).length;
}

function looksLikeTopicListSlide(lines, index) {
  if (!lines.length) return false;

  const numberedTopics = numberedTopicLineCount(lines);
  const bullets = bulletLineCount(lines);
  const shortLines = lines.filter((line) => wordCount(line) <= 8).length;
  const listLikeCount = Math.max(numberedTopics, bullets);
  const shortLineRatio = shortLines / lines.length;

  if (listLikeCount >= 4 && shortLineRatio >= 0.7) return true;
  if (index === 0 && listLikeCount >= 3 && shortLineRatio >= 0.65) return true;

  return false;
}

function titleLooksLikeDeckIntro(title) {
  const value = normalizeLine(title);
  return (
    value.includes("mini-lesson") ||
    value.includes("lesson") ||
    value.includes("test deck") ||
    value.includes("overview")
  );
}

function metaScore(slide, index, totalSlides) {
  const lines = slide.lines || [];
  const text = cleanText(slide.text || "");
  const words = wordCount(text);
  const uniqueWords = uniqueWordCount(text);
  const sentences = sentenceCount(text);
  const firstLine = cleanText(lines[0] || "");
  const normalizedFirst = normalizeLine(firstLine);
  const bullets = bulletLineCount(lines);
  const bulletRatio = lines.length ? bullets / lines.length : 0;

  let score = 0;

  if (!text) score += 10;
  if (index === 0 && words < 40) score += 4;
  if (index === 0 && titleLooksLikeDeckIntro(firstLine)) score += 4;
  if (index === totalSlides - 1 && words < 40) score += 2;
  if (lines.length <= 2 && words <= 16) score += 3;
  if (uniqueWords <= 5 && words <= 12) score += 2;
  if (isMetaHeading(firstLine)) score += 5;
  if (isMostlyUppercase(firstLine) && words < 35) score += 1;
  if (looksLikeTopicListSlide(lines, index)) score += 4;
  if (bulletRatio >= 0.75 && sentences <= 2) score += 2;
  if (/section|part\s+\d+|module\s+\d+|chapter\s+\d+/i.test(normalizedFirst) && words <= 20) score += 3;
  if (/thank you|questions\??|q&a|discussion/i.test(text.toLowerCase()) && words <= 30) score += 4;

  return score;
}

function shouldDropSlide(slide, index, totalSlides) {
  return metaScore(slide, index, totalSlides) >= 5;
}

function looksLikeContinuationLine(line) {
  const text = cleanText(line);
  if (!text) return false;

  return (
    /^[a-z0-9(]/.test(text) ||
    /^[&/:,-]/.test(text) ||
    text.length <= 20
  );
}

function repairBrokenTitle(lines) {
  if (!lines.length) {
    return { title: "", consumedLines: 0 };
  }

  let title = cleanText(lines[0]);
  let consumedLines = 1;

  if (!title) {
    return { title: "", consumedLines: 0 };
  }

  const titleEndsAbruptly =
    /(?:&|and|of|for|to|with|vs\.?|versus|:|-|\/)$/i.test(title) ||
    title.length < 18;

  const nextLine = cleanText(lines[1] || "");

  if (
    nextLine &&
    looksLikeContinuationLine(nextLine) &&
    titleEndsAbruptly &&
    wordCount(`${title} ${nextLine}`) <= 12
  ) {
    title = cleanText(`${title} ${nextLine}`);
    consumedLines = 2;
  }

  return { title, consumedLines };
}

function normalizeDerivedTitle(candidate, fallbackTitle) {
  const value = cleanText(candidate || "");
  const fallback = cleanText(fallbackTitle || "");

  if (!value) return fallback;
  if (wordCount(value) > 12) return fallback;
  if (/^(vs|versus|topic:|stage\s+\d+|inputs|outputs)$/i.test(value)) return fallback;

  return value;
}

function pickTitleAndBody(slide) {
  const lines = (slide.lines || []).filter(Boolean);

  if (!lines.length) {
    return {
      title: `Slide ${slide.source}`,
      text: ""
    };
  }

  const repaired = repairBrokenTitle(lines);
  let title = cleanText(repaired.title || lines[0]);
  let bodyLines = lines.slice(repaired.consumedLines);

  if (wordCount(title) > 14 && lines.length > repaired.consumedLines) {
    title = cleanText(title.split(/[.:!?]\s+/)[0] || title);
  }

  const body = stripInlineNoise(bodyLines.join("\n"));
  return {
    title: stripInlineNoise(title),
    text: body
  };
}

function splitByPanelSignals(title, bodyText) {
  const body = cleanText(bodyText);
  if (!body) return [];

  const normalized = body
    .replace(/\bVS\b/gi, "\nVS\n")
    .replace(/\|\s*/g, "\n")
    .replace(/\bTOPIC\s+\d+\s*:/gi, "\nTOPIC:")
    .replace(/\bStage\s+\d+\s+[—-]\s+/gi, "\nStage ")
    .replace(/\bINPUTS\b/gi, "\nINPUTS\n")
    .replace(/\bOUTPUTS\b/gi, "\nOUTPUTS\n")
    .replace(/\n{3,}/g, "\n\n");

  const blocks = normalized
    .split(/\n(?=(?:TOPIC:|Stage\s+\d+|INPUTS|OUTPUTS))/)
    .map((part) => cleanText(part))
    .filter(Boolean);

  if (blocks.length < 2 || blocks.length > 4) return [];

  const goodBlocks = blocks.filter((part) => wordCount(part) >= 18);
  if (goodBlocks.length < 2) return [];

  return goodBlocks.map((part) => {
    const firstLine = cleanText(part.split("\n")[0] || "");
    const derivedTitle = normalizeDerivedTitle(firstLine, title);

    return {
      title: derivedTitle || title,
      text: part
    };
  });
}

function splitByTwoTopicPattern(title, bodyText) {
  const body = cleanText(bodyText);
  if (!body) return [];

  const lines = body
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);

  const topicMarkers = lines.filter((line) =>
    /^(topic\s*\d+\s*:|stage\s+\d+|part\s+\d+|section\s+\d+|inputs|outputs)/i.test(line)
  );

  if (topicMarkers.length < 2) return [];

  return splitByPanelSignals(title, body);
}

function shouldParagraphSplit(paragraphs) {
  if (paragraphs.length < 2) return false;
  const substantial = paragraphs.filter((part) => wordCount(part) >= 20);
  if (substantial.length < 2) return false;

  const firstTwo = substantial.slice(0, 2);
  const startsDifferently = firstTwo.every((part) => {
    const firstLine = cleanText(part.split("\n")[0] || "");
    return firstLine && wordCount(firstLine) <= 10;
  });

  return startsDifferently;
}

function splitBodyIntoSubsegments(title, bodyText) {
  const body = cleanText(bodyText);
  if (!body) return [];

  const panelSplit = splitByTwoTopicPattern(title, body);
  if (panelSplit.length >= 2) return panelSplit.slice(0, 4);

  const paragraphs = body
    .split(/\n{2,}/)
    .map((part) => cleanText(part))
    .filter(Boolean);

  if (shouldParagraphSplit(paragraphs)) {
    return paragraphs
      .filter((part) => wordCount(part) >= 20)
      .slice(0, 2)
      .map((part) => ({
        title,
        text: part
      }));
  }

  return [{ title, text: body }];
}

function buildSegments(slides) {
  const kept = [];
  let segmentId = 1;
  let position = 1;

  for (let i = 0; i < slides.length; i += 1) {
    const slide = slides[i];

    if (shouldDropSlide(slide, i, slides.length)) {
      continue;
    }

    const { title, text } = pickTitleAndBody(slide);
    const bodyWords = wordCount(text);
    const combinedWords = wordCount(`${title} ${text}`);

    if (combinedWords < 18) continue;
    if (isMetaHeading(title) && bodyWords < 55) continue;

    const parts = splitBodyIntoSubsegments(title, text)
      .filter((part) => wordCount(`${part.title} ${part.text}`) >= 18)
      .slice(0, 4);

    for (const part of parts) {
      kept.push({
        segmentId,
        position,
        source: slide.source,
        title: cleanText(part.title || `Slide ${slide.source}`),
        text: cleanText(part.text || ""),
        meta: false
      });

      segmentId += 1;
      position += 1;
    }
  }

  return kept;
}

function mergeWeakNeighbors(segments) {
  if (!segments.length) return [];

  const merged = [];
  let buffer = null;

  const flush = () => {
    if (!buffer) return;
    merged.push(buffer);
    buffer = null;
  };

  for (const segment of segments) {
    const bodyWords = wordCount(segment.text || "");
    const weak = bodyWords < 22;

    if (!buffer) {
      buffer = { ...segment };
      continue;
    }

    const sameSource = Number(buffer.source) === Number(segment.source);
    const sameTitle =
      normalizeLine(buffer.title || "") === normalizeLine(segment.title || "");

    if (weak && sameSource && sameTitle) {
      buffer.text = cleanText(`${buffer.text}\n\n${segment.text}`);
      continue;
    }

    flush();
    buffer = { ...segment };
  }

  flush();

  return merged.map((segment, index) => ({
    ...segment,
    segmentId: index + 1,
    position: index + 1
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
    const segments = mergeWeakNeighbors(buildSegments(slides));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        debugVersion: "segment-v5-structural",
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
        error: "Failed to segment document.",
        details: error.message
      })
    };
  }
};