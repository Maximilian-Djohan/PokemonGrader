"""Flask web app for grading Pokemon cards from an uploaded image."""

import os
import uuid

from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename

from grader import grade_card

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "bmp"}
MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

os.makedirs(UPLOAD_DIR, exist_ok=True)


def _allowed(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/grade", methods=["POST"])
def api_grade():
    if "image" not in request.files:
        return jsonify({"error": "No image uploaded."}), 400

    file = request.files["image"]
    if file.filename == "":
        return jsonify({"error": "No file selected."}), 400
    if not _allowed(file.filename):
        return jsonify({"error": "Unsupported file type. Use JPG, PNG, WEBP or BMP."}), 400

    ext = file.filename.rsplit(".", 1)[1].lower()
    name = secure_filename(f"{uuid.uuid4().hex}.{ext}")
    path = os.path.join(UPLOAD_DIR, name)
    file.save(path)

    try:
        report = grade_card(path)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:  # noqa: BLE001 - never leak internals to the client
        return jsonify({"error": "Failed to analyze image."}), 500
    finally:
        try:
            os.remove(path)
        except OSError:
            pass

    return jsonify(report)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
