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

  setStatus("Uploading PDF and running test...");

  const formData = new FormData();
  formData.append("pdfFile", file);

  try {
    const response = await fetch("/.netlify/functions/segment", {
      method: "POST",
      body: formData,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }

    renderJson(data);
    setStatus("Done.");
  } catch (error) {
    renderJson({
      error: error.message || "Something went wrong.",
    });
    setStatus("Something went wrong.", true);
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(jsonOutput.textContent);
    setStatus("JSON copied.");
  } catch (error) {
    setStatus("Could not copy JSON.", true);
  }
});
