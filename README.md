# PokemonGrader

A web app where you upload a photo of a Pokémon card front and get an
automated, PSA-style grade. The headline number is built from four sub-grades:

| Sub-grade  | How it's computed |
|------------|-------------------|
| **Centering** | Measured directly from the card's border **edge distances** (left/right and top/bottom), then scored against PSA's front-centering tolerances (55/45 → PSA 10, 60/40 → 9, etc.). |
| **Corners**   | Estimated from corner sharpness and whitening. |
| **Edges**     | Estimated from whitening along the card perimeter. |
| **Surface**   | Estimated from focus and scratch / print-defect density. |

The **overall** grade follows PSA's convention of being driven by the weakest
attribute (centering is weighted most heavily because it's the one measured
rigorously).

> ⚠️ This is a learning project that produces estimates only. Centering is
> measured from the image; corners, edges and surface are heuristic
> approximations. It is **not** affiliated with PSA and is not a substitute for
> professional grading.

## How it works

- **Backend:** Python + Flask (`app.py`) exposes `POST /api/grade`.
- **Vision:** OpenCV (`grader.py`) deskews the card, detects the outer boundary
  and the inner artwork frame, measures the four border widths, and converts
  those into centering ratios and sub-grades.
- **Frontend:** A drag-and-drop single page (`templates/`, `static/`) that
  previews the image and renders the grade report.

## Running locally

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Then open <http://localhost:5000>.

## Tips for the best read

- Photograph the card **straight on**, filling most of the frame.
- Use even lighting with no glare.
- Make sure all four card edges are visible against a contrasting background —
  this lets the detector find the boundary and measure centering accurately.

## Project layout

```
app.py                 Flask server + upload/grade endpoint
grader.py              OpenCV grading pipeline (centering, corners, edges, surface)
templates/index.html   Upload + results UI
static/style.css       Styling
static/script.js       Upload, preview and result rendering
requirements.txt       Python dependencies
```
