/**
 * Data Quality & Business Analysis Studio - Standalone Explorer
 * Deep profiling of dataset health, missing cells, statistical summaries, and executive business KPIs.
 */

(function () {
    const $ = (id) => document.getElementById(id);
    let sessionData = null;
    let activeFilter = "all";
    let searchQuery = "";

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
        $("analysis-main-content").classList.add("hidden");
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    function renderHealthScore(profile) {
        const scoreVal = $("analysis-health-score");
        const badge = $("analysis-health-badge");
        const detailsList = $("analysis-health-details");

        if (!scoreVal || !badge || !detailsList) return;

        scoreVal.textContent = (profile.health_score ?? 100).toFixed(1) + "%";

        badge.className = "health-badge";
        const badgeClass = profile.health_badge === "success" ? "badge-success" :
                           profile.health_badge === "accent" ? "badge-accent" :
                           profile.health_badge === "warn" ? "badge-warn" : "badge-danger";
        badge.classList.add(badgeClass);
        badge.textContent = profile.health_grade || "Good";

        const cleanCells = (profile.total_cells || 0) - (profile.missing_cells || 0);
        const cleanPct = profile.total_cells > 0 ? ((cleanCells / profile.total_cells) * 100).toFixed(1) : "100.0";
        const missingPct = profile.total_cells > 0 ? (((profile.missing_cells || 0) / profile.total_cells) * 100).toFixed(1) : "0.0";

        detailsList.innerHTML = `
            <div class="health-detail-item">
                <span class="health-detail-label">Dataset Shape:</span>
                <span class="health-detail-val">${(profile.total_rows || 0).toLocaleString()} rows × ${profile.total_columns || 0} columns</span>
            </div>
            <div class="health-detail-item">
                <span class="health-detail-label">Clean Data Cells:</span>
                <span class="health-detail-val" style="color: #16a34a; font-weight:700;">${cleanCells.toLocaleString()} (${cleanPct}%)</span>
            </div>
            <div class="health-detail-item">
                <span class="health-detail-label">Missing / Corrupted:</span>
                <span class="health-detail-val" style="${profile.missing_cells > 0 ? "color: #dc2626; font-weight:700;" : "color: #16a34a;"}">
                    ${(profile.missing_cells || 0).toLocaleString()} (${missingPct}%)
                </span>
            </div>
            <div class="health-detail-item">
                <span class="health-detail-label">Duplicate Rows:</span>
                <span class="health-detail-val" style="${profile.duplicate_rows > 0 ? "color: #d97706; font-weight:700;" : "color: var(--text-muted);"}">
                    ${profile.duplicate_rows || 0}
                </span>
            </div>
        `;
    }

    function renderKpis(kpis) {
        const kpisGrid = $("analysis-kpis-grid");
        if (!kpisGrid || !kpis) return;

        const grossSpend = kpis.gross_spend !== null && kpis.gross_spend !== undefined
            ? "$" + kpis.gross_spend.toLocaleString(undefined, { maximumFractionDigits: 0 })
            : "—";

        const aov = kpis.avg_order_value !== null && kpis.avg_order_value !== undefined
            ? "$" + kpis.avg_order_value.toLocaleString(undefined, { maximumFractionDigits: 2 })
            : "—";

        const totalQty = kpis.total_quantity !== null && kpis.total_quantity !== undefined
            ? kpis.total_quantity.toLocaleString()
            : "—";

        let topCatHtml = "—";
        if (kpis.top_category && kpis.top_category.category) {
            topCatHtml = `${escapeHtml(kpis.top_category.category)} <span style="font-size:0.75rem; color:var(--text-muted); font-weight:500;">(${kpis.top_category.count})</span>`;
        }

        kpisGrid.innerHTML = `
            <div class="kpi-card">
                <span class="kpi-title">Gross Volume / Spend</span>
                <div class="kpi-value">${grossSpend}</div>
                <span class="kpi-sub">${kpis.spend_column ? `Based on ${escapeHtml(kpis.spend_column)}` : "Total numeric sum"}</span>
            </div>
            <div class="kpi-card">
                <span class="kpi-title">Avg Order Value (AOV)</span>
                <div class="kpi-value">${aov}</div>
                <span class="kpi-sub">Mean spend per recorded row</span>
            </div>
            <div class="kpi-card">
                <span class="kpi-title">Total Units / Volume</span>
                <div class="kpi-value">${totalQty}</div>
                <span class="kpi-sub">${kpis.qty_column ? `Based on ${escapeHtml(kpis.qty_column)}` : "Aggregated item units"}</span>
            </div>
            <div class="kpi-card">
                <span class="kpi-title">Dominant Category</span>
                <div class="kpi-value" style="font-size:1.15rem; word-break:break-word;">${topCatHtml}</div>
                <span class="kpi-sub">Highest frequency segment</span>
            </div>
        `;
    }

    function renderColumnTable(columns) {
        const tableBody = $("analysis-table-body");
        if (!tableBody || !columns) return;

        const countAll = $("col-filter-count-all");
        const countNum = $("col-filter-count-num");
        const countCat = $("col-filter-count-cat");
        const countIssues = $("col-filter-count-issues");

        const numCols = columns.filter(c => c.dtype === "Numeric");
        const catCols = columns.filter(c => c.dtype !== "Numeric");
        const issueCols = columns.filter(c => c.null_count > 0 || (c.negatives && c.negatives > 0));

        if (countAll) countAll.textContent = columns.length;
        if (countNum) countNum.textContent = numCols.length;
        if (countCat) countCat.textContent = catCols.length;
        if (countIssues) countIssues.textContent = issueCols.length;

        function updateRows() {
            let filtered = columns;
            if (activeFilter === "numeric") filtered = numCols;
            else if (activeFilter === "categorical") filtered = catCols;
            else if (activeFilter === "issues") filtered = issueCols;

            if (searchQuery.trim()) {
                const q = searchQuery.toLowerCase().trim();
                filtered = filtered.filter(c => c.name.toLowerCase().includes(q));
            }

            if (filtered.length === 0) {
                tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 32px; color: var(--text-muted);">No columns match your filter or search query.</td></tr>`;
                return;
            }

            tableBody.innerHTML = filtered.map(col => {
                const isNum = col.dtype === "Numeric";
                const cleanP = col.clean_pct ?? 100.0;
                const fillClass = cleanP >= 95 ? "high" : (cleanP >= 80 ? "med" : "low");
                const typeBadge = isNum 
                    ? `<span class="col-type-badge col-type-numeric">💵 Numeric</span>`
                    : `<span class="col-type-badge col-type-text">🏷️ Categorical</span>`;

                let statsHtml = "";
                if (isNum) {
                    const tags = [];
                    if (col.min !== null && col.min !== undefined) tags.push(`<span class="stat-tag"><strong>Min:</strong> ${col.min.toLocaleString()}</span>`);
                    if (col.median !== null && col.median !== undefined) tags.push(`<span class="stat-tag"><strong>Med:</strong> ${col.median.toLocaleString()}</span>`);
                    if (col.mean !== null && col.mean !== undefined) tags.push(`<span class="stat-tag"><strong>Avg:</strong> ${col.mean.toLocaleString()}</span>`);
                    if (col.max !== null && col.max !== undefined) tags.push(`<span class="stat-tag"><strong>Max:</strong> ${col.max.toLocaleString()}</span>`);
                    if (col.std !== null && col.std !== undefined) tags.push(`<span class="stat-tag"><strong>σ:</strong> ${col.std.toLocaleString()}</span>`);
                    if (col.negatives) tags.push(`<span class="stat-tag" style="background:#fef2f2; border-color:#fecaca; color:#b91c1c;">⚠️ ${col.negatives} negatives</span>`);
                    if (col.zeros) tags.push(`<span class="stat-tag" style="color:#64748b;">${col.zeros} zeros</span>`);
                    statsHtml = `<div class="stat-summary-tags">${tags.join("")}</div>`;
                } else if (col.top_values && col.top_values.length) {
                    const pills = col.top_values.map(v => 
                        `<span class="top-val-pill">${escapeHtml(v.val)} <span style="color:var(--text-muted); font-size:0.7em;">(${v.count})</span></span>`
                    ).join("");
                    statsHtml = pills;
                } else {
                    statsHtml = `<span style="color:var(--text-muted); font-size:0.75rem;">—</span>`;
                }

                return `
                    <tr>
                        <td><strong>${escapeHtml(col.name)}</strong></td>
                        <td>${typeBadge}</td>
                        <td>
                            <div class="completeness-cell">
                                <div class="completeness-track">
                                    <div class="completeness-fill ${fillClass}" style="width: ${cleanP}%;"></div>
                                </div>
                                <span class="completeness-text">${cleanP}%</span>
                            </div>
                        </td>
                        <td>${col.null_count > 0 ? `<span style="color: #dc2626; font-weight:700;">${col.null_count} nulls</span>` : `<span style="color: #16a34a; font-weight:600;">0 clean</span>`}</td>
                        <td>${col.unique_count.toLocaleString()} unique</td>
                        <td>${statsHtml}</td>
                    </tr>
                `;
            }).join("");
        }

        updateRows();

        // Wire filter chips
        document.querySelectorAll("#analysis-col-filters .col-filter-chip").forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll("#analysis-col-filters .col-filter-chip").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                activeFilter = btn.dataset.colFilter;
                updateRows();
            };
        });

        // Wire search box
        const searchBox = $("col-search-input");
        if (searchBox) {
            searchBox.oninput = (e) => {
                searchQuery = e.target.value;
                updateRows();
            };
        }
    }

    async function init() {
        const params = new URLSearchParams(window.location.search);
        const token = params.get("token");

        if (!token) {
            showError("No Dataset Session Provided", "Please upload a dataset on the main anomaly report page first, then open Data Analysis.");
            return;
        }

        try {
            const res = await fetch(`/api/session-data/${encodeURIComponent(token)}`);
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                showError("Session Expired or Invalid", errData.error || "Please return to the Anomaly Report and re-upload your file.");
                return;
            }

            sessionData = await res.json();
        } catch (err) {
            showError("Connection Failed", "Unable to load session data: " + err.message);
            return;
        }

        const profile = sessionData.data_profile;
        if (!profile) {
            showError("Data Profile Unavailable", "Could not generate profiling statistics for this dataset.");
            return;
        }

        // Header pill
        const datasetTag = $("dataset-name-pill");
        if (datasetTag) {
            datasetTag.textContent = `${sessionData.filename || "Dataset"} • ${(profile.total_rows || 0).toLocaleString()} rows • ${profile.total_columns || 0} cols`;
        }

        renderHealthScore(profile);
        renderKpis(profile.executive_kpis);
        renderColumnTable(profile.columns);
    }

    window.addEventListener("DOMContentLoaded", init);
})();
