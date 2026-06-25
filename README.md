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

## Two ways to run it

This repo ships **two equivalent front ends** that share the same grading logic:

1. **Static site (no backend) — recommended for hosting.** `index.html` runs the
   whole grading pipeline in the browser using [OpenCV.js](https://docs.opencv.org/4.10.0/opencv.js).
   Nothing is uploaded to a server. This is what gets hosted on GitHub Pages.
2. **Flask app (local).** `app.py` serves the same UI and grades server-side with
   Python + OpenCV. Handy for local development.

The browser engine (`static/grader.js`) is a faithful port of the Python engine
(`grader.py`): deskew the card, detect the outer boundary and the inner artwork
frame, measure the four border widths ("edge distances"), and convert those into
centering ratios and sub-grades.

## Hosting on GitHub Pages

The site is fully static, so Pages can serve it directly. Pick **one** option:

### Option A — Deploy from a branch (simplest)

1. Push this repo to GitHub (already done if you're reading this there).
2. Go to **Settings → Pages**.
3. Under **Source**, choose **Deploy from a branch**.
4. Select your branch and the **`/ (root)`** folder, then **Save**.
5. After a minute your site is live at
   `https://<your-username>.github.io/PokemonGrader/`.

### Option B — GitHub Actions (auto-deploy on every push to `main`)

1. Go to **Settings → Pages → Source** and choose **GitHub Actions**.
2. The included workflow (`.github/workflows/deploy-pages.yml`) builds and
   deploys automatically on each push to `main`. (You can also run it manually
   from the **Actions** tab via "Run workflow", or add your branch to the
   `on.push.branches` list to deploy from it.)

> All asset paths are relative, so the site works correctly under the
> `/PokemonGrader/` sub-path that Pages uses.

## Running the Flask version locally

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Then open <http://localhost:5000>.

To preview the **static** site locally instead:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Tips for the best read

- Photograph the card **straight on**, filling most of the frame.
- Use even lighting with no glare.
- Make sure all four card edges are visible against a contrasting background —
  this lets the detector find the boundary and measure centering accurately.

## Project layout

```
index.html                     Static site entry point (hosted on Pages)
static/grader.js               In-browser grading engine (OpenCV.js)
static/script.js               Upload, preview and result rendering
static/style.css               Styling
.github/workflows/deploy-pages.yml   Auto-deploy workflow for Pages
.nojekyll                      Tell Pages to serve files as-is

app.py                         Flask server + upload/grade endpoint (local)
grader.py                      Python OpenCV grading pipeline (local)
templates/index.html           UI template for the Flask version
requirements.txt               Python dependencies (for the Flask version)
```
