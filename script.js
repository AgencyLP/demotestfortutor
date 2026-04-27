const uploadForm = document.getElementById("uploadForm");
const pdfFileInput = document.getElementById("pdfFile");
const jsonOutput = document.getElementById("jsonOutput");
const statusEl = document.getElementById("status");
const copyBtn = document.getElementById("copyBtn");
const teachPlanCard = document.getElementById("teachPlanCard");
const chunkSelect = document.getElementById("chunkSelect");
const teachPlanBtn = document.getElementById("teachPlanBtn");
const teachPlanOutput = document.getElementById("teachPlanOutput");
const teachingDemo = document.getElementById("teachingDemo");
const startTeachingBtn = document.getElementById("startTeachingBtn");
const conversation = document.getElementById("conversation");
const learnerAnswer = document.getElementById("learnerAnswer");
const sendAnswerBtn = document.getElementById("sendAnswerBtn");

let currentLessonMap = null;
let currentTeachPlan = null;
let teachingState = null;

const INTRO_TEMPLATES = [
  "Hey there! Hope you're doing well. Today we're going to dive into {topic}. Don't worry, it's less complicated than it sounds. But before I teach it, let me ask you something.",
  "Hi! Today we're going to take on {topic} together. We'll keep it simple and go step by step. Before I explain, I want to see what you already think.",
  "Hey, welcome in. Today we're looking at {topic}; it might sound a little heavy, but we can make it clear. Before we start, quick question for you."
];

const PROBE_TRANSITIONS = [
  "What is your first guess?",
  "No pressure, just tell me what comes to mind.",
  "Give it a try in your own words.",
  "Even a rough answer is fine here."
];

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b91c1c" : "#374151";
}

function renderJson(data) {
  jsonOutput.textContent = JSON.stringify(data, null, 2);
}

function renderTeachPlan(data) {
  teachPlanOutput.textContent = JSON.stringify(data, null, 2);
}

function setTeachingEnabled(enabled) {
  learnerAnswer.disabled = !enabled;
  sendAnswerBtn.disabled = !enabled;
}

function addMessage(role, text) {
  const message = document.createElement("div");
  message.className = `message ${role}`;
  message.textContent = text;
  conversation.appendChild(message);
  conversation.scrollTop = conversation.scrollHeight;
}

function resetTeachingDemo() {
  teachingState = null;
  conversation.innerHTML = "";
  learnerAnswer.value = "";
  setTeachingEnabled(false);
}

function getCurrentSubIdea() {
  const subIdeas = currentTeachPlan?.subIdeas || [];
  return subIdeas[teachingState?.subIdeaIndex || 0] || subIdeas[0] || null;
}

function getLearnerLevel() {
  const level = teachingState?.learnerLevel || "beginner";
  return ["beginner", "partial", "strong"].includes(level) ? level : "beginner";
}

function getLevelPath(subIdea) {
  const level = getLearnerLevel();
  const paths = subIdea?.levelPaths || {};
  const fallbackTeach = subIdea?.explanation || "";
  const fallbackCheck = subIdea?.checkQuestion || "";

  return {
    level,
    teach: paths[level]?.teach || paths.beginner?.teach || fallbackTeach,
    teachOrder: paths[level]?.teachOrder || [],
    check: paths[level]?.check || paths.beginner?.check || fallbackCheck
  };
}

function getApplyTask() {
  const level = getLearnerLevel();
  const tasks = currentTeachPlan?.applyTasks || {};
  return tasks[level] || tasks.beginner || currentTeachPlan?.applyTask || "";
}

function randomIntro(topic) {
  const template = INTRO_TEMPLATES[Math.floor(Math.random() * INTRO_TEMPLATES.length)];
  const cleanTopic = String(topic || "this topic")
    .replace(/^what\s+(is|are)\s+/i, "")
    .replace(/[?.!]+$/g, "")
    .trim();

  return template.replace("{topic}", cleanTopic || "this topic");
}

function randomProbeTransition() {
  return PROBE_TRANSITIONS[Math.floor(Math.random() * PROBE_TRANSITIONS.length)];
}

function askProbe() {
  teachingState = {
    stage: "probe",
    subIdeaIndex: 0,
    learnerLevel: null
  };

  conversation.innerHTML = "";
  addMessage("tutor", randomIntro(currentTeachPlan.chunkTitle));
  addMessage("tutor", randomProbeTransition());
  addMessage("tutor", currentTeachPlan.probeQuestion);
  setTeachingEnabled(true);
}

function teachCurrentSubIdea() {
  const subIdea = getCurrentSubIdea();
  if (!subIdea) {
    askApply();
    return;
  }

  teachingState.stage = "check";
  const path = getLevelPath(subIdea);
  addMessage("system", `Teaching path: ${path.level}`);

  if (path.level === "beginner" && Array.isArray(path.teachOrder) && path.teachOrder.length) {
    for (const item of path.teachOrder) {
      addMessage("tutor", item.text);
    }
  } else {
    addMessage("tutor", path.teach);
  }

  addMessage("tutor", path.check);
  setTeachingEnabled(true);
}

function askApply() {
  teachingState.stage = "apply";
  addMessage("tutor", getApplyTask());
  setTeachingEnabled(true);
}

function askSummary(evaluation) {
  teachingState.stage = "summary";
  addMessage("system", `Evaluation: ${evaluation.result}\n${evaluation.diagnosis}`);
  addMessage("tutor", evaluation.feedback);
  addMessage("tutor", currentTeachPlan.consolidatePrompt || "Summarize the main points in your own words.");
  setTeachingEnabled(true);
}

function finishLesson(evaluation) {
  teachingState.stage = "done";
  addMessage("system", `Summary result: ${evaluation.result}\n${evaluation.diagnosis}`);
  addMessage("tutor", evaluation.feedback);
  addMessage("tutor", "Nice. That finishes this chunk.");
  setTeachingEnabled(false);
}

function evaluationDebugLine(evaluation) {
  const parts = [];
  if (evaluation.model) parts.push(`Model: ${evaluation.model}`);
  if (evaluation.warning) parts.push(`Warning: ${evaluation.warning}`);
  if ((evaluation.warnings || []).length) {
    parts.push(`Details: ${evaluation.warnings.join(" | ")}`);
  }
  return parts.join("\n");
}

function updateChunkSelector(lessonMap) {
  chunkSelect.innerHTML = "";

  for (const chunk of lessonMap.chunks || []) {
    const option = document.createElement("option");
    option.value = String(chunk.chunkId);
    option.textContent = `Chunk ${chunk.chunkId}: ${chunk.title}`;
    chunkSelect.appendChild(option);
  }

  teachPlanCard.classList.toggle("hidden", !(lessonMap.chunks || []).length);
  currentTeachPlan = null;
  teachingDemo.classList.add("hidden");
  resetTeachingDemo();
  renderTeachPlan({
    message: "Choose one chunk and click Generate Teach Plan."
  });
}

function filterUsedConcepts(concepts, segments, chunks) {
  const usedNames = new Set();

  for (const segment of segments || []) {
    if (segment.concept) usedNames.add(segment.concept);
    if (segment.secondaryConcept) usedNames.add(segment.secondaryConcept);
  }

  for (const chunk of chunks || []) {
    if (chunk.mainConcept) usedNames.add(chunk.mainConcept);
    if (chunk.secondaryConcept) usedNames.add(chunk.secondaryConcept);
  }

  const filtered = (concepts || []).filter((concept) => usedNames.has(concept.name));
  return filtered.length ? filtered : concepts;
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
      concepts: filterUsedConcepts(
        conceptsData.concepts,
        relationshipsData.segments,
        chunksData.chunks
      ),
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

    currentLessonMap = finalJson;
    updateChunkSelector(finalJson);
    renderJson(finalJson);
    setStatus("Pipeline complete.");
  } catch (error) {
    currentLessonMap = null;
    teachPlanCard.classList.add("hidden");
    renderJson({ error: error.message || "Something went wrong." });
    setStatus("Pipeline failed.", true);
  }
});

teachPlanBtn.addEventListener("click", async () => {
  if (!currentLessonMap) {
    setStatus("Generate a lesson map first.", true);
    return;
  }

  const selectedChunkId = Number(chunkSelect.value);
  const chunk = (currentLessonMap.chunks || []).find(
    (item) => Number(item.chunkId) === selectedChunkId
  );

  if (!chunk) {
    setStatus("Choose a chunk first.", true);
    return;
  }

  teachPlanBtn.disabled = true;
  setStatus(`Generating teach plan for chunk ${chunk.chunkId}...`);

  try {
    const teachPlan = await postJson("/.netlify/functions/teach-plan", {
      document: currentLessonMap.document,
      chunk,
      segments: currentLessonMap.segments,
      concepts: currentLessonMap.concepts
    });

    currentTeachPlan = teachPlan;
    teachingDemo.classList.remove("hidden");
    resetTeachingDemo();
    renderTeachPlan(teachPlan);
    setStatus("Teach plan complete.");
  } catch (error) {
    renderTeachPlan({ error: error.message || "Could not generate teach plan." });
    setStatus("Teach plan failed.", true);
  } finally {
    teachPlanBtn.disabled = false;
  }
});

startTeachingBtn.addEventListener("click", () => {
  if (!currentTeachPlan) {
    setStatus("Generate a teach plan first.", true);
    return;
  }

  askProbe();
  setStatus("Teaching demo started.");
});

sendAnswerBtn.addEventListener("click", async () => {
  if (!currentTeachPlan || !teachingState) {
    setStatus("Start the teaching demo first.", true);
    return;
  }

  const answer = learnerAnswer.value.trim();
  if (!answer) {
    setStatus("Type an answer first.", true);
    return;
  }

  const subIdea = getCurrentSubIdea();
  const stage = teachingState.stage;
  const question =
    stage === "probe"
      ? currentTeachPlan.probeQuestion
      : stage === "apply"
        ? getApplyTask()
        : stage === "summary"
          ? currentTeachPlan.consolidatePrompt
          : getLevelPath(subIdea).check || "";
  const expectedUnderstanding =
    stage === "probe"
      ? currentTeachPlan.objective
      : stage === "apply"
        ? `${currentTeachPlan.objective}\n${getApplyTask()}`
        : stage === "summary"
          ? `${currentTeachPlan.objective}\n${(currentTeachPlan.subIdeas || []).map((item) => {
              const paths = item.levelPaths || {};
              return [
                paths.beginner?.teach,
                paths.partial?.teach,
                paths.strong?.teach
              ].filter(Boolean).join("\n");
            }).join("\n")}`
          : `${subIdea?.title || ""}\n${getLevelPath(subIdea).teach || ""}`;

  addMessage("learner", answer);
  learnerAnswer.value = "";
  setTeachingEnabled(false);
  setStatus("Evaluating learner answer...");

  try {
    const evaluation = await postJson("/.netlify/functions/teach-evaluate", {
      stage,
      teachPlan: currentTeachPlan,
      question,
      expectedUnderstanding,
      learnerAnswer: answer
    });

    if (stage === "probe") {
      teachingState.learnerLevel = ["beginner", "partial", "strong"].includes(evaluation.result)
        ? evaluation.result
        : "beginner";
      addMessage("system", `Starting level: ${evaluation.result}\n${evaluation.diagnosis}`);
      const debugLine = evaluationDebugLine(evaluation);
      if (debugLine) addMessage("system", debugLine);
      addMessage("system", "Personalized starting point");
      addMessage("tutor", evaluation.feedback);
      teachCurrentSubIdea();
      setStatus("Probe evaluated.");
      return;
    }

    if (stage === "check") {
      addMessage("system", `Check result: ${evaluation.result}\n${evaluation.diagnosis}`);
      const debugLine = evaluationDebugLine(evaluation);
      if (debugLine) addMessage("system", debugLine);
      addMessage("tutor", evaluation.feedback);

      const nextIndex = teachingState.subIdeaIndex + 1;
      if (evaluation.result === "wrong") {
        addMessage("tutor", `Let's try that another way: ${subIdea?.misconceptionToWatchFor || "focus on the main idea first."}`);
      }

      if (nextIndex < (currentTeachPlan.subIdeas || []).length) {
        teachingState.subIdeaIndex = nextIndex;
        teachCurrentSubIdea();
      } else {
        askApply();
      }

      setStatus("Check evaluated.");
      return;
    }

    if (stage === "summary") {
      finishLesson(evaluation);
      const debugLine = evaluationDebugLine(evaluation);
      if (debugLine) addMessage("system", debugLine);
      setStatus("Summary evaluated.");
      return;
    }

    askSummary(evaluation);
    const debugLine = evaluationDebugLine(evaluation);
    if (debugLine) addMessage("system", debugLine);
    setStatus("Apply answer evaluated.");
  } catch (error) {
    addMessage("system", error.message || "Could not evaluate answer.");
    setTeachingEnabled(true);
    setStatus("Evaluation failed.", true);
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