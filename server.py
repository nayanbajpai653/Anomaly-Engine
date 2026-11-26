from __future__ import annotations

import threading
import uuid
import webbrowser

import numpy as np
import pandas as pd
from flask import Flask, jsonify, request, send_file, render_template

import anomaly_engine as engine

app = Flask(__name__, static_folder="static", static_url_path="")
SESSIONS: dict[str, dict] = {}


@app.after_request
def add_cache_headers(response):
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


def jsonable(value):
    if pd.isna(value):
        return None
    if isinstance(value, (np.integer, int)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return None if np.isnan(value) else float(value)
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return value


@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/visuals")
def visuals():
    return app.send_static_file("visuals.html")


@app.route("/analysis")
def analysis():
    return app.send_static_file("analysis.html")


@app.route("/api/session-data/<token>", methods=["GET"])
def session_data(token):
    session = SESSIONS.get(token)
    if not session:
        return jsonify({"error": "Session expired or invalid token — please return to the main anomaly report."}), 404

    df = session.get("df")
    data_profile = session.get("data_profile")
    if data_profile is None and df is not None:
        data_profile = engine.generate_data_profile(df)
        session["data_profile"] = data_profile

    chart_points = session.get("chart_points", [])
    clean_results = session.get("clean_results")
    if clean_results is None and session.get("results"):
        clean_results = [{
            "row_index": int(r["row_index"]),
            "excel_row": int(r.get("excel_row", int(r["row_index"]) + 2)),
            "row_label": jsonable(r.get("row_label")),
            "display_label": jsonable(r.get("display_label", f"Excel Row {int(r.get('excel_row', int(r['row_index']) + 2))}")),
            "confidence": r.get("confidence", "Normal"),
            "flagged_columns": r.get("flagged_columns", []),
            "business_context": r.get("business_context", ""),
            "nlg_finding": r.get("nlg_finding", ""),
            "nlg_diagnosis": r.get("nlg_diagnosis", ""),
            "nlg_action": r.get("nlg_action", ""),
            "row_data": {c: jsonable(df.loc[r["row_index"], c]) for c in df.columns} if df is not None else {}
        } for r in session.get("results", [])]

    numeric_cols = session.get("numeric_cols") or (engine.numeric_columns(df) if df is not None else [])
    all_cols = df.columns.tolist() if df is not None else []

    return jsonify({
        "token": token,
        "filename": session.get("filename", "Active Dataset"),
        "total_rows": len(df) if df is not None else 0,
        "columns": all_cols,
        "numeric_columns": numeric_cols,
        "data_profile": data_profile,
        "chart_points": chart_points,
        "results": clean_results or [],
        "has_detection": bool(session.get("results"))
    })


@app.route("/api/config", methods=["GET"])
def get_config():
    return jsonify(engine.load_config())


@app.route("/api/config", methods=["POST"])
def set_config():
    cfg = request.get_json(force=True)
    engine.save_config(cfg)
    return jsonify({"status": "ok"})


@app.route("/api/upload", methods=["POST"])
def upload():
    file = request.files.get("file")
    if file is None:
        return jsonify({"error": "No file received"}), 400

    sheet = request.form.get("sheet") or None
    sheets = engine.list_sheets(file)
    file.seek(0)

    if sheets and len(sheets) > 1 and not sheet:
        return jsonify({"needs_sheet": True, "sheets": sheets})

    df = engine.load_data(file, sheet)
    token = str(uuid.uuid4())
    data_profile = engine.generate_data_profile(df)
    SESSIONS[token] = {"df": df, "data_profile": data_profile, "numeric_cols": engine.numeric_columns(df), "filename": file.filename or "Uploaded File"}

    preview = df.head(10).astype(object).where(pd.notnull(df.head(10)), "").astype(str).to_dict(orient="records")

    return jsonify({
        "token": token,
        "rows": len(df),
        "columns": df.columns.tolist(),
        "numeric_columns": engine.numeric_columns(df),
        "categorical_columns": engine.categorical_columns(df),
        "preview": preview,
        "data_profile": data_profile,
    })


@app.route("/api/load-sample", methods=["POST"])
def load_sample():
    from pathlib import Path
    sample_path = Path(__file__).parent / "sample_data.xlsx"
    if not sample_path.exists():
        return jsonify({"error": "sample_data.xlsx not found"}), 404
    df = engine.load_data(str(sample_path))
    token = str(uuid.uuid4())
    data_profile = engine.generate_data_profile(df)
    SESSIONS[token] = {"df": df, "data_profile": data_profile, "numeric_cols": engine.numeric_columns(df), "filename": "sample_data.xlsx"}

    preview = df.head(10).astype(object).where(pd.notnull(df.head(10)), "").astype(str).to_dict(orient="records")

    return jsonify({
        "token": token,
        "rows": len(df),
        "columns": df.columns.tolist(),
        "numeric_columns": engine.numeric_columns(df),
        "categorical_columns": engine.categorical_columns(df),
        "preview": preview,
        "data_profile": data_profile,
    })


@app.route("/api/category-values", methods=["POST"])
def category_values():
    body = request.get_json(force=True)
    session = SESSIONS.get(body.get("token", ""))
    if not session:
        return jsonify({"error": "Session expired — please re-upload the file."}), 400
    df = session["df"]
    col = body.get("column")
    if not col or col not in df.columns:
        return jsonify({"values": []})
    values = sorted(df[col].dropna().astype(str).unique().tolist())
    return jsonify({"values": values})


@app.route("/api/detect", methods=["POST"])
def detect():
    body = request.get_json(force=True)
    session = SESSIONS.get(body.get("token", ""))
    if not session:
        return jsonify({"error": "Session expired — please re-upload the file."}), 400
    df = session["df"]

    numeric_cols = body.get("numeric_columns") or engine.numeric_columns(df)
    id_col = body.get("id_column") or None
    mode = body.get("mode", "auto")

    config = engine.load_config()
    config["high_risk"]["column"] = body.get("high_risk_column") or None
    config["high_risk"]["values"] = body.get("high_risk_values") or []
    config["ollama"]["enabled"] = bool(body.get("use_ollama", True))
    if body.get("ollama_host"):
        config["ollama"]["host"] = body["ollama_host"]
    if body.get("ollama_model"):
        config["ollama"]["model"] = body["ollama_model"]

    if mode == "manual":
        z_thresh = float(body.get("zscore_threshold", 3.0))
        iqr_mult = float(body.get("iqr_multiplier", 1.5))
    else:
        z_thresh, iqr_mult = 3.0, 2.5

    high_spikes_only = bool(body.get("high_spikes_only", True))
    stat_flags, stat_stats = engine.detect_statistical(
        df, numeric_cols, z_thresh, iqr_mult, high_spikes_only=high_spikes_only
    )

    if mode == "manual":
        contamination = float(body.get("contamination", 0.05))
    else:
        contamination = engine.auto_contamination(stat_flags)

    iso_flags, iso_scores = engine.detect_isolation_forest(df, numeric_cols, contamination)
    results = engine.combine_results(df, numeric_cols, stat_flags, iso_flags, iso_scores, config, id_col)
    # Generate instant rule-based notes (< 0.001s) so the user gets sub-second detection response!
    results = engine.generate_notes(df, results, stat_stats, config, use_ollama=False)

    data_profile = session.get("data_profile") or engine.generate_data_profile(df)
    report_token = str(uuid.uuid4())
    upload_tok = body.get("token")

    clean_results = [{
        "row_index": int(r["row_index"]),
        "excel_row": int(r.get("excel_row", int(r["row_index"]) + 2)),
        "row_label": jsonable(r["row_label"]),
        "display_label": jsonable(r.get("display_label", f"Excel Row {int(r.get('excel_row', int(r['row_index']) + 2))}")),
        "id_value": jsonable(r.get("id_value")),
        "flagged_columns": r["flagged_columns"],
        "confidence": r["confidence"],
        "high_risk_category": r["high_risk_category"],
        "business_context": r["business_context"],
        "nlg_finding": r.get("nlg_finding", ""),
        "nlg_diagnosis": r.get("nlg_diagnosis", ""),
        "nlg_action": r.get("nlg_action", ""),
        "row_data": {c: jsonable(df.loc[r["row_index"], c]) for c in df.columns},
    } for r in results]

    column_stats = {
        c: {"mean": round(float(stat_stats[c]["mean"]), 2), "std": round(float(stat_stats[c]["std"]), 2)}
        for c in numeric_cols if c in stat_stats
    }

    anomaly_map = {int(r["row_index"]): r for r in results}
    chart_points = []
    df_sample = df if len(df) <= 4000 else pd.concat([
        df.loc[[i for i in anomaly_map.keys() if i in df.index]],
        df.drop(index=[i for i in anomaly_map.keys() if i in df.index]).sample(min(3000, max(0, len(df) - len(anomaly_map))), random_state=42)
    ]).sort_index()

    for idx, row_dict in zip(df_sample.index, df_sample.to_dict(orient="records")):
        idx_int = int(idx)
        is_anom = idx_int in anomaly_map
        anom_info = anomaly_map.get(idx_int)
        conf = anom_info["confidence"] if is_anom else "Normal"
        clean_vals = {k: jsonable(v) for k, v in row_dict.items()}
        chart_points.append({
            "row_index": idx_int,
            "excel_row": idx_int + 2,
            "is_anomaly": is_anom,
            "confidence": conf,
            "values": clean_vals
        })

    session_payload = {
        "df": df,
        "results": results,
        "clean_results": clean_results,
        "stat_stats": stat_stats,
        "data_profile": data_profile,
        "chart_points": chart_points,
        "numeric_cols": list(numeric_cols),
        "column_stats": column_stats,
        "report_token": report_token,
        "upload_token": upload_tok,
    }
    SESSIONS[report_token] = session_payload
    if upload_tok and upload_tok in SESSIONS:
        SESSIONS[upload_tok].update(session_payload)

    return jsonify({
        "contamination_used": round(contamination, 4),
        "zscore_threshold": z_thresh,
        "iqr_multiplier": iqr_mult,
        "total_rows": len(df),
        "numeric_columns": list(numeric_cols),
        "all_columns": list(df.columns),
        "results": clean_results,
        "chart_points": chart_points,
        "column_stats": column_stats,
        "data_profile": data_profile,
        "report_token": report_token,
    })


@app.route("/api/explain-row", methods=["POST"])
def explain_row():
    body = request.get_json(force=True)
    token = body.get("token")
    row_index = body.get("row_index")
    session = SESSIONS.get(token)
    if not session or "results" not in session:
        return jsonify({"error": "Report session expired — please run detection again."}), 400

    df = session["df"]
    results = session["results"]
    row_info = next((r for r in results if int(r["row_index"]) == int(row_index)), None)
    if not row_info:
        return jsonify({"error": "Row not found in current results."}), 404

    config = engine.load_config()
    stat_stats = session.get("stat_stats", {})
    nlg = engine.generate_business_nlg(df, row_info, stat_stats, config)
    row_info["business_context"] = nlg["summary"]
    row_info["nlg_finding"] = nlg["finding"]
    row_info["nlg_diagnosis"] = nlg["diagnosis"]
    row_info["nlg_action"] = nlg["action"]
    row_info["is_ai_explained"] = True
    return jsonify({
        "status": "ok",
        "row_index": int(row_index),
        "business_context": nlg["summary"],
        "finding": nlg["finding"],
        "diagnosis": nlg["diagnosis"],
        "action": nlg["action"],
        "is_ai_explained": True
    })


@app.route("/api/explain-top", methods=["POST"])
def explain_top():
    """Explain top 3 critical anomalies with Custom Business NLG instantly."""
    body = request.get_json(force=True)
    token = body.get("token")
    session = SESSIONS.get(token)
    if not session or "results" not in session:
        return jsonify({"error": "Report session expired."}), 400

    df = session["df"]
    results = session["results"]
    top_rows = [r for r in results if r["confidence"].startswith("High")][:3]
    if not top_rows:
        top_rows = results[:3]

    config = engine.load_config()
    stat_stats = session.get("stat_stats", {})
    updated = []
    for r in top_rows:
        nlg = engine.generate_business_nlg(df, r, stat_stats, config)
        r["business_context"] = nlg["summary"]
        r["nlg_finding"] = nlg["finding"]
        r["nlg_diagnosis"] = nlg["diagnosis"]
        r["nlg_action"] = nlg["action"]
        r["is_ai_explained"] = True
        updated.append({
            "row_index": int(r["row_index"]),
            "business_context": nlg["summary"],
            "finding": nlg["finding"],
            "diagnosis": nlg["diagnosis"],
            "action": nlg["action"]
        })

    return jsonify({"status": "ok", "updated": updated})


def _parse_excluded_ids() -> set[int]:
    excluded = set()
    for raw in request.args.getlist("exclude"):
        for part in str(raw).split(","):
            part = part.strip()
            if part.isdigit():
                excluded.add(int(part))
    return excluded


@app.route("/api/download/<token>")
def download(token):
    session = SESSIONS.get(token)
    if not session or "results" not in session:
        return "Report expired — please run detection again.", 404
        
    excluded_ids = _parse_excluded_ids()
    filtered_results = [r for r in session["results"] if int(r.get("row_index")) not in excluded_ids]

    buffer = engine.export_highlighted_excel(session["df"], filtered_results)
    return send_file(
        buffer,
        as_attachment=True,
        download_name="anomaly_report_highlighted.xlsx",
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.route("/api/download-clean/<token>")
def download_clean(token):
    session = SESSIONS.get(token)
    if not session or "results" not in session:
        return "Report expired — please run detection again.", 404

    excluded_ids = _parse_excluded_ids()
    filtered_results = [r for r in session["results"] if int(r.get("row_index")) not in excluded_ids]

    buffer = engine.export_clean_excel(session["df"], filtered_results)
    return send_file(
        buffer,
        as_attachment=True,
        download_name="anomaly_report_clean.xlsx",
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.route("/api/download-anomalies/<token>")
def download_anomalies(token):
    session = SESSIONS.get(token)
    if not session or "results" not in session:
        return "Report expired — please run detection again.", 404

    excluded_ids = _parse_excluded_ids()
    filtered_results = [r for r in session["results"] if int(r.get("row_index")) not in excluded_ids]

    buffer = engine.export_anomalies_only_excel(session["df"], filtered_results)
    return send_file(
        buffer,
        as_attachment=True,
        download_name="anomalies_only.xlsx",
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


def _open_browser(port: int):
    webbrowser.open_new(f"http://127.0.0.1:{port}")


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    # Auto-open browser only when launched locally (no cloud env vars)
    if "PORT" not in os.environ and "RENDER" not in os.environ:
        threading.Timer(1.0, _open_browser, args=(port,)).start()
    app.run(host="0.0.0.0", port=port, debug=False)
