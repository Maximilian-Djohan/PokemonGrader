/*
 * Client-side Pokemon card grading engine (runs entirely in the browser).
 *
 * This is a faithful port of grader.py to OpenCV.js so the app can be hosted
 * as a fully static site (e.g. GitHub Pages) with no backend. It exposes:
 *
 *     window.PokemonGrader.ready   -> Promise that resolves when OpenCV is loaded
 *     window.PokemonGrader.grade(imgEl) -> report object (same shape as the API)
 *
 * Centering is measured directly from border "edge distances"; corners, edges
 * and surface are heuristic estimates.
 */
(() => {
  // --- OpenCV.js readiness ------------------------------------------------
  let resolveReady;
  const ready = new Promise((res) => (resolveReady = res));
  function maybeResolve() {
    if (window.cv && window.cv.Mat) { resolveReady(); return true; }
    return false;
  }
  // index.html dispatches this once OpenCV's runtime is initialised.
  document.addEventListener("opencv-loaded", maybeResolve);
  // Fallback poll in case the load event fired before this listener attached
  // or used an init style we didn't catch.
  const poll = setInterval(() => { if (maybeResolve()) clearInterval(poll); }, 150);
  setTimeout(() => clearInterval(poll), 60000);

  // PSA front-centering tolerances: grade -> worst allowable larger-side %.
  const CENTERING_TOLERANCES = [
    [10, 55], [9, 60], [8, 65], [7, 70], [6, 75],
    [5, 80], [4, 85], [3, 90], [2, 95], [1, 100],
  ];

  const GRADE_LABELS = {
    10: "Gem Mint", 9: "Mint", 8: "Near Mint-Mint", 7: "Near Mint",
    6: "Excellent-Mint", 5: "Excellent", 4: "Very Good-Excellent",
    3: "Very Good", 2: "Good", 1: "Poor",
  };

  // --- small helpers ------------------------------------------------------
  function laplacianVariance(gray) {
    const lap = new cv.Mat();
    const mean = new cv.Mat();
    const std = new cv.Mat();
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, std);
    const s = std.doubleAt(0, 0);
    lap.delete(); mean.delete(); std.delete();
    return s * s;
  }

  // Fraction of pixels in a single-channel Mat above `thresh`.
  function brightRatio(gray, thresh) {
    if (gray.rows === 0 || gray.cols === 0) return 0;
    const m = new cv.Mat();
    cv.threshold(gray, m, thresh, 255, cv.THRESH_BINARY);
    const ratio = cv.countNonZero(m) / (gray.rows * gray.cols);
    m.delete();
    return ratio;
  }

  function clampGrade(g) {
    return Math.max(1, Math.min(10, g));
  }

  // --- card detection (deskew) -------------------------------------------
  function detectCard(src) {
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    let result = { mat: src.clone(), found: false };
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      cv.Canny(blur, edges, 50, 150);
      const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);
      kernel.delete();

      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      if (contours.size() === 0) return result;

      let biggest = null, biggestArea = 0;
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const a = cv.contourArea(c);
        if (a > biggestArea) { biggestArea = a; biggest = c; }
      }
      const imgArea = src.rows * src.cols;
      if (!biggest || biggestArea < 0.2 * imgArea) return result;

      const peri = cv.arcLength(biggest, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(biggest, 0.02 * peri, approx, true);

      if (approx.rows !== 4) {
        const rect = cv.boundingRect(biggest);
        approx.delete();
        result.mat.delete();
        result = { mat: src.roi(rect).clone(), found: true };
        return result;
      }

      // Order the 4 corners (tl, tr, br, bl).
      const pts = [];
      for (let i = 0; i < 4; i++) {
        pts.push({ x: approx.data32S[i * 2], y: approx.data32S[i * 2 + 1] });
      }
      approx.delete();
      const ordered = orderPoints(pts);
      const [tl, tr, br, bl] = ordered;
      const widthA = Math.hypot(br.x - bl.x, br.y - bl.y);
      const widthB = Math.hypot(tr.x - tl.x, tr.y - tl.y);
      const heightA = Math.hypot(tr.x - br.x, tr.y - br.y);
      const heightB = Math.hypot(tl.x - bl.x, tl.y - bl.y);
      const W = Math.round(Math.max(widthA, widthB));
      const H = Math.round(Math.max(heightA, heightB));
      if (W < 10 || H < 10) return result;

      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2,
        [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2,
        [0, 0, W - 1, 0, W - 1, H - 1, 0, H - 1]);
      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      const warped = new cv.Mat();
      cv.warpPerspective(src, warped, M, new cv.Size(W, H));
      srcTri.delete(); dstTri.delete(); M.delete();

      result.mat.delete();
      result = { mat: warped, found: true };
      return result;
    } finally {
      gray.delete(); blur.delete(); edges.delete();
      contours.delete(); hierarchy.delete();
    }
  }

  function orderPoints(pts) {
    // tl = min(x+y), br = max(x+y), tr = min(x-y)... use diff (y-x style).
    const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = bySum[0];
    const br = bySum[bySum.length - 1];
    const byDiff = [...pts].sort((a, b) => (a.x - a.y) - (b.x - b.y));
    const bl = byDiff[0];
    const tr = byDiff[byDiff.length - 1];
    return [tl, tr, br, bl];
  }

  // --- inner frame detection (edge distances) ----------------------------
  function detectInnerFrame(card) {
    const h = card.rows, w = card.cols;
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    try {
      cv.cvtColor(card, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      cv.Canny(blur, edges, 40, 120);
      const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 1);
      kernel.delete();

      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const cardArea = h * w;
      let best = null, bestArea = 0;
      for (let i = 0; i < contours.size(); i++) {
        const r = cv.boundingRect(contours.get(i));
        const area = r.width * r.height;
        if (area > 0.25 * cardArea && area < 0.9 * cardArea && area > bestArea) {
          best = r; bestArea = area;
        }
      }

      if (!best) {
        const m = Math.round(Math.min(h, w) * 0.08);
        return { left: m, right: m, top: m, bottom: m, width: w, height: h, confident: false };
      }
      return {
        left: Math.max(best.x, 0),
        right: Math.max(w - (best.x + best.width), 0),
        top: Math.max(best.y, 0),
        bottom: Math.max(h - (best.y + best.height), 0),
        width: w, height: h, confident: true,
      };
    } finally {
      gray.delete(); blur.delete(); edges.delete();
      contours.delete(); hierarchy.delete();
    }
  }

  function centeringScore(frame) {
    const split = (a, b) => {
      const t = a + b;
      if (t === 0) return [50, 50];
      return [100 * a / t, 100 * b / t];
    };
    const [lrA, lrB] = split(frame.left, frame.right);
    const [tbA, tbB] = split(frame.top, frame.bottom);
    const worst = Math.max(lrA, lrB, tbA, tbB);
    let grade = 1;
    for (const [g, tol] of CENTERING_TOLERANCES) {
      if (worst <= tol) { grade = g; break; }
    }
    return {
      left_right: `${Math.round(lrA)}/${Math.round(lrB)}`,
      top_bottom: `${Math.round(tbA)}/${Math.round(tbB)}`,
      worst_ratio: Math.round(worst * 10) / 10,
      grade,
    };
  }

  function cornerScore(card) {
    const h = card.rows, w = card.cols;
    const cs = Math.round(Math.min(h, w) * 0.12);
    const gray = new cv.Mat();
    cv.cvtColor(card, gray, cv.COLOR_RGBA2GRAY);
    const rects = [
      new cv.Rect(0, 0, cs, cs),
      new cv.Rect(w - cs, 0, cs, cs),
      new cv.Rect(0, h - cs, cs, cs),
      new cv.Rect(w - cs, h - cs, cs, cs),
    ];
    const penalties = [];
    for (const r of rects) {
      const patch = gray.roi(r);
      const bright = brightRatio(patch, 200);
      const detail = laplacianVariance(patch);
      const detailPen = Math.max(0, 1 - Math.min(detail / 300, 1));
      penalties.push(Math.min(1, bright * 1.5 + detailPen * 0.5));
      patch.delete();
    }
    gray.delete();
    const avg = penalties.reduce((a, b) => a + b, 0) / penalties.length;
    return { grade: clampGrade(Math.round(10 - avg * 6)), penalty: Math.round(avg * 100) / 100 };
  }

  function edgeScore(card) {
    const h = card.rows, w = card.cols;
    const t = Math.max(3, Math.round(Math.min(h, w) * 0.02));
    const gray = new cv.Mat();
    cv.cvtColor(card, gray, cv.COLOR_RGBA2GRAY);
    const rects = [
      new cv.Rect(0, 0, w, t),
      new cv.Rect(0, h - t, w, t),
      new cv.Rect(0, 0, t, h),
      new cv.Rect(w - t, 0, t, h),
    ];
    const vals = [];
    for (const r of rects) {
      const strip = gray.roi(r);
      vals.push(brightRatio(strip, 205));
      strip.delete();
    }
    gray.delete();
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { grade: clampGrade(Math.round(10 - Math.min(avg * 3, 1) * 6)), penalty: Math.round(avg * 100) / 100 };
  }

  function surfaceScore(card) {
    const gray = new cv.Mat();
    cv.cvtColor(card, gray, cv.COLOR_RGBA2GRAY);
    const focus = laplacianVariance(gray);
    const focusPen = Math.max(0, 1 - Math.min(focus / 500, 1));

    const blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(0, 0), 3);
    const diff = new cv.Mat();
    cv.absdiff(gray, blur, diff);
    const scratch = brightRatio(diff, 40);
    blur.delete(); diff.delete(); gray.delete();

    const pen = Math.min(1, focusPen * 0.6 + scratch * 4);
    return { grade: clampGrade(Math.round(10 - pen * 6)), penalty: Math.round(pen * 100) / 100 };
  }

  function overall(centering, corners, edges, surface) {
    const sub = [centering, corners, edges, surface];
    const weighted = 0.4 * centering + 0.2 * corners + 0.2 * edges + 0.2 * surface;
    const capped = Math.min(weighted, Math.min(...sub) + 1);
    return Math.round(capped * 10) / 10;
  }

  // --- public entry point -------------------------------------------------
  function grade(imgEl) {
    // Read & normalise size (max dim 1600), matching grader.py.
    let src = cv.imread(imgEl);
    const maxDim = 1600;
    const m = Math.max(src.rows, src.cols);
    if (m > maxDim) {
      const scale = maxDim / m;
      const resized = new cv.Mat();
      cv.resize(src, resized, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
      src.delete();
      src = resized;
    }

    const { mat: card, found } = detectCard(src);
    try {
      const frame = detectInnerFrame(card);
      const centering = centeringScore(frame);
      const corners = cornerScore(card);
      const edges = edgeScore(card);
      const surface = surfaceScore(card);
      const ov = overall(centering.grade, corners.grade, edges.grade, surface.grade);
      const headline = clampGrade(Math.round(ov));

      return {
        overall: ov,
        headline_grade: headline,
        label: GRADE_LABELS[headline] || "",
        card_detected: found,
        frame_confident: frame.confident,
        subgrades: {
          centering: {
            grade: centering.grade,
            left_right: centering.left_right,
            top_bottom: centering.top_bottom,
            worst_ratio: centering.worst_ratio,
            detail: "Measured directly from border edge distances.",
          },
          corners: { grade: corners.grade, penalty: corners.penalty, detail: "Estimated from corner sharpness and whitening." },
          edges: { grade: edges.grade, penalty: edges.penalty, detail: "Estimated from whitening along the perimeter." },
          surface: { grade: surface.grade, penalty: surface.penalty, detail: "Estimated from focus and scratch/print-defect density." },
        },
      };
    } finally {
      card.delete();
      src.delete();
    }
  }

  window.PokemonGrader = { ready, grade };
})();
