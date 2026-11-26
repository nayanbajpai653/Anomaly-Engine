from __future__ import annotations

import json
import re
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import requests
import yaml
from openpyxl.styles import Font, PatternFill
from sklearn.ensemble import IsolationForest

CONFIG_PATH = Path(__file__).parent / "config.yaml"

def default_config() -> dict:
    return {
        "high_risk": {
            "column": None,   
            "values": [],     
        },
        "ollama": {
            "enabled": True,
            "host": "http://localhost:11434",
            "model": "llama3.1",  
            "timeout_seconds": 30,
        },
        "detection": {
            "zscore_threshold": 3.0,
            "iqr_multiplier": 1.5,
            "contamination": 0.05,
        },
    }


def load_config(path: Path = CONFIG_PATH) -> dict:
    if path.exists():
        with open(path, "r") as f:
            loaded = yaml.safe_load(f) or {}
        cfg = default_config()
        for section, values in loaded.items():
            if isinstance(values, dict) and section in cfg:
                cfg[section].update(values)
            else:
                cfg[section] = values
        return cfg
    return default_config()

def save_config(cfg: dict, path: Path = CONFIG_PATH) -> None:
    with open(path, "w") as f:
        yaml.safe_dump(cfg, f, sort_keys=False)

def list_sheets(file) -> list[str]:
    name = getattr(file, "name", str(file))
    if str(name).lower().endswith(".csv"):
        return []
    xls = pd.ExcelFile(file)
    return xls.sheet_names

def clean_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    """Robustly sanitize uploaded data:
    1. Strip whitespace from column headers.
    2. Drop entirely empty rows.
    3. Recover numeric columns masked by currencies ($/€/£), percentages, commas, and formula errors."""
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]
    df = df.dropna(how="all").reset_index(drop=True)
    
    error_pattern = r"(?i)^(#.*|n/a|na|none|null|nil|tbd|unknown|free|cancelled|-)$"
    
    for col in df.columns:
        if df[col].dtype == object or str(df[col].dtype).startswith("string"):
            non_null = df[col].dropna().astype(str).str.strip()
            if non_null.empty:
                continue
            
            # Test if removing currency symbols, %, and commas makes it numeric
            cleaned_sample = non_null.str.replace(r"[$€£,% ]", "", regex=True)
            cleaned_sample = cleaned_sample.str.replace(error_pattern, "", regex=True)
            converted = pd.to_numeric(cleaned_sample, errors="coerce")
            numeric_valid = converted.notnull().sum()
            
            # If >= 40% of non-null cells are valid numbers, coerce entire column to numeric
            if len(non_null) > 0 and (numeric_valid / len(non_null)) >= 0.4:
                cleaned_col = df[col].astype(str).str.strip().str.replace(r"[$€£,% ]", "", regex=True)
                cleaned_col = cleaned_col.str.replace(error_pattern, "", regex=True)
                df[col] = pd.to_numeric(cleaned_col, errors="coerce")
                
    return df

def load_data(file, sheet_name: str | None = None) -> pd.DataFrame:
    name = getattr(file, "name", str(file))
    if str(name).lower().endswith(".csv"):
        df = pd.read_csv(file)
    else:
        df = pd.read_excel(file, sheet_name=sheet_name or 0)
    return clean_dataframe(df)

def numeric_columns(df: pd.DataFrame) -> list[str]:
    return df.select_dtypes(include=[np.number]).columns.tolist()

def categorical_columns(df: pd.DataFrame) -> list[str]:
    return df.select_dtypes(exclude=[np.number]).columns.tolist()

def detect_statistical(
    df: pd.DataFrame, numeric_cols: list[str], z_thresh: float, iqr_mult: float, high_spikes_only: bool = False
) -> tuple[pd.DataFrame, dict[str, dict[str, float]]]:
    flags = pd.DataFrame(False, index=df.index, columns=numeric_cols)
    stats: dict[str, dict[str, float]] = {}
    for col in numeric_cols:
        series = pd.to_numeric(df[col], errors="coerce")
        valid = series.dropna()
        if len(valid) == 0:
            stats[col] = {"mean": 0.0, "std": 0.0, "lower": 0.0, "upper": 0.0}
            continue
        mean, std = float(valid.mean()), float(valid.std(ddof=0))
        z = (series - mean) / std if std > 0 else pd.Series(0.0, index=series.index)
        q1, q3 = float(valid.quantile(0.25)), float(valid.quantile(0.75))
        iqr = q3 - q1
        lower, upper = q1 - iqr_mult * iqr, q3 + iqr_mult * iqr

        if high_spikes_only:
            z_flag = z > z_thresh
            iqr_flag = series > upper
        else:
            z_flag = z.abs() > z_thresh
            iqr_flag = (series < lower) | (series > upper)

        flags[col] = (z_flag | iqr_flag).fillna(False)
        stats[col] = {"mean": mean, "std": std, "lower": lower, "upper": upper}
    return flags, stats


def auto_contamination(stat_flags: pd.DataFrame, floor: float = 0.01, ceiling: float = 0.08) -> float:
    if stat_flags.empty:
        return floor
    rate = float(stat_flags.any(axis=1).mean())
    return min(max(rate, floor), ceiling)


def detect_isolation_forest(
    df: pd.DataFrame, numeric_cols: list[str], contamination: float
) -> tuple[pd.Series, pd.Series]:
    X = pd.DataFrame(index=df.index)
    for col in numeric_cols:
        X[col] = pd.to_numeric(df[col], errors="coerce")
        col_med = X[col].median()
        if pd.isna(col_med):
            col_med = 0.0
        X[col] = X[col].fillna(col_med)
    model = IsolationForest(contamination=contamination, random_state=42)
    preds = model.fit_predict(X)
    scores = model.decision_function(X)
    return pd.Series(preds == -1, index=df.index), pd.Series(scores, index=df.index)


def generate_data_profile(df: pd.DataFrame) -> dict:
    """Generate comprehensive dataset health score, missing value audit,
    executive business KPIs, and parameter distribution profiling."""
    total_rows = int(len(df))
    total_cols = int(len(df.columns))
    total_cells = total_rows * total_cols

    num_cols = numeric_columns(df)
    cat_cols = categorical_columns(df)

    missing_cells = int(df.isnull().sum().sum())
    missing_pct = round((missing_cells / max(total_cells, 1)) * 100, 1) if total_cells > 0 else 0.0
    duplicate_rows = int(df.duplicated().sum())

    clean_ratio = (total_cells - missing_cells) / max(total_cells, 1)
    health_score = round(max(0.0, min(100.0, clean_ratio * 100.0 - (duplicate_rows / max(total_rows, 1) * 10.0))), 1)

    if health_score >= 95:
        grade, grade_badge = "Excellent", "success"
    elif health_score >= 85:
        grade, grade_badge = "Good", "accent"
    elif health_score >= 70:
        grade, grade_badge = "Fair", "warn"
    else:
        grade, grade_badge = "Critical / Needs Attention", "danger"

    # Business KPIs
    kpis = {}
    spend_col = next((c for c in num_cols if re.search(r"(?i)(total|amount|spend|revenue|sales)", c)), None)
    if spend_col:
        s_series = df[spend_col].dropna()
        if not s_series.empty:
            kpis["total_spend"] = round(float(s_series.sum()), 2)
            kpis["avg_spend"] = round(float(s_series.mean()), 2)
            kpis["spend_col_name"] = spend_col

    qty_col = next((c for c in num_cols if re.search(r"(?i)(qty|quantity|units|count|volume)", c)), None)
    if qty_col:
        q_series = df[qty_col].dropna()
        if not q_series.empty:
            kpis["total_units"] = round(float(q_series.sum()), 0)
            kpis["qty_col_name"] = qty_col

    cat_col = next((c for c in cat_cols if re.search(r"(?i)(category|department|dept|type|segment)", c)), None)
    if cat_col:
        vc = df[cat_col].dropna().value_counts()
        if not vc.empty:
            kpis["top_category"] = str(vc.index[0])
            kpis["top_category_count"] = int(vc.iloc[0])
            kpis["top_category_pct"] = round(float(vc.iloc[0] / max(total_rows, 1) * 100), 1)
            kpis["cat_col_name"] = cat_col

    # Column details
    col_profiles = []
    for col in df.columns:
        is_num = col in num_cols
        null_count = int(df[col].isnull().sum())
        null_p = round(float(null_count / max(total_rows, 1) * 100), 1)
        unique_c = int(df[col].nunique(dropna=True))

        prof = {
            "name": str(col),
            "dtype": "Numeric" if is_num else "Text / Category",
            "null_count": null_count,
            "null_pct": null_p,
            "unique_count": unique_c,
            "clean_pct": round(100.0 - null_p, 1),
        }
        if is_num:
            valid_s = pd.to_numeric(df[col], errors="coerce").dropna()
            prof["min"] = round(float(valid_s.min()), 2) if not valid_s.empty else None
            prof["median"] = round(float(valid_s.median()), 2) if not valid_s.empty else None
            prof["max"] = round(float(valid_s.max()), 2) if not valid_s.empty else None
            prof["mean"] = round(float(valid_s.mean()), 2) if not valid_s.empty else None
            prof["std"] = round(float(valid_s.std(ddof=0)), 2) if not valid_s.empty else None
            prof["zeros"] = int((valid_s == 0).sum())
            prof["negatives"] = int((valid_s < 0).sum())
        else:
            top_v = df[col].dropna().value_counts().head(3)
            prof["top_values"] = [{"val": str(k), "count": int(v)} for k, v in top_v.items()]
        col_profiles.append(prof)

    return {
        "total_rows": total_rows,
        "total_columns": total_cols,
        "numeric_columns_count": len(num_cols),
        "categorical_columns_count": len(cat_cols),
        "total_cells": total_cells,
        "missing_cells": missing_cells,
        "missing_pct": missing_pct,
        "duplicate_rows": duplicate_rows,
        "health_score": health_score,
        "health_grade": grade,
        "health_badge": grade_badge,
        "kpis": kpis,
        "columns": col_profiles,
    }


def combine_results(
    df: pd.DataFrame,
    numeric_cols: list[str],
    stat_flags: pd.DataFrame,
    iso_flags: pd.Series,
    iso_scores: pd.Series,
    config: dict,
    id_col: str | None = None,
) -> list[dict[str, Any]]:
    hr_col = config["high_risk"].get("column")
    hr_values = set(config["high_risk"].get("values") or [])

    rows = []
    for idx in df.index:
        flagged_cols = [c for c in numeric_cols if bool(stat_flags.loc[idx, c])]
        stat_hit = len(flagged_cols) > 0
        iso_hit = bool(iso_flags.loc[idx])
        if not stat_hit and not iso_hit:
            continue

        is_high_risk = bool(
            hr_col and hr_col in df.columns and str(df.loc[idx, hr_col]) in hr_values
        )

        if stat_hit and iso_hit:
            confidence = "High"
        else:
            confidence = "Medium"
        if is_high_risk and confidence == "Medium":
            confidence = "High (risk-boosted)"

        excel_row = int(idx) + 2
        id_val = df.loc[idx, id_col] if id_col and id_col in df.columns else None
        if id_val is not None and str(id_val).strip() and str(id_val).strip() != str(idx):
            display_label = f"Excel Row {excel_row} ({id_val})"
            row_label = str(id_val)
        else:
            display_label = f"Excel Row {excel_row}"
            row_label = f"Row {excel_row}"

        rows.append({
            "row_index": int(idx),
            "excel_row": excel_row,
            "row_label": row_label,
            "display_label": display_label,
            "id_value": str(id_val) if id_val is not None else None,
            "flagged_columns": flagged_cols,
            "stat_flag": stat_hit,
            "iso_flag": iso_hit,
            "iso_score": float(iso_scores.loc[idx]),
            "confidence": confidence,
            "high_risk_category": is_high_risk,
        })

    # Most anomalous (lowest isolation-forest score) first
    rows.sort(key=lambda r: r["iso_score"])
    return rows

def generate_business_nlg(
    df: pd.DataFrame,
    row_info: dict,
    stat_stats: dict,
    config: dict | None = None,
) -> dict[str, str]:
    idx = row_info["row_index"]
    row = df.loc[idx]
    flagged = row_info.get("flagged_columns", [])
    is_high_risk = row_info.get("high_risk_category", False)

    price_dev = None
    qty_dev = None
    ship_dev = None
    total_dev = None
    other_devs = []

    for col in flagged:
        try:
            val = float(row[col]) if pd.notnull(row[col]) and not pd.isna(row[col]) else 0.0
        except (ValueError, TypeError):
            val = 0.0
        stats = stat_stats.get(col, {})
        mean = float(stats.get("mean", 0.0))
        diff_pct = ((val - mean) / abs(mean) * 100) if mean else 0.0
        lower = col.lower()

        info = {"col": col, "val": val, "mean": mean, "diff_pct": diff_pct}
        if any(k in lower for k in ("price", "rate", "cost", "unit")):
            price_dev = info
        elif any(k in lower for k in ("qty", "quant", "units", "count", "volume")):
            qty_dev = info
        elif any(k in lower for k in ("ship", "freight", "postage", "delivery")):
            ship_dev = info
        elif any(k in lower for k in ("total", "amount", "spend", "revenue", "charge")):
            total_dev = info
        else:
            other_devs.append(info)

    category = None
    for c in df.columns:
        if c.lower() in ("category", "department", "dept", "item_type", "type"):
            category = str(row[c])
            break

    finding_parts = []
    diagnosis_parts = []
    action_parts = []

    if price_dev and price_dev["diff_pct"] >= 250:
        p_val = price_dev["val"]
        p_mean = price_dev["mean"]
        p_diff = price_dev["diff_pct"]
        cat_str = f" in '{category}'" if category else ""
        finding_parts.append(f"{price_dev['col']} is ${p_val:,.2f} (+{p_diff:,.0f}% above typical ${p_mean:,.2f} average){cat_str}.")

        if p_val > 1000 and (category and category.lower() in ("books", "beauty", "office supplies", "apparel", "groceries", "home & kitchen")):
            diagnosis_parts.append("Severe pricing anomaly suggesting a misplaced decimal entry (e.g. $38.50 entered as $3,850.00), master catalog SKU rate typo, or foreign currency conversion discrepancy.")
            action_parts.append("Halt automated billing, audit SKU pricing in master ERP catalog, and verify original purchase order before fulfillment.")
        else:
            diagnosis_parts.append("Extreme unit price outlier substantially exceeding standard benchmark limits for this product class.")
            action_parts.append("Audit pricing tiers in ERP and verify vendor cost schedule.")

    if qty_dev and qty_dev["diff_pct"] >= 300:
        q_val = qty_dev["val"]
        q_mean = qty_dev["mean"]
        q_diff = qty_dev["diff_pct"]
        finding_parts.append(f"{qty_dev['col']} reached {q_val:,.0f} units (+{q_diff:,.0f}% vs typical {q_mean:.1f} benchmark).")
        diagnosis_parts.append("Unusual high-volume purchasing spike indicative of a commercial B2B restock or reseller transaction rather than routine retail purchasing.")
        action_parts.append("Verify warehouse physical inventory reserve, validate volume discount agreement, and evaluate freight logistics.")

    if ship_dev and ship_dev["diff_pct"] >= 250:
        s_val = ship_dev["val"]
        s_mean = ship_dev["mean"]
        s_diff = ship_dev["diff_pct"]
        finding_parts.append(f"{ship_dev['col']} surged to ${s_val:,.2f} (+{s_diff:,.0f}% above standard ${s_mean:,.2f} baseline).")
        diagnosis_parts.append("Logistics surcharge spike characteristic of expedited air freight, international customs duties, or non-standard oversized carrier handling.")
        action_parts.append("Request itemized carrier bill of lading (BOL) and reconcile accessorial fees against negotiated carrier contract rates.")

    if total_dev and total_dev["diff_pct"] >= 400:
        t_val = total_dev["val"]
        t_mean = total_dev["mean"]
        t_diff = total_dev["diff_pct"]
        if not (price_dev and price_dev["diff_pct"] >= 250) and not (qty_dev and qty_dev["diff_pct"] >= 300):
            finding_parts.append(f"{total_dev['col']} totaled ${t_val:,.2f} (+{t_diff:,.0f}% above ${t_mean:,.2f} average).")
            diagnosis_parts.append("Extraordinary transaction spend volume representing elevated credit exposure, single-card velocity risk, or corporate enterprise procurement.")
            action_parts.append("Perform 3D Secure / payment authorization verification and obtain executive approval before releasing order.")

    if is_high_risk:
        diagnosis_parts.append("This transaction occurred within a monitored high-risk category, triggering enhanced compliance review.")
        action_parts.append("Route transaction to internal audit queue for compliance sign-off.")

    if not finding_parts:
        for item in other_devs or []:
            c = item["col"]
            v = item["val"]
            m = item["mean"]
            d = item["diff_pct"]
            direction = "above" if d > 0 else "below"
            finding_parts.append(f"{c} is {abs(d):.0f}% {direction} typical baseline ({v:,.2f} vs {m:,.2f} avg).")
        if not finding_parts:
            finding_parts.append("Multivariate anomaly flagged by Isolation Forest ML model.")
            diagnosis_parts.append("While individual metrics may hover near single bounds, their multi-column intersection creates a statistically rare operational signature.")
            action_parts.append("Perform cross-field reconciliation against similar historical accounts.")

    if not diagnosis_parts:
        diagnosis_parts.append("Statistical deviation significantly exceeds regular operational variance.")
    if not action_parts:
        action_parts.append("Verify data entry and confirm record details with the issuing department.")

    finding_text = " ".join(finding_parts)
    diagnosis_text = " ".join(diagnosis_parts)
    action_text = " ".join(action_parts)

    full_summary = f"{finding_text} {diagnosis_text} Action: {action_text}"

    return {
        "finding": finding_text,
        "diagnosis": diagnosis_text,
        "action": action_text,
        "summary": full_summary,
    }


def rule_based_note(
    df: pd.DataFrame, row_info: dict, stat_stats: dict, config: dict | None = None
) -> str:
    nlg = generate_business_nlg(df, row_info, stat_stats, config)
    return nlg["summary"]


def ollama_note(
    df: pd.DataFrame, row_info: dict, stat_stats: dict, config: dict
) -> str:
    """Ask a local Ollama model for explanation if explicitly configured.
    Falls back cleanly to our custom business NLG engine if Ollama isn't reachable."""
    fallback = rule_based_note(df, row_info, stat_stats, config)

    if not config.get("ollama", {}).get("enabled", False):
        return fallback

    idx = row_info["row_index"]
    row_data = {k: (v.item() if hasattr(v, "item") else v) for k, v in df.loc[idx].to_dict().items()}
    excel_row = row_info.get("excel_row", int(idx) + 2)
    prompt = (
        "You are a senior data analyst. In 2-3 short sentences, explain in plain business "
        f"language why this row (Excel Row {excel_row}) could be an anomaly and what action the business should take.\n\n"
        f"Row data: {json.dumps(row_data, default=str)}\n"
        f"Flagged columns: {row_info['flagged_columns']}\n"
    )
    try:
        resp = requests.post(
            f"{config['ollama']['host']}/api/generate",
            json={"model": config["ollama"]["model"], "prompt": prompt, "stream": False},
            timeout=15,
        )
        resp.raise_for_status()
        text = resp.json().get("response", "").strip()
        return text if text else fallback
    except Exception:
        return fallback


def generate_notes(
    df: pd.DataFrame,
    results: list[dict],
    stat_stats: dict,
    config: dict,
    use_ollama: bool = False,
) -> list[dict]:
    for row_info in results:
        nlg = generate_business_nlg(df, row_info, stat_stats, config)
        row_info["business_context"] = nlg["summary"]
        row_info["nlg_finding"] = nlg["finding"]
        row_info["nlg_diagnosis"] = nlg["diagnosis"]
        row_info["nlg_action"] = nlg["action"]
    return results

def export_highlighted_excel(
    df: pd.DataFrame, results: list[dict]
) -> BytesIO:
    """Return an in-memory .xlsx: original data + a 'Business Context' column,
    with flagged rows highlighted and colored by confidence.
    Rows not in results (e.g. deselected false positives) are not highlighted."""
    note_by_idx = {int(r["row_index"]): r.get("business_context", "") for r in results}
    conf_by_idx = {int(r["row_index"]): r.get("confidence", "") for r in results}

    out = df.copy()
    out["Anomaly Confidence"] = [conf_by_idx.get(int(i), "") for i in out.index]
    out["Business Context"] = [note_by_idx.get(int(i), "") for i in out.index]

    buffer = BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        out.to_excel(writer, index=False, sheet_name="Anomaly Report")
        ws = writer.sheets["Anomaly Report"]

        high_fill = PatternFill(start_color="FFF4CCCC", end_color="FFF4CCCC", fill_type="solid")
        med_fill = PatternFill(start_color="FFFFF2CC", end_color="FFFFF2CC", fill_type="solid")
        header_font = Font(bold=True)

        for cell in ws[1]:
            cell.font = header_font

        for pos, idx in enumerate(out.index, start=2):  # row 1 is header
            confidence = conf_by_idx.get(int(idx))
            if not confidence:
                continue
            fill = high_fill if confidence.startswith("High") else med_fill
            for cell in ws[pos]:
                cell.fill = fill

        for col_cells in ws.columns:
            length = max((len(str(c.value)) if c.value is not None else 0) for c in col_cells)
            ws.column_dimensions[col_cells[0].column_letter].width = min(max(length + 2, 10), 60)

    buffer.seek(0)
    return buffer

def export_clean_excel(df: pd.DataFrame, results: list[dict]) -> BytesIO:
    """Return an in-memory .xlsx where confirmed anomalies are removed,
    leaving only verified clean data. Deselected anomalies are preserved in the data."""
    anomaly_indices = {int(r["row_index"]) for r in results}
    clean_df = df.drop(index=[i for i in df.index if int(i) in anomaly_indices])

    buffer = BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        clean_df.to_excel(writer, index=False, sheet_name="Clean Data")
        ws = writer.sheets["Clean Data"]
        header_font = Font(bold=True)
        for cell in ws[1]:
            cell.font = header_font
        for col_cells in ws.columns:
            length = max((len(str(c.value)) if c.value is not None else 0) for c in col_cells)
            ws.column_dimensions[col_cells[0].column_letter].width = min(max(length + 2, 10), 60)

    buffer.seek(0)
    return buffer

def export_anomalies_only_excel(df: pd.DataFrame, results: list[dict]) -> BytesIO:
    """Return an in-memory .xlsx containing ONLY confirmed anomaly rows."""
    anomaly_indices = [int(r["row_index"]) for r in results if int(r["row_index"]) in df.index]
    note_by_idx = {int(r["row_index"]): r.get("business_context", "") for r in results}
    conf_by_idx = {int(r["row_index"]): r.get("confidence", "") for r in results}

    out = df.loc[anomaly_indices].copy()
    out.insert(0, "Excel Row", [int(i) + 2 for i in out.index])
    out["Anomaly Confidence"] = [conf_by_idx.get(int(i), "") for i in out.index]
    out["Business Context"] = [note_by_idx.get(int(i), "") for i in out.index]

    buffer = BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        out.to_excel(writer, index=False, sheet_name="Anomalies Only")
        ws = writer.sheets["Anomalies Only"]
        header_font = Font(bold=True)
        high_fill = PatternFill(start_color="FFF4CCCC", end_color="FFF4CCCC", fill_type="solid")
        med_fill = PatternFill(start_color="FFFFF2CC", end_color="FFFFF2CC", fill_type="solid")

        for cell in ws[1]:
            cell.font = header_font

        for pos, idx in enumerate(out.index, start=2):
            confidence = conf_by_idx.get(int(idx))
            if confidence:
                fill = high_fill if confidence.startswith("High") else med_fill
                for cell in ws[pos]:
                    cell.fill = fill

        for col_cells in ws.columns:
            length = max((len(str(c.value)) if c.value is not None else 0) for c in col_cells)
            ws.column_dimensions[col_cells[0].column_letter].width = min(max(length + 2, 10), 60)

    buffer.seek(0)
    return buffer