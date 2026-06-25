(() => {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const browseBtn = document.getElementById("browseBtn");
  const preview = document.getElementById("preview");
  const previewImg = document.getElementById("previewImg");
  const gradeBtn = document.getElementById("gradeBtn");
  const resetBtn = document.getElementById("resetBtn");
  const uploader = document.getElementById("uploader");
  const loading = document.getElementById("loading");
  const errorBox = document.getElementById("error");
  const results = document.getElementById("results");
  const engineStatus = document.getElementById("engine-status");

  let selectedFile = null;
  let engineReady = false;

  // Hide the "loading engine" banner once OpenCV.js is ready.
  if (window.PokemonGrader && window.PokemonGrader.ready) {
    window.PokemonGrader.ready.then(() => {
      engineReady = true;
      if (engineStatus) hide(engineStatus);
    });
  }

  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  function gradeClass(grade) {
    if (grade >= 8) return "good";
    if (grade >= 5) return "mid";
    return "bad";
  }

  function selectFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      showError("Please choose an image file.");
      return;
    }
    selectedFile = file;
    previewImg.src = URL.createObjectURL(file);
    hide(errorBox);
    hide(results);
    hide(dropzone);
    show(preview);
  }

  function showError(msg) {
    errorBox.textContent = msg;
    show(errorBox);
    hide(loading);
  }

  function reset() {
    selectedFile = null;
    fileInput.value = "";
    hide(preview);
    hide(results);
    hide(errorBox);
    show(dropzone);
  }

  // --- File picking ---
  browseBtn.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("click", (e) => {
    if (e.target === browseBtn) return;
    fileInput.click();
  });
  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) selectFile(e.target.files[0]);
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) selectFile(e.dataTransfer.files[0]);
  });

  resetBtn.addEventListener("click", reset);

  // Load a File into an <img> element and resolve once it's decoded.
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not read that image."));
      img.src = URL.createObjectURL(file);
    });
  }

  // --- Grading (runs entirely in the browser via OpenCV.js) ---
  gradeBtn.addEventListener("click", async () => {
    if (!selectedFile) return;
    hide(uploader);
    hide(errorBox);
    hide(results);
    show(loading);

    try {
      // Make sure the OpenCV engine has finished loading.
      await window.PokemonGrader.ready;
      const img = await loadImage(selectedFile);
      // Yield a frame so the spinner paints before the heavy sync work.
      await new Promise((r) => setTimeout(r, 30));
      const data = window.PokemonGrader.grade(img);
      renderResults(data);
    } catch (err) {
      show(uploader);
      showError(err && err.message ? err.message : "Failed to analyze image.");
    } finally {
      hide(loading);
    }
  });

  function setSubgrade(id, grade, detail, extraHtml) {
    const el = document.getElementById(id);
    const gradeEl = el.querySelector(".sg-grade");
    gradeEl.textContent = grade;
    gradeEl.className = "sg-grade " + gradeClass(grade);
    el.querySelector(".sg-detail").textContent = detail;
    const extra = el.querySelector(".sg-extra");
    if (extra) extra.innerHTML = extraHtml || "";
  }

  function renderResults(data) {
    document.getElementById("overallGrade").textContent = data.headline_grade;
    document.getElementById("gradeLabel").textContent =
      `PSA ${data.headline_grade} — ${data.label}`;

    const notes = [];
    notes.push(`Weighted score: ${data.overall}/10.`);
    if (!data.card_detected) notes.push("Card edges weren't detected confidently — frame the card fully for a better read.");
    if (!data.frame_confident) notes.push("Inner border was estimated.");
    document.getElementById("gradeNote").textContent = notes.join(" ");

    const c = data.subgrades.centering;
    const centeringExtra = `
      <div class="ratio-row"><span>Left / Right</span><span>${c.left_right}</span></div>
      <div class="ratio-row"><span>Top / Bottom</span><span>${c.top_bottom}</span></div>
      <div class="ratio-row"><span>Worst side</span><span>${c.worst_ratio}%</span></div>
    `;
    setSubgrade("sg-centering", c.grade, c.detail, centeringExtra);
    setSubgrade("sg-corners", data.subgrades.corners.grade, data.subgrades.corners.detail);
    setSubgrade("sg-edges", data.subgrades.edges.grade, data.subgrades.edges.detail);
    setSubgrade("sg-surface", data.subgrades.surface.grade, data.subgrades.surface.detail);

    show(results);
    show(uploader);
  }
})();
