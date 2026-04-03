const uploadForm = document.getElementById("uploadForm");
const pdfFileInput = document.getElementById("pdfFile");
const jsonOutput = document.getElementById("jsonOutput");
const statusEl = document.getElementById("status");
const copyBtn = document.getElementById("copyBtn");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b91c1c" : "#374151";
}

function renderJson(data) {
  jsonOutput.textContent = JSON.stringify(data, null, 2);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${url}`);
  }

  return data;
}

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = pdfFileInput.files[0];
  if (!file) {
    setStatus("Please choose a PDF first.", true);
    return;
  }

  if (file.type !== "application/pdf") {
    setStatus("Only PDF files are allowed.", true);
    return;
  }

  setStatus("Running ingestion pipeline...");

  try {
    const arrayBuffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);

    setStatus("Step 1/7: segmenting...");
    const segmentData = await postJson("/.netlify/functions/segment", {
      fileName: file.name,
      pdfBase64: base64
    });

    setStatus("Step 2/7: extracting concepts...");
    const conceptsData = await postJson("/.netlify/functions/concepts", {
      document: segmentData.document,
      segments: segmentData.segments
    });

    setStatus("Step 3/7: matching concepts...");
    const matchData = await postJson("/.netlify/functions/match-concepts", {
      document: segmentData.document,
      segments: segmentData.segments,
      concepts: conceptsData.concepts
    });

    setStatus("Step 4/7: tagging roles...");
    const rolesData = await postJson("/.netlify/functions/roles", {
      document: segmentData.document,
      segments: matchData.segments
    });

    setStatus("Step 5/7: checking dependencies...");
    const dependenciesData = await postJson("/.netlify/functions/dependencies", {
      document: segmentData.document,
      segments: rolesData.segments,
      concepts: conceptsData.concepts
    });

    setStatus("Step 6/7: resolving cross-concept relationships...");
    const relationshipsData = await postJson("/.netlify/functions/chunk-relationships", {
      document: segmentData.document,
      segments: dependenciesData.segments,
      concepts: conceptsData.concepts
    });

    setStatus("Step 7/7: assembling chunks...");
    const chunksData = await postJson("/.netlify/functions/chunks", {
      document: segmentData.document,
      segments: relationshipsData.segments
    });

    const finalJson = {
      debugVersion: "lesson-map-v7",
      document: segmentData.document,
      segments: relationshipsData.segments,
      concepts: conceptsData.concepts,
      chunks: chunksData.chunks
    };

    const warnings = [
      segmentData.warning,
      conceptsData.warning,
      matchData.warning,
      rolesData.warning,
      dependenciesData.warning,
      relationshipsData.warning,
      chunksData.warning,
      ...(segmentData.warnings || []),
      ...(conceptsData.warnings || []),
      ...(matchData.warnings || []),
      ...(rolesData.warnings || []),
      ...(dependenciesData.warnings || []),
      ...(relationshipsData.warnings || []),
      ...(chunksData.warnings || [])
    ].filter(Boolean);

    if (warnings.length) {
      finalJson.warnings = warnings;
    }

    renderJson(finalJson);
    setStatus("Pipeline complete.");
  } catch (error) {
    renderJson({ error: error.message || "Something went wrong." });
    setStatus("Pipeline failed.", true);
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(jsonOutput.textContent);
    setStatus("JSON copied.");
  } catch {
    setStatus("Could not copy JSON.", true);
  }
});