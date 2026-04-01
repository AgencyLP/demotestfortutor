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

  setStatus("Running Steps 1 to 5...");

  try {
    const arrayBuffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);

    const segmentResponse = await fetch("/.netlify/functions/segment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fileName: file.name,
        pdfBase64: base64
      })
    });

    const segmentData = await segmentResponse.json();

    if (!segmentResponse.ok) {
      throw new Error(segmentData.error || "Step 1 failed.");
    }

    const conceptsResponse = await fetch("/.netlify/functions/concepts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        document: segmentData.document,
        segments: segmentData.segments
      })
    });

    const conceptsData = await conceptsResponse.json();

    if (!conceptsResponse.ok) {
      throw new Error(conceptsData.error || "Step 2 failed.");
    }

    const matchResponse = await fetch("/.netlify/functions/match-concepts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        document: segmentData.document,
        segments: segmentData.segments,
        concepts: conceptsData.concepts
      })
    });

    const matchData = await matchResponse.json();

    if (!matchResponse.ok) {
      throw new Error(matchData.error || "Step 3 failed.");
    }

    const rolesResponse = await fetch("/.netlify/functions/roles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        document: segmentData.document,
        segments: matchData.segments
      })
    });

    const rolesData = await rolesResponse.json();

    if (!rolesResponse.ok) {
      throw new Error(rolesData.error || "Step 4 failed.");
    }

    const dependenciesResponse = await fetch("/.netlify/functions/dependencies", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        document: segmentData.document,
        segments: rolesData.segments,
        concepts: conceptsData.concepts
      })
    });

    const dependenciesData = await dependenciesResponse.json();

    if (!dependenciesResponse.ok) {
      throw new Error(dependenciesData.error || "Step 5 failed.");
    }

    const combined = {
      debugVersion: "lesson-map-v4",
      document: segmentData.document,
      segments:
        dependenciesData.segments ||
        rolesData.segments ||
        matchData.segments ||
        segmentData.segments ||
        [],
      concepts: conceptsData.concepts || []
    };

    if (segmentData.warning) combined.segmentWarning = segmentData.warning;
    if (conceptsData.warning) combined.conceptWarning = conceptsData.warning;
    if (matchData.warning) combined.matchWarning = matchData.warning;
    if (rolesData.warning) combined.roleWarning = rolesData.warning;
    if (dependenciesData.warning) combined.dependencyWarning = dependenciesData.warning;

    renderJson(combined);
    setStatus("Lesson map generated.");
  } catch (error) {
    renderJson({
      error: error.message || "Something went wrong."
    });
    setStatus("Something went wrong.", true);
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