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

  setStatus("Reading PDF and running Step 1...");

  try {
    const arrayBuffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);

    const response = await fetch("/.netlify/functions/segment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fileName: file.name,
        pdfBase64: base64
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }

    renderJson(data);
    setStatus("Step 1 complete.");
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
