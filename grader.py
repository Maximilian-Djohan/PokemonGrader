"""
Pokemon card grading engine.

Approximates the four PSA sub-grades from a single front image:

  * Centering  -- measured directly from border ("edge distance") geometry.
  * Corners    -- estimated from corner sharpness / whitening.
  * Edges      -- estimated from whitening along the card perimeter.
  * Surface    -- estimated from focus, scratches and print defects.

Centering is the only sub-grade PSA defines with hard numeric tolerances, so
it is computed rigorously here. The other three are heuristic estimates from
image statistics and should be read as guidance, not a substitute for a human
grader. The overall grade follows PSA's convention of being driven by the
weakest relevant attribute (with centering weighted heavily).
"""

from __future__ import annotations

import cv2
import numpy as np


# ---------------------------------------------------------------------------
# PSA centering tolerances (front of card).
#
# Each entry maps a grade to the *worst* allowable centering on either axis,
# expressed as the larger side's percentage. e.g. 55 means up to a 55/45 split
# still qualifies. Pokemon / modern TCG cards are graded on the 55/45 front
# tolerance for a PSA 10.
# ---------------------------------------------------------------------------
CENTERING_TOLERANCES = [
    (10, 55),
    (9, 60),
    (8, 65),
    (7, 70),
    (6, 75),
    (5, 80),
    (4, 85),
    (3, 90),
    (2, 95),
    (1, 100),
]


def _read_image(path: str) -> np.ndarray:
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not read image. Is it a valid JPG/PNG?")
    # Normalise size so analysis is consistent and fast.
    max_dim = 1600
    h, w = img.shape[:2]
    scale = max_dim / max(h, w)
    if scale < 1:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img


def _largest_quad(mask: np.ndarray):
    """Return the largest 4-point contour (approx) found in a binary mask."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    biggest = max(contours, key=cv2.contourArea)
    peri = cv2.arcLength(biggest, True)
    approx = cv2.approxPolyDP(biggest, 0.02 * peri, True)
    return biggest, approx


def _order_points(pts: np.ndarray) -> np.ndarray:
    """Order 4 points as top-left, top-right, bottom-right, bottom-left."""
    pts = pts.reshape(4, 2).astype("float32")
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


def _detect_card(img: np.ndarray):
    """Find the outer card boundary and return a deskewed (warped) crop."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)

    result = _largest_quad(edges)
    if result is None:
        return img, False

    biggest, approx = result
    img_area = img.shape[0] * img.shape[1]
    if cv2.contourArea(biggest) < 0.2 * img_area:
        # Card boundary not confidently found; fall back to whole frame.
        return img, False

    if len(approx) != 4:
        # Use the bounding box of the largest contour as a fallback.
        x, y, w, h = cv2.boundingRect(biggest)
        return img[y:y + h, x:x + w], True

    rect = _order_points(approx)
    (tl, tr, br, bl) = rect
    width = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    height = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    if width < 10 or height < 10:
        return img, False

    dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype="float32")
    matrix = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(img, matrix, (width, height))
    return warped, True


def _detect_inner_frame(card: np.ndarray):
    """
    Find the inner artwork/border frame inside a deskewed card crop and return
    its border widths (left, right, top, bottom) in pixels, plus card w/h.
    """
    h, w = card.shape[:2]
    gray = cv2.cvtColor(card, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 40, 120)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    card_area = h * w
    best = None
    best_area = 0
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        area = cw * ch
        # Inner frame should be a sizeable but not full-card rectangle, and
        # roughly centered (not hugging one edge).
        if 0.25 * card_area < area < 0.9 * card_area and area > best_area:
            best = (x, y, cw, ch)
            best_area = area

    if best is None:
        # Fall back to a margin-based estimate so we always return something.
        m = int(min(h, w) * 0.08)
        return {"left": m, "right": m, "top": m, "bottom": m, "width": w, "height": h, "confident": False}

    x, y, cw, ch = best
    left = x
    right = w - (x + cw)
    top = y
    bottom = h - (y + ch)
    return {
        "left": max(left, 0),
        "right": max(right, 0),
        "top": max(top, 0),
        "bottom": max(bottom, 0),
        "width": w,
        "height": h,
        "confident": True,
    }


def _centering_score(frame: dict):
    """Compute centering percentages and a 1-10 sub-grade."""
    left, right = frame["left"], frame["right"]
    top, bottom = frame["top"], frame["bottom"]

    def split(a, b):
        total = a + b
        if total == 0:
            return 50.0, 50.0
        return 100.0 * a / total, 100.0 * b / total

    lr_a, lr_b = split(left, right)
    tb_a, tb_b = split(top, bottom)

    # Worst (largest) side on each axis governs the grade.
    worst = max(lr_a, lr_b, tb_a, tb_b)

    grade = 1
    for g, tol in CENTERING_TOLERANCES:
        if worst <= tol:
            grade = g
            break

    return {
        "left_right": f"{round(lr_a)}/{round(lr_b)}",
        "top_bottom": f"{round(tb_a)}/{round(tb_b)}",
        "worst_ratio": round(worst, 1),
        "grade": grade,
        "borders_px": {"left": left, "right": right, "top": top, "bottom": bottom},
    }


def _corner_score(card: np.ndarray):
    """Estimate corner quality from sharpness + whitening in the four corners."""
    h, w = card.shape[:2]
    cs = int(min(h, w) * 0.12)
    gray = cv2.cvtColor(card, cv2.COLOR_BGR2GRAY)
    corners = {
        "tl": gray[0:cs, 0:cs],
        "tr": gray[0:cs, w - cs:w],
        "bl": gray[h - cs:h, 0:cs],
        "br": gray[h - cs:h, w - cs:w],
    }
    penalties = []
    for patch in corners.values():
        if patch.size == 0:
            continue
        # Whitening: corners that are worn show bright, low-detail patches.
        bright_ratio = float(np.mean(patch > 200))
        # Detail: sharp corners have edges; rounded/soft corners do not.
        detail = float(cv2.Laplacian(patch, cv2.CV_64F).var())
        detail_pen = max(0.0, 1.0 - min(detail / 300.0, 1.0))
        penalties.append(min(1.0, bright_ratio * 1.5 + detail_pen * 0.5))

    avg_pen = float(np.mean(penalties)) if penalties else 0.5
    grade = int(round(10 - avg_pen * 6))
    return max(1, min(10, grade)), round(avg_pen, 2)


def _edge_score(card: np.ndarray):
    """Estimate edge quality from whitening along the perimeter."""
    h, w = card.shape[:2]
    t = max(3, int(min(h, w) * 0.02))
    gray = cv2.cvtColor(card, cv2.COLOR_BGR2GRAY)
    strips = [gray[0:t, :], gray[h - t:h, :], gray[:, 0:t], gray[:, w - t:w]]
    bright = [float(np.mean(s > 205)) for s in strips if s.size]
    avg_bright = float(np.mean(bright)) if bright else 0.3
    grade = int(round(10 - min(avg_bright * 3.0, 1.0) * 6))
    return max(1, min(10, grade)), round(avg_bright, 2)


def _surface_score(card: np.ndarray):
    """Estimate surface quality from focus and bright-spot (scratch) density."""
    gray = cv2.cvtColor(card, cv2.COLOR_BGR2GRAY)
    focus = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    # Blurry / very low detail images can't be Gem Mint — clamp the ceiling.
    focus_pen = max(0.0, 1.0 - min(focus / 500.0, 1.0))

    # Specular bright spots can indicate scratches/scuffs catching light.
    blur = cv2.GaussianBlur(gray, (0, 0), 3)
    diff = cv2.absdiff(gray, blur)
    scratch_ratio = float(np.mean(diff > 40))

    pen = min(1.0, focus_pen * 0.6 + scratch_ratio * 4.0)
    grade = int(round(10 - pen * 6))
    return max(1, min(10, grade)), round(pen, 2)


def _overall(centering: int, corners: int, edges: int, surface: int) -> float:
    """
    PSA's overall grade is driven by the weakest attribute. We weight centering
    heavily (it's the measured one) but never let the overall exceed the
    minimum sub-grade by more than a point.
    """
    sub = [centering, corners, edges, surface]
    weighted = 0.40 * centering + 0.20 * corners + 0.20 * edges + 0.20 * surface
    capped = min(weighted, min(sub) + 1)
    # Round to nearest half then to PSA-style integer for the headline.
    return round(capped, 1)


GRADE_LABELS = {
    10: "Gem Mint",
    9: "Mint",
    8: "Near Mint-Mint",
    7: "Near Mint",
    6: "Excellent-Mint",
    5: "Excellent",
    4: "Very Good-Excellent",
    3: "Very Good",
    2: "Good",
    1: "Poor",
}


def grade_card(path: str) -> dict:
    """Run the full grading pipeline on an image file and return a report."""
    img = _read_image(path)
    card, card_found = _detect_card(img)

    frame = _detect_inner_frame(card)
    centering = _centering_score(frame)
    corner_grade, corner_pen = _corner_score(card)
    edge_grade, edge_pen = _edge_score(card)
    surface_grade, surface_pen = _surface_score(card)

    overall = _overall(centering["grade"], corner_grade, edge_grade, surface_grade)
    headline = int(round(overall))
    headline = max(1, min(10, headline))

    return {
        "overall": overall,
        "headline_grade": headline,
        "label": GRADE_LABELS.get(headline, ""),
        "card_detected": card_found,
        "frame_confident": frame.get("confident", False),
        "subgrades": {
            "centering": {
                "grade": centering["grade"],
                "left_right": centering["left_right"],
                "top_bottom": centering["top_bottom"],
                "worst_ratio": centering["worst_ratio"],
                "detail": "Measured directly from border edge distances.",
            },
            "corners": {
                "grade": corner_grade,
                "penalty": corner_pen,
                "detail": "Estimated from corner sharpness and whitening.",
            },
            "edges": {
                "grade": edge_grade,
                "penalty": edge_pen,
                "detail": "Estimated from whitening along the perimeter.",
            },
            "surface": {
                "grade": surface_grade,
                "penalty": surface_pen,
                "detail": "Estimated from focus and scratch/print-defect density.",
            },
        },
    }
