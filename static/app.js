const state = { token: null, reportToken: null, file: null, columns: [], numericColumns: [], categoricalColumns: [], mode: "auto", savedConfig: null, dataProfile: null };
const $ = (id) => document.getElementById(id);

function openVisualAnalyticsTab() {
    const token = state.reportToken || state.token;
    if (!token) {
        alert("Please upload a spreadsheet or load sample data first.");
        return;
    }
    window.open(`/visuals?token=${encodeURIComponent(token)}`, "_blank");
}

function openDataAnalysisTab() {
    const token = state.reportToken || state.token;
    if (!token) {
        alert("Please upload a spreadsheet or load sample data first.");
        return;
    }
    window.open(`/analysis?token=${encodeURIComponent(token)}`, "_blank");
}

async function loadConfig() {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    state.savedConfig = cfg;

    $("ollama-toggle").checked = cfg.ollama.enabled;
    $("ollama-host").value = cfg.ollama.host;
    $("ollama-model").value = cfg.ollama.model;
    
    $("z-slider").value = cfg.detection.zscore_threshold;
    $("z-val").textContent = cfg.detection.zscore_threshold.toFixed(1);
    $("iqr-slider").value = cfg.detection.iqr_multiplier;
    $("iqr-val").textContent = cfg.detection.iqr_multiplier.toFixed(1);
    $("contam-slider").value = cfg.detection.contamination;
    $("contam-val").textContent = Math.round(cfg.detection.contamination * 100) + "%";
}

document.querySelectorAll("#mode-toggle .segment").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll("#mode-toggle .segment").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.mode = btn.dataset.mode;
        const isManual = state.mode === "manual";
        $("manual-controls").classList.toggle("hidden", !isManual);
        $("mode-hint").textContent = isManual ? "Tune the thresholds yourself." : "Thresholds are derived from your data automatically — nothing to set here.";
    });
});

const PRESETS = {
    strict: { z: 3.5, iqr: 2.0, contam: 0.02 },
    balanced: { z: 3.0, iqr: 1.5, contam: 0.05 },
    sensitive: { z: 2.2, iqr: 1.2, contam: 0.10 },
    aggressive: { z: 1.8, iqr: 1.0, contam: 0.15 },
};

document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const p = PRESETS[btn.dataset.preset];
        if (!p) return;
        $("z-slider").value = p.z;
        $("z-val").textContent = p.z.toFixed(1);
        $("iqr-slider").value = p.iqr;
        $("iqr-val").textContent = p.iqr.toFixed(1);
        $("contam-slider").value = p.contam;
        $("contam-val").textContent = Math.round(p.contam * 100) + "%";
    });
});

const clearPresets = () => document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
$("z-slider").addEventListener("input", (e) => { clearPresets(); $("z-val").textContent = parseFloat(e.target.value).toFixed(1); });
$("iqr-slider").addEventListener("input", (e) => { clearPresets(); $("iqr-val").textContent = parseFloat(e.target.value).toFixed(1); });
$("contam-slider").addEventListener("input", (e) => { clearPresets(); $("contam-val").textContent = Math.round(parseFloat(e.target.value) * 100) + "%"; });

$("ollama-toggle").addEventListener("change", (e) => {
    const f = $("ollama-fields"); if(f) f.classList.toggle("hidden", !e.target.checked);
});

const dropzone = $("dropzone");
const fileInput = $("file-input");

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { if (fileInput.files.length) handleFile(fileInput.files[0]); });
["dragover", "dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        if (evt === "dragover") dropzone.classList.add("dragover");
        if (evt === "dragleave" || evt === "drop") dropzone.classList.remove("dragover");
    });
});
dropzone.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });

function handleFile(file) { state.file = file; uploadFile(); }
$("sheet-picker").addEventListener("change", () => uploadFile($("sheet-picker").value));

const loadSampleBtn = $("load-sample-btn");
if (loadSampleBtn) {
    loadSampleBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        $("loading").classList.remove("hidden");
        $("loading-text").textContent = "Loading sample expense data (400 rows)…";
        try {
            const res = await fetch("/api/load-sample", { method: "POST" });
            const data = await res.json();
            if (data.error) {
                alert(data.error);
                return;
            }
            state.file = null;
            state.token = data.token;
            state.columns = data.columns || [];
            state.numericColumns = data.numeric_columns || [];
            state.categoricalColumns = data.categorical_columns || [];
            state.dataProfile = data.data_profile || null;
            if (data.data_profile) renderDataAnalysis(data.data_profile);
            renderDataSection(data);
        } catch (err) {
            alert("Failed to load sample data: " + err);
        } finally {
            $("loading").classList.add("hidden");
            $("loading-text").textContent = "Detecting anomalies…";
        }
    });
}

async function uploadFile(sheet) {
    const formData = new FormData();
    formData.append("file", state.file);
    if (sheet) formData.append("sheet", sheet);

    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();

    if (data.error) { alert(data.error); return; }
    if (data.needs_sheet) {
        $("sheet-picker-wrap").classList.remove("hidden");
        $("sheet-picker").innerHTML = data.sheets.map((s) => `<option value="${escapeHtml(String(s))}">${escapeHtml(String(s))}</option>`).join("");
        return;
    }

    $("sheet-picker-wrap").classList.add("hidden");
    state.token = data.token;
    state.reportToken = null;
    state.columns = data.columns || [];
    state.numericColumns = data.numeric_columns || [];
    state.categoricalColumns = data.categorical_columns || [];
    state.dataProfile = data.data_profile || null;
    renderDataSection(data);
}

function renderDataSection(data) {
    $("data-section").classList.remove("hidden");
    $("results-section").classList.add("hidden");
    $("empty-result").classList.add("hidden");

    $("row-col-count").textContent = `${data.rows || 0} rows × ${state.columns.length} columns`;

    const previewAnalysisBtn = $("btn-toggle-analysis-preview");
    if (previewAnalysisBtn) {
        previewAnalysisBtn.onclick = openDataAnalysisTab;
    }

    const table = $("preview-table");
    try {
        const headRow = "<tr>" + state.columns.map((c) => `<th>${escapeHtml(String(c))}</th>`).join("") + "</tr>";
        const bodyRows = (data.preview || []).map((row) =>
            "<tr>" + state.columns.map((c) => `<td>${escapeHtml(String(row[c] ?? ""))}</td>`).join("") + "</tr>"
        ).join("");
        table.innerHTML = headRow + bodyRows;
    } catch (e) {
        table.innerHTML = "<tr><td>Preview unavailable. Proceed with detection.</td></tr>";
    }

    const chipGrid = $("numeric-checks");
    chipGrid.innerHTML = state.numericColumns.map((c) => `<div class="chip active" data-col="${escapeHtml(String(c))}">${escapeHtml(String(c))}</div>`).join("");
    chipGrid.querySelectorAll(".chip").forEach((chip) => { chip.addEventListener("click", () => chip.classList.toggle("active")); });

    const idSelect = $("id-column");
    idSelect.innerHTML = '<option value="">(row number)</option>' + state.columns.map((c) => `<option value="${escapeHtml(String(c))}">${escapeHtml(String(c))}</option>`).join("");
}

$("run-btn").addEventListener("click", runDetection);

function selectedNumericColumns() {
    return Array.from(document.querySelectorAll("#numeric-checks .chip.active")).map((el) => el.dataset.col);
}

async function runDetection() {
    const numericCols = selectedNumericColumns();
    if (numericCols.length === 0) { alert("Pick at least one numeric column."); return; }

    $("loading").classList.remove("hidden");
    $("loading-text").textContent = "Running instant ML & statistical analysis…";
    $("results-section").classList.add("hidden");
    $("empty-result").classList.add("hidden");
    $("run-btn").disabled = true;

    const body = {
        token: state.token,
        numeric_columns: numericCols,
        id_column: $("id-column").value || null,
        mode: state.mode,
        zscore_threshold: parseFloat($("z-slider").value),
        iqr_multiplier: parseFloat($("iqr-slider").value),
        contamination: parseFloat($("contam-slider").value),
        high_spikes_only: $("high-spikes-toggle") ? $("high-spikes-toggle").checked : true,
        high_risk_column: $("hr-column").value || null,
        high_risk_values: [],
        use_ollama: false, // Initial detection uses instant rule-based notes; AI insights are available on-demand
        ollama_host: $("ollama-host") ? $("ollama-host").value : "http://localhost:11434",
        ollama_model: $("ollama-model") ? $("ollama-model").value : "llama3.1",
    };

    let data;
    try {
        const res = await fetch("/api/detect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        data = await res.json();
    } catch (err) {
        alert("Detection failed: " + err);
        $("loading").classList.add("hidden");
        $("run-btn").disabled = false;
        return;
    }

    $("loading").classList.add("hidden");
    $("run-btn").disabled = false;
    if (data.error) { alert(data.error); return; }

    $("auto-caption").textContent = state.mode !== "manual" 
        ? `Auto-tuned for this file: flags values beyond 3σ from average, and ~${Math.round(data.contamination_used * 100)}% of rows as ML outliers.` 
        : "";

    state.reportToken = data.report_token || null;
    if (data.data_profile) {
        state.dataProfile = data.data_profile;
    }

    if (data.results.length === 0) {
        const box = $("empty-result");
        box.classList.remove("hidden");
        box.textContent = "No anomalies found with the current thresholds. Switch to Manual mode to loosen them.";
        return;
    }
    renderResults(data);
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function buildStatPills(r, columnStats) {
    const pills = [];
    const rowData = r.row_data || {};
    
    for (const [col, val] of Object.entries(rowData)) {
        if (val === null || val === undefined || val === "") continue;
        const lowerCol = col.toLowerCase();
        
        if (columnStats && columnStats[col]) {
            const numVal = parseFloat(val);
            const mean = columnStats[col].mean;
            let spikeBadge = "";
            if (!isNaN(numVal) && mean && mean > 0) {
                const diffPct = Math.round(((numVal - mean) / mean) * 100);
                if (diffPct > 0) {
                    spikeBadge = `<span class="stat-pill-spike">+${diffPct.toLocaleString()}% vs avg ($${mean.toLocaleString()})</span>`;
                } else if (diffPct < 0) {
                    spikeBadge = `<span class="stat-pill-spike" style="background:#edf2f7; border-color:#cbd5e0; color:#4a5568;">${diffPct}% vs avg</span>`;
                }
            }
            let formattedVal = isNaN(numVal) ? val : numVal.toLocaleString(undefined, { maximumFractionDigits: 2 });
            if (lowerCol.includes("amount") || lowerCol.includes("price") || lowerCol.includes("cost") || lowerCol.includes("total")) {
                formattedVal = "$" + formattedVal;
            }
            pills.push(`
                <span class="stat-pill">
                    💵 <strong>${escapeHtml(col)}:</strong> ${escapeHtml(String(formattedVal))} ${spikeBadge}
                </span>
            `);
        } else if (
            lowerCol.includes("department") || lowerCol.includes("dept") ||
            lowerCol.includes("category") ||
            lowerCol.includes("vendor") || lowerCol.includes("merchant") ||
            lowerCol.includes("employee") || lowerCol.includes("user") ||
            lowerCol.includes("status") || lowerCol.includes("type")
        ) {
            let icon = "🏷️";
            if (lowerCol.includes("dept")) icon = "🏢";
            else if (lowerCol.includes("vendor") || lowerCol.includes("merchant")) icon = "💳";
            else if (lowerCol.includes("employee") || lowerCol.includes("user")) icon = "👤";
            
            pills.push(`
                <span class="stat-pill">
                    ${icon} <strong>${escapeHtml(col)}:</strong> ${escapeHtml(String(val))}
                </span>
            `);
        }
    }
    
    if (pills.length === 0) return "";
    return `<div class="stat-pill-grid">${pills.slice(0, 5).join("")}</div>`;
}

function toggleDataAnalysis() {
    openDataAnalysisTab();
}


function renderCategoryBreakdown(data, excludedRows) {
    const visualPanel = $("visual-panel");
    const barsContainer = $("breakdown-bars");
    if (!visualPanel || !barsContainer) return;

    let catCol = null;
    const sampleRow = (data.results[0] && data.results[0].row_data) || {};
    const colKeys = Object.keys(sampleRow);
    for (const preferred of ["Category", "Department", "Type", "Status", "Merchant", "Vendor"]) {
        const found = colKeys.find((c) => c.toLowerCase() === preferred.toLowerCase());
        if (found) { catCol = found; break; }
    }
    if (!catCol && state.categoricalColumns && state.categoricalColumns.length > 0) {
        catCol = state.categoricalColumns[0];
    }

    const activeResults = data.results.filter((r) => !excludedRows.has(r.row_index));
    if (activeResults.length === 0) {
        barsContainer.innerHTML = `<div style="font-size:0.85rem; color:var(--text-muted); padding: 8px 0;">All anomalies currently deselected.</div>`;
        return;
    }

    const counts = {};
    activeResults.forEach((r) => {
        let val = catCol && r.row_data ? r.row_data[catCol] : null;
        if (!val && r.flagged_columns && r.flagged_columns.length) {
            val = r.flagged_columns.join(", ");
        }
        val = val || "Other";
        counts[val] = (counts[val] || 0) + 1;
    });

    const sortedCats = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const maxCount = Math.max(...sortedCats.map((c) => c[1]), 1);
    const totalActive = activeResults.length;

    const badge = $("risk-rating-badge");
    if (badge) {
        const topRatio = sortedCats[0][1] / totalActive;
        if (topRatio >= 0.4 && totalActive >= 3) {
            badge.textContent = "CONCENTRATED SPIKES";
            badge.style.background = "#fff5f5";
            badge.style.color = "#c53030";
            badge.style.borderColor = "#feb2b2";
        } else {
            badge.textContent = "BALANCED SPREAD";
            badge.style.background = "#edf2f7";
            badge.style.color = "#4a5568";
            badge.style.borderColor = "#cbd5e0";
        }
    }

    barsContainer.innerHTML = sortedCats.map(([catName, count]) => {
        const pctOfMax = Math.round((count / maxCount) * 100);
        const pctOfTotal = Math.round((count / totalActive) * 100);
        return `
            <div class="breakdown-item">
                <span class="breakdown-name" title="${escapeHtml(catName)}">${escapeHtml(catName)}</span>
                <div class="breakdown-track">
                    <div class="breakdown-fill" style="width: ${pctOfMax}%;"></div>
                </div>
                <span class="breakdown-count">${count} (${pctOfTotal}%)</span>
            </div>
        `;
    }).join("");
}

function renderResults(data) {
    const totalAnomalies = data.results.length;
    let excludedRows = new Set();
    let selectedCards = new Set();
    let currentFilter = "all";

    function checkEmptyPlaceholder() {
        const placeholder = $("empty-selection-placeholder");
        if (!placeholder) return;
        const visibleCards = Array.from(document.querySelectorAll(".anomaly-card")).filter((c) => c.style.display !== "none");
        placeholder.style.display = visibleCards.length === 0 ? "block" : "none";
    }

    function renderNumbersBar() {
        const barContainer = $("numbers-chips");
        if (!barContainer) return;
        
        barContainer.innerHTML = data.results.map((r) => {
            const isHigh = r.confidence.startsWith("High");
            const isDismissed = excludedRows.has(r.row_index);
            const isSelected = selectedCards.has(r.row_index);
            return `
                <button type="button" class="num-chip ${isHigh ? "high" : "medium"} ${isSelected ? "active" : ""} ${isDismissed ? "dismissed" : ""}" 
                        data-index="${r.row_index}" 
                        id="num-chip-${r.row_index}" 
                        title="Tap to show/hide details for Excel Row ${r.excel_row}">
                    <span class="num-chip-val">Row ${r.excel_row}</span>
                </button>
            `;
        }).join("");

        barContainer.querySelectorAll(".num-chip").forEach((chip) => {
            chip.addEventListener("click", () => {
                const idx = parseInt(chip.dataset.index, 10);
                const card = $("card-" + idx);
                if (!card) return;
                
                if (selectedCards.has(idx)) {
                    selectedCards.delete(idx);
                    chip.classList.remove("active");
                    card.style.display = "none";
                } else {
                    selectedCards.add(idx);
                    chip.classList.add("active");
                    card.classList.remove("collapsed");
                    card.style.display = "";
                    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
                }
                if (window.inspectChartRow) window.inspectChartRow(idx);
                checkEmptyPlaceholder();
            });
        });
    }

    function applyFilter() {
        document.querySelectorAll(".anomaly-card").forEach((card) => {
            const idx = parseInt(card.dataset.index, 10);
            if (!selectedCards.has(idx)) {
                card.style.display = "none";
                return;
            }
            const isDismissed = card.classList.contains("dismissed");
            const conf = card.dataset.confidence;
            if (currentFilter === "all") {
                card.style.display = "";
            } else if (currentFilter === "high") {
                card.style.display = (conf === "high" && !isDismissed) ? "" : "none";
            } else if (currentFilter === "medium") {
                card.style.display = (conf === "medium" && !isDismissed) ? "" : "none";
            } else if (currentFilter === "excluded") {
                card.style.display = isDismissed ? "" : "none";
            }
        });

        document.querySelectorAll(".num-chip").forEach((chip) => {
            const idx = parseInt(chip.dataset.index, 10);
            const isDismissed = excludedRows.has(idx);
            const r = data.results.find((item) => item.row_index === idx);
            const isHigh = r && r.confidence.startsWith("High");
            let show = false;
            if (currentFilter === "all") show = true;
            else if (currentFilter === "high") show = (isHigh && !isDismissed);
            else if (currentFilter === "medium") show = (!isHigh && !isDismissed);
            else if (currentFilter === "excluded") show = isDismissed;
            chip.style.display = show ? "" : "none";
        });

        checkEmptyPlaceholder();
    }

    function updateSummaryAndMetrics() {
        const activeCount = totalAnomalies - excludedRows.size;
        const highCount = data.results.filter((r) => !excludedRows.has(r.row_index) && r.confidence.startsWith("High")).length;
        const mediumCount = activeCount - highCount;

        $("metric-row").innerHTML = [
            ["📊", Number(data.total_rows).toLocaleString(), "Rows analyzed", "accent"],
            ["🚨", activeCount, "Selected anomalies", ""],
            ["🔥", highCount, "High confidence", "high"],
            ["⚠️", mediumCount, "Medium confidence", "medium"],
        ].map(([icon, value, label, variant]) => `
            <div class="metric-card ${variant}">
                <div class="metric-card-icon">${icon}</div>
                <div class="metric-value">${value}</div>
                <div class="metric-label">${label}</div>
            </div>
        `).join("");

        const excludedText = excludedRows.size > 0 
            ? ` <span style="color: #e53e3e; font-weight:600;">(${excludedRows.size} deselected false positive${excludedRows.size > 1 ? "s" : ""})</span>` 
            : "";
        $("results-summary").innerHTML = `<strong>Detection Summary:</strong> Found <b>${totalAnomalies}</b> potential anomalies across ${Number(data.total_rows).toLocaleString()} rows. <b>${activeCount}</b> will be included in the report.${excludedText} Review below and <strong>uncheck any false positives</strong> to exclude them from your export.`;
        if ($("count-all")) $("count-all").textContent = activeCount;
        if ($("count-high")) $("count-high").textContent = highCount;
        if ($("count-medium")) $("count-medium").textContent = mediumCount;
        if ($("count-excluded")) $("count-excluded").textContent = excludedRows.size;

        renderCategoryBreakdown(data, excludedRows);
        applyFilter();
    }

    // Build anomaly cards (initially hidden until clicked from numbers bar)
    const emptyPlaceholderHtml = `
        <div class="anomaly-empty-selection" id="empty-selection-placeholder">
            <div class="empty-selection-icon">📍</div>
            <div class="empty-selection-text">Tap any row number above to view its details, or click <strong id="link-show-all">Show All</strong>.</div>
        </div>
    `;

    const cardsHtml = data.results.map((r) => {
        const isHigh = r.confidence.startsWith("High");
        const colsLine = r.flagged_columns.length ? r.flagged_columns.join(", ") : "pattern across columns (ML only)";
        
        let labelDisplay = `Excel Row ${r.excel_row}`;
        if (r.id_value && String(r.id_value).trim() && String(r.id_value).trim() !== String(r.row_index)) {
            labelDisplay += ` <span style="font-size:0.85em; font-weight:normal; color:var(--text-muted); margin-left: 6px;">(${escapeHtml(String(r.id_value))})</span>`;
        }

        const statPillsHtml = buildStatPills(r, data.column_stats);

        return `
        <div class="anomaly-card ${isHigh ? "high" : ""}" id="card-${r.row_index}" data-index="${r.row_index}" data-confidence="${isHigh ? "high" : "medium"}" style="display: none; transition: all 0.2s;">
            <div class="anomaly-card-top">
                <div class="card-header-main" data-index="${r.row_index}">
                    <label style="display:flex; align-items:center; gap:10px; cursor:pointer;" onclick="event.stopPropagation()">
                        <input type="checkbox" class="keep-anomaly" data-index="${r.row_index}" checked style="accent-color: var(--accent); width:18px; height:18px; cursor:pointer;">
                        <span class="anomaly-row-label">${labelDisplay}</span>
                    </label>
                    <span class="collapsed-preview-tag">${escapeHtml(String(colsLine))}</span>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span id="badges-${r.row_index}">
                        <span class="badge ${isHigh ? "badge-high" : "badge-medium"}">${isHigh ? "HIGH CONFIDENCE" : "MEDIUM CONFIDENCE"}</span>
                        ${r.high_risk_category ? '<span class="badge badge-risk">HIGH-RISK CATEGORY</span>' : ""}
                    </span>
                    <button type="button" class="btn-ai-explain" data-index="${r.row_index}" id="ai-btn-${r.row_index}" title="Run instant deep business audit on this anomaly">
                        ✨ Deep Audit
                    </button>
                    <button type="button" class="btn-card-close" data-index="${r.row_index}" title="Hide from view">
                        ✕ Hide
                    </button>
                    <button type="button" class="btn-card-toggle" data-index="${r.row_index}" title="Toggle details">
                        <svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </button>
                </div>
            </div>
            <div class="anomaly-card-body" id="card-body-${r.row_index}">
                ${statPillsHtml}
                <div class="anomaly-cols">Flagged: ${escapeHtml(String(colsLine))}</div>
                <div class="nlg-box" id="nlg-box-${r.row_index}">
                    <div class="nlg-finding"><strong>📌 Finding:</strong> ${escapeHtml(r.nlg_finding || r.business_context)}</div>
                    ${r.nlg_diagnosis ? `<div class="nlg-diagnosis"><strong>🔍 Risk Diagnosis:</strong> ${escapeHtml(r.nlg_diagnosis)}</div>` : ""}
                    ${r.nlg_action ? `<div class="nlg-action"><strong>⚡ Recommended Action:</strong> ${escapeHtml(r.nlg_action)}</div>` : ""}
                </div>
            </div>
        </div>`;
    }).join("");

    $("anomaly-list").innerHTML = emptyPlaceholderHtml + cardsHtml;

    renderNumbersBar();
    updateSummaryAndMetrics();
    checkEmptyPlaceholder();

    // Close button on card hides it from view
    document.querySelectorAll(".btn-card-close").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.index, 10);
            selectedCards.delete(idx);
            const chip = $("num-chip-" + idx);
            if (chip) chip.classList.remove("active");
            const card = $("card-" + idx);
            if (card) card.style.display = "none";
            checkEmptyPlaceholder();
        });
    });

    // Card toggle (chevron & header) toggles collapsed/expanded
    document.querySelectorAll(".card-header-main, .btn-card-toggle").forEach((el) => {
        el.addEventListener("click", (e) => {
            if (e.target.closest(".keep-anomaly") || e.target.closest(".btn-ai-explain") || e.target.closest(".btn-card-close")) return;
            const idx = parseInt(el.dataset.index, 10);
            const card = $("card-" + idx);
            if (card) card.classList.toggle("collapsed");
        });
    });

    // Show All / Hide All controls
    const showAllBtn = $("btn-show-all");
    if (showAllBtn) {
        showAllBtn.onclick = () => {
            data.results.forEach((r) => {
                selectedCards.add(r.row_index);
                const card = $("card-" + r.row_index);
                if (card) {
                    card.classList.remove("collapsed");
                    card.style.display = "";
                }
                const chip = $("num-chip-" + r.row_index);
                if (chip) chip.classList.add("active");
            });
            applyFilter();
            checkEmptyPlaceholder();
        };
    }

    const hideAllBtn = $("btn-hide-all");
    if (hideAllBtn) {
        hideAllBtn.onclick = () => {
            selectedCards.clear();
            data.results.forEach((r) => {
                const card = $("card-" + r.row_index);
                if (card) card.style.display = "none";
                const chip = $("num-chip-" + r.row_index);
                if (chip) chip.classList.remove("active");
            });
            checkEmptyPlaceholder();
        };
    }

    const linkShowAll = $("link-show-all");
    if (linkShowAll && showAllBtn) {
        linkShowAll.onclick = () => showAllBtn.click();
    }

    document.querySelectorAll(".keep-anomaly").forEach((cb) => {
        cb.addEventListener("change", (e) => {
            const idx = parseInt(e.target.dataset.index, 10);
            const card = $("card-" + idx);
            const chip = $("num-chip-" + idx);
            const badgesSpan = $("badges-" + idx);
            const r = data.results.find((item) => item.row_index === idx);
            const isHigh = r && r.confidence.startsWith("High");

            if (e.target.checked) {
                excludedRows.delete(idx);
                card.classList.remove("dismissed");
                if (chip) chip.classList.remove("dismissed");
                badgesSpan.innerHTML = `
                    <span class="badge ${isHigh ? "badge-high" : "badge-medium"}">${isHigh ? "HIGH CONFIDENCE" : "MEDIUM CONFIDENCE"}</span>
                    ${r && r.high_risk_category ? '<span class="badge badge-risk">HIGH-RISK CATEGORY</span>' : ""}
                `;
            } else {
                excludedRows.add(idx);
                card.classList.add("dismissed");
                if (chip) chip.classList.add("dismissed");
                badgesSpan.innerHTML = `<span class="badge badge-excluded">EXCLUDED / NORMAL</span>`;
            }
            updateSummaryAndMetrics();
            updateDownloadHrefs();
        });
    });

    document.querySelectorAll(".filter-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            document.querySelectorAll(".filter-chip").forEach((c) => c.classList.remove("active"));
            chip.classList.add("active");
            currentFilter = chip.dataset.filter;
            applyFilter();
        });
    });

    const bulkSelectBtn = $("bulk-select-all");
    if (bulkSelectBtn) {
        bulkSelectBtn.onclick = () => {
            document.querySelectorAll(".keep-anomaly").forEach((cb) => {
                if (!cb.checked) {
                    cb.checked = true;
                    cb.dispatchEvent(new Event("change"));
                }
            });
        };
    }
    const bulkDeselectBtn = $("bulk-deselect-all");
    if (bulkDeselectBtn) {
        bulkDeselectBtn.onclick = () => {
            document.querySelectorAll(".keep-anomaly").forEach((cb) => {
                if (cb.checked) {
                    cb.checked = false;
                    cb.dispatchEvent(new Event("change"));
                }
            });
        };
    }

    function getExcludeParam() {
        const unchecked = Array.from(document.querySelectorAll(".keep-anomaly:not(:checked)"))
            .map((cb) => parseInt(cb.dataset.index, 10));
        return unchecked.length ? `?exclude=${unchecked.join(",")}` : "";
    }

    function updateDownloadHrefs() {
        const query = getExcludeParam();
        $("download-btn").href = `/api/download/${data.report_token}${query}`;
        $("download-clean-btn").href = `/api/download-clean/${data.report_token}${query}`;
        if ($("download-anomalies-btn")) {
            $("download-anomalies-btn").href = `/api/download-anomalies/${data.report_token}${query}`;
        }
    }

    function attachDownloadHandler(btnId, baseUrl) {
        const btn = $(btnId);
        if (!btn) return;
        btn.onclick = (e) => {
            e.preventDefault();
            const query = getExcludeParam();
            window.location.href = `${baseUrl}/${data.report_token}${query}`;
        };
    }

    attachDownloadHandler("download-btn", "/api/download");
    attachDownloadHandler("download-clean-btn", "/api/download-clean");
    attachDownloadHandler("download-anomalies-btn", "/api/download-anomalies");

    function renderNlgContent(idx, resItem) {
        const box = $("nlg-box-" + idx);
        if (!box) return;
        box.innerHTML = `
            <div class="nlg-finding"><strong>📌 Finding:</strong> ${escapeHtml(resItem.finding || resItem.business_context)}</div>
            ${resItem.diagnosis ? `<div class="nlg-diagnosis"><strong>🔍 Risk Diagnosis:</strong> ${escapeHtml(resItem.diagnosis)}</div>` : ""}
            ${resItem.action ? `<div class="nlg-action"><strong>⚡ Recommended Action:</strong> ${escapeHtml(resItem.action)}</div>` : ""}
        `;
    }

    document.querySelectorAll(".btn-ai-explain").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.index, 10);
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = `<span class="spinner-micro"></span> Auditing…`;

            try {
                const res = await fetch("/api/explain-row", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: data.report_token, row_index: idx })
                });
                const resData = await res.json();
                if (resData.business_context) {
                    renderNlgContent(idx, resData);
                    btn.innerHTML = `✓ Audited`;
                    btn.classList.add("explained");
                    const target = data.results.find((it) => it.row_index === idx);
                    if (target) {
                        target.business_context = resData.business_context;
                        target.nlg_finding = resData.finding;
                        target.nlg_diagnosis = resData.diagnosis;
                        target.nlg_action = resData.action;
                    }
                } else {
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                }
            } catch (err) {
                btn.innerHTML = originalText;
                btn.disabled = false;
                alert("Audit failed: " + err);
            }
        });
    });

    const bulkAiTopBtn = $("bulk-ai-top");
    if (bulkAiTopBtn) {
        bulkAiTopBtn.onclick = async () => {
            bulkAiTopBtn.disabled = true;
            const originalLabel = bulkAiTopBtn.innerHTML;
            bulkAiTopBtn.innerHTML = `⏳ Auditing Top 3…`;
            try {
                const res = await fetch("/api/explain-top", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token: data.report_token })
                });
                const resData = await res.json();
                if (resData.updated && resData.updated.length > 0) {
                    resData.updated.forEach((item) => {
                        renderNlgContent(item.row_index, item);
                        const btn = $("ai-btn-" + item.row_index);
                        if (btn) {
                            btn.innerHTML = `✓ Audited`;
                            btn.classList.add("explained");
                            btn.disabled = true;
                        }
                        const target = data.results.find((it) => it.row_index === item.row_index);
                        if (target) {
                            target.business_context = item.business_context;
                            target.nlg_finding = item.finding;
                            target.nlg_diagnosis = item.diagnosis;
                            target.nlg_action = item.action;
                        }
                        selectedCards.add(item.row_index);
                        const card = $("card-" + item.row_index);
                        if (card) {
                            card.classList.remove("collapsed");
                            card.style.display = "";
                        }
                        const chip = $("num-chip-" + item.row_index);
                        if (chip) chip.classList.add("active");
                    });
                    checkEmptyPlaceholder();
                    bulkAiTopBtn.innerHTML = `✓ Top 3 Audited`;
                } else {
                    bulkAiTopBtn.innerHTML = originalLabel;
                    bulkAiTopBtn.disabled = false;
                }
            } catch (err) {
                bulkAiTopBtn.innerHTML = originalLabel;
                bulkAiTopBtn.disabled = false;
                alert("Audit failed: " + err);
            }
        };
    }

    const btnToggleAnalysis = $("btn-toggle-analysis-results");
    if (btnToggleAnalysis) {
        btnToggleAnalysis.onclick = openDataAnalysisTab;
    }

    const btnToggleVisuals = $("btn-toggle-visuals");
    if (btnToggleVisuals) {
        btnToggleVisuals.onclick = openVisualAnalyticsTab;
    }

    initVisualAnalytics(data);
    updateDownloadHrefs();
    $("results-section").classList.remove("hidden");
}

function initVisualAnalytics(data) {
    const toggleBtn = $("btn-toggle-visuals");
    const linkOpen = $("link-open-visuals");
    const ctaOpen = $("btn-open-visuals-cta");

    const points = data.chart_points || [];
    const numCols = data.numeric_columns || [];
    const hasVisuals = numCols.length >= 1 && points.length > 0;

    if (!hasVisuals) {
        if (toggleBtn) toggleBtn.style.display = "none";
        const guideVisuals = document.querySelector(".tool-guide-card.guide-visuals");
        if (guideVisuals) guideVisuals.style.display = "none";
        return;
    } else {
        if (toggleBtn) toggleBtn.style.display = "";
        const guideVisuals = document.querySelector(".tool-guide-card.guide-visuals");
        if (guideVisuals) guideVisuals.style.display = "";
    }

    if (toggleBtn) toggleBtn.onclick = openVisualAnalyticsTab;
    if (linkOpen) linkOpen.onclick = openVisualAnalyticsTab;
    if (ctaOpen) ctaOpen.onclick = openVisualAnalyticsTab;
}


function initTheme() {
    document.documentElement.setAttribute("data-theme", "nordic");
    localStorage.setItem("anomaly_theme", "nordic");
}

const toggleRow = document.querySelector(".toggle-row");
if (toggleRow) {
    toggleRow.addEventListener("click", (e) => {
        if (e.target.closest(".switch")) return;
        const cb = $("high-spikes-toggle");
        if (cb) {
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event("change"));
        }
    });
}

const btnCloseAnalysis = $("btn-close-analysis");
if (btnCloseAnalysis) {
    btnCloseAnalysis.onclick = () => toggleDataAnalysis(false);
}

const ctaOpenAnalysis = $("btn-open-analysis-cta");
if (ctaOpenAnalysis) {
    ctaOpenAnalysis.onclick = openDataAnalysisTab;
}

const linkOpenAnalysis = $("link-open-analysis");
if (linkOpenAnalysis) {
    linkOpenAnalysis.onclick = openDataAnalysisTab;
}

initTheme();
loadConfig();