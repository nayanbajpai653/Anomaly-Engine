/**
 * Visual Analytics Studio - Standalone Explorer
 * Fullscreen parameter scatter plot, anomaly cluster discovery, and interactive row inspector.
 */

(function () {
    const $ = (id) => document.getElementById(id);
    let scatterChart = null;
    let sessionData = null;
    let currentFilter = "all";

    // Safe Back Button: focuses parent opener and closes tab, or navigates back to /
    function goBackToReport() {
        if (window.opener && !window.opener.closed) {
            window.opener.focus();
            window.close();
        } else {
            window.location.href = "/";
        }
    }

    const backBtn = $("btn-back-to-report");
    if (backBtn) backBtn.onclick = goBackToReport;
    const errBackBtn = $("btn-error-back");
    if (errBackBtn) errBackBtn.onclick = goBackToReport;

    function showError(title, msg) {
        $("studio-error-title").textContent = title;
        $("studio-error-msg").textContent = msg;
        $("studio-error-state").classList.remove("hidden");
        $("studio-content-grid").classList.add("hidden");
        const controls = document.querySelector(".studio-controls-bar");
        if (controls) controls.classList.add("hidden");
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    function formatVal(colName, val) {
        if (val === null || val === undefined || val === "") return "—";
        const num = parseFloat(val);
        const lower = colName.toLowerCase();
        if (!isNaN(num) && typeof val !== "boolean") {
            const formatted = num.toLocaleString(undefined, { maximumFractionDigits: 2 });
            if (lower.includes("amount") || lower.includes("price") || lower.includes("cost") || lower.includes("total") || lower.includes("spend")) {
                return "$" + formatted;
            }
            return formatted;
        }
        return String(val);
    }

    function inspectPoint(pt) {
        const emptyState = $("inspector-empty");
        const contentState = $("inspector-content");
        const badge = $("inspector-status-badge");
        const title = $("inspector-row-title");
        const sub = $("inspector-row-sub");
        const diagBox = $("inspector-diagnosis-box");
        const diagText = $("inspector-diagnosis-text");
        const grid = $("inspector-stats-grid");

        emptyState.classList.add("hidden");
        contentState.classList.remove("hidden");

        title.textContent = `Excel Row ${pt.excel_row}`;
        
        badge.className = "inspector-badge";
        if (pt.is_anomaly) {
            const isHigh = pt.confidence && pt.confidence.startsWith("High");
            badge.classList.add(isHigh ? "badge-high" : "badge-medium");
            badge.textContent = isHigh ? "🚨 High Anomaly" : "⚠️ Medium Anomaly";
            sub.textContent = `Flagged in ${pt.confidence}`;
        } else {
            badge.classList.add("badge-normal");
            badge.textContent = "🔵 Normal Record";
            sub.textContent = "Within standard statistical thresholds";
        }

        // Diagnosis
        const anomalyInfo = sessionData.results.find(r => r.row_index === pt.row_index);
        if (anomalyInfo && (anomalyInfo.business_context || anomalyInfo.nlg_diagnosis || anomalyInfo.flagged_columns)) {
            diagBox.classList.remove("hidden");
            let diagHtml = "";
            if (anomalyInfo.flagged_columns && anomalyInfo.flagged_columns.length) {
                diagHtml += `<div class="diag-field"><strong>Flagged Columns:</strong> <span class="diag-tags">${anomalyInfo.flagged_columns.map(c => `<span class="col-pill">${escapeHtml(c)}</span>`).join(" ")}</span></div>`;
            }
            if (anomalyInfo.business_context) {
                diagHtml += `<div class="diag-field"><strong>Executive Summary:</strong> ${escapeHtml(anomalyInfo.business_context)}</div>`;
            }
            if (anomalyInfo.nlg_diagnosis) {
                diagHtml += `<div class="diag-field"><strong>Root Cause Diagnosis:</strong> ${escapeHtml(anomalyInfo.nlg_diagnosis)}</div>`;
            }
            if (anomalyInfo.nlg_action) {
                diagHtml += `<div class="diag-field"><strong>Recommended Action:</strong> ${escapeHtml(anomalyInfo.nlg_action)}</div>`;
            }
            diagText.innerHTML = diagHtml;
        } else {
            diagBox.classList.add("hidden");
        }

        // Render Values Grid
        const vals = pt.values || {};
        grid.innerHTML = Object.entries(vals).map(([col, val]) => `
            <div class="stat-card">
                <span class="stat-card-label" title="${escapeHtml(col)}">${escapeHtml(col)}</span>
                <span class="stat-card-val">${escapeHtml(formatVal(col, val))}</span>
            </div>
        `).join("");
    }

    function buildChart() {
        const xCol = $("chart-x-col").value;
        const yCol = $("chart-y-col").value;
        if (!xCol || !yCol) return;

        const points = sessionData.chart_points || [];
        const highPoints = [];
        const medPoints = [];
        const normPoints = [];

        points.forEach((pt) => {
            const xv = parseFloat(pt.values[xCol]);
            const yv = parseFloat(pt.values[yCol]);
            if (isNaN(xv) || isNaN(yv)) return;

            const item = { x: xv, y: yv, raw: pt };
            if (pt.is_anomaly) {
                if (pt.confidence && pt.confidence.startsWith("High")) {
                    highPoints.push(item);
                } else {
                    medPoints.push(item);
                }
            } else {
                normPoints.push(item);
            }
        });

        if (scatterChart) {
            scatterChart.destroy();
            scatterChart = null;
        }

        const canvas = $("parameter-scatter-canvas");
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        scatterChart = new Chart(ctx, {
            type: "scatter",
            data: {
                datasets: [
                    {
                        label: "High Anomaly",
                        data: highPoints,
                        backgroundColor: "rgba(229, 62, 62, 0.88)",
                        borderColor: "#991b1b",
                        borderWidth: 1.5,
                        pointRadius: 7,
                        pointHoverRadius: 10,
                        order: 1,
                        hidden: currentFilter !== "all" && currentFilter !== "high",
                    },
                    {
                        label: "Medium Anomaly",
                        data: medPoints,
                        backgroundColor: "rgba(234, 179, 8, 0.88)",
                        borderColor: "#854d0e",
                        borderWidth: 1.5,
                        pointRadius: 6,
                        pointHoverRadius: 9,
                        order: 2,
                        hidden: currentFilter !== "all" && currentFilter !== "med",
                    },
                    {
                        label: "Normal Record",
                        data: normPoints,
                        backgroundColor: "rgba(59, 130, 246, 0.35)",
                        borderColor: "rgba(29, 78, 216, 0.65)",
                        borderWidth: 1,
                        pointRadius: 4.5,
                        pointHoverRadius: 7,
                        order: 3,
                        hidden: currentFilter !== "all" && currentFilter !== "normal",
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 350 },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "rgba(15, 23, 42, 0.95)",
                        padding: 12,
                        titleFont: { size: 13, weight: "bold" },
                        bodyFont: { size: 12 },
                        cornerRadius: 8,
                        boxPadding: 4,
                        callbacks: {
                            title: (items) => {
                                if (!items.length) return "";
                                const pt = items[0].raw.raw;
                                const status = pt.is_anomaly ? `Anomaly (${pt.confidence.split(" ")[0]})` : "Normal Record";
                                return `📍 Excel Row ${pt.excel_row} • ${status}`;
                            },
                            label: (item) => {
                                return [
                                    `${xCol}: ${item.parsed.x.toLocaleString()}`,
                                    `${yCol}: ${item.parsed.y.toLocaleString()}`,
                                ];
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        title: { display: true, text: xCol, font: { weight: "700", size: 13 }, color: "#334155" },
                        grid: { color: "rgba(0,0,0,0.06)" },
                    },
                    y: {
                        title: { display: true, text: yCol, font: { weight: "700", size: 13 }, color: "#334155" },
                        grid: { color: "rgba(0,0,0,0.06)" },
                    },
                },
                onClick: (evt, elements) => {
                    if (!elements || elements.length === 0) return;
                    const first = elements[0];
                    const ds = scatterChart.data.datasets[first.datasetIndex];
                    const ptObj = ds.data[first.index];
                    if (ptObj && ptObj.raw) {
                        inspectPoint(ptObj.raw);
                    }
                },
            },
        });
    }

    function initFilters() {
        document.querySelectorAll("#chart-filter-buttons .legend-btn").forEach((btn) => {
            btn.onclick = () => {
                const target = btn.dataset.chartFilter;
                currentFilter = (currentFilter === target && target !== "all") ? "all" : target;

                document.querySelectorAll("#chart-filter-buttons .legend-btn").forEach((b) => {
                    b.classList.toggle("active", b.dataset.chartFilter === currentFilter);
                });

                if (scatterChart) {
                    scatterChart.setDatasetVisibility(0, currentFilter === "all" || currentFilter === "high");
                    scatterChart.setDatasetVisibility(1, currentFilter === "all" || currentFilter === "med");
                    scatterChart.setDatasetVisibility(2, currentFilter === "all" || currentFilter === "normal");
                    scatterChart.update();
                }
            };
        });
    }

    async function init() {
        const params = new URLSearchParams(window.location.search);
        const token = params.get("token");

        if (!token) {
            showError("No Dataset Session Provided", "Please upload a dataset on the main anomaly report page first, then open Visual Analytics.");
            return;
        }

        try {
            const res = await fetch(`/api/session-data/${encodeURIComponent(token)}`);
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                showError("Session Expired or Invalid", errData.error || "Please return to the Anomaly Report to re-run detection.");
                return;
            }

            sessionData = await res.json();
        } catch (err) {
            showError("Connection Failed", "Unable to load session data: " + err.message);
            return;
        }

        const numCols = sessionData.numeric_columns || [];
        if (numCols.length === 0) {
            showError("No Numeric Columns Found", "This dataset does not contain numeric parameters suitable for scatter plot clustering.");
            return;
        }

        // Header pill
        const datasetTag = $("dataset-name-pill");
        if (datasetTag) {
            datasetTag.textContent = `${sessionData.filename || "Dataset"} • ${(sessionData.total_rows || 0).toLocaleString()} rows • ${sessionData.results.length} anomalies`;
        }

        // Populate X and Y dropdowns
        const xSelect = $("chart-x-col");
        const ySelect = $("chart-y-col");
        xSelect.innerHTML = "";
        ySelect.innerHTML = "";

        numCols.forEach((col, idx) => {
            const optX = document.createElement("option");
            optX.value = col;
            optX.textContent = col;
            xSelect.appendChild(optX);

            const optY = document.createElement("option");
            optY.value = col;
            optY.textContent = col;
            ySelect.appendChild(optY);
        });

        xSelect.value = numCols[0];
        ySelect.value = numCols.length > 1 ? numCols[1] : numCols[0];

        xSelect.onchange = buildChart;
        ySelect.onchange = buildChart;

        initFilters();
        buildChart();

        // If there are anomalies, pre-inspect the highest confidence one so the inspector is alive
        const highAnom = sessionData.chart_points.find(p => p.is_anomaly && p.confidence.startsWith("High")) ||
                         sessionData.chart_points.find(p => p.is_anomaly) ||
                         sessionData.chart_points[0];
        if (highAnom) {
            inspectPoint(highAnom);
        }
    }

    window.addEventListener("DOMContentLoaded", init);
})();
