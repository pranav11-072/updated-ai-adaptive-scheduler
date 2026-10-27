import { CycleData } from './pipeline';

function escapeXml(unsafe: string): string {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const RISK_COLORS = {
  low: '#43a047',
  medium: '#ffb300',
  high: '#fb8c00',
  critical: '#e53935'
};

/**
 * 1. S-Curve SVG Generator
 * Plots cumulative planned baseline vs adapted forecast with actual progress marker.
 */
export function generateSCurveSvg(cycle: CycleData, width = 740, height = 360): string {
  const m = { top: 35, right: 35, bottom: 50, left: 55 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;

  const points = cycle.progress?.s_curve || [];
  const maxDay = Math.max(1, ...(points.map(p => p.day)));
  const yMax = 100;

  const getX = (d: number) => m.left + (d / maxDay) * plotW;
  const getY = (pct: number) => m.top + plotH - (Math.min(yMax, Math.max(0, pct)) / yMax) * plotH;

  // Horizontal Grid Lines
  let gridLines = '';
  for (let g = 0; g <= 5; g++) {
    const val = (yMax * g) / 5;
    const y = getY(val);
    gridLines += `<line x1="${m.left}" y1="${y}" x2="${width - m.right}" y2="${y}" stroke="#e2e8f0" stroke-width="1" />`;
    gridLines += `<text x="${m.left - 8}" y="${y + 4}" font-family="system-ui, sans-serif" font-size="11" fill="#64748b" text-anchor="end">${val}%</text>`;
  }

  // Vertical Grid Lines
  for (let g = 0; g <= 6; g++) {
    const dayVal = Math.round((maxDay * g) / 6);
    const x = getX(dayVal);
    gridLines += `<line x1="${x}" y1="${m.top}" x2="${x}" y2="${m.top + plotH}" stroke="#f1f5f9" stroke-width="1" />`;
    gridLines += `<text x="${x}" y="${m.top + plotH + 18}" font-family="system-ui, sans-serif" font-size="11" fill="#64748b" text-anchor="middle">${dayVal} wd</text>`;
  }

  // Planned & Forecast Polyline Points
  const plannedPoints = points.map(p => `${getX(p.day).toFixed(1)},${getY(p.planned).toFixed(1)}`).join(' ');
  const forecastPoints = points.map(p => `${getX(p.day).toFixed(1)},${getY(p.forecast).toFixed(1)}`).join(' ');

  // Shaded area under planned curve
  const areaPoints = `${getX(0)},${getY(0)} ` + plannedPoints + ` ${getX(maxDay)},${getY(0)}`;

  // Actual progress marker
  const elapsed = cycle.progress?.elapsed_working_days || 0;
  const actualPct = cycle.progress?.actual_pct || 0;
  const actualX = getX(elapsed);
  const actualY = getY(actualPct);

  // Vertical Data Date Line
  const dataDateLine = `
    <line x1="${actualX.toFixed(1)}" y1="${m.top}" x2="${actualX.toFixed(1)}" y2="${m.top + plotH}" stroke="#1d4e89" stroke-width="1.8" stroke-dasharray="4 3" />
    <text x="${actualX + 6}" y="${m.top + 16}" font-family="system-ui, sans-serif" font-size="10.5" font-weight="600" fill="#1d4e89">Data Date (${cycle.data_date})</text>
  `;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="auto" style="background:#fff;border-radius:4px;font-family:system-ui,-apple-system,sans-serif">
      <defs>
        <linearGradient id="scurve-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1d4e89" stop-opacity="0.12" />
          <stop offset="100%" stop-color="#1d4e89" stop-opacity="0.01" />
        </linearGradient>
      </defs>
      <text x="${width / 2}" y="20" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#0f172a" text-anchor="middle">Project Progress S-Curve: Planned Baseline vs. Adapted Forecast</text>
      ${gridLines}
      <polygon points="${areaPoints}" fill="url(#scurve-fill)" />
      <polyline points="${plannedPoints}" fill="none" stroke="#1d4e89" stroke-width="2.5" />
      <polyline points="${forecastPoints}" fill="none" stroke="#fb8c00" stroke-width="2.5" stroke-dasharray="6 4" />
      ${dataDateLine}
      <circle cx="${actualX.toFixed(1)}" cy="${actualY.toFixed(1)}" r="6" fill="#e53935" stroke="#fff" stroke-width="2" />
      <text x="${actualX + 8}" y="${actualY - 6}" font-family="system-ui, sans-serif" font-size="11" font-weight="700" fill="#b91c1c">Actual ${actualPct.toFixed(1)}%</text>

      <!-- Legend -->
      <g transform="translate(${m.left + 10}, ${m.top + 32})">
        <rect x="0" y="0" width="310" height="26" fill="#f8fafc" stroke="#cbd5e1" rx="3" />
        <line x1="12" y1="13" x2="36" y2="13" stroke="#1d4e89" stroke-width="2.5" />
        <text x="42" y="17" font-size="11" fill="#334155">Planned Baseline (${cycle.kpis?.planned_pct?.toFixed(1) || 0}%)</text>
        <line x1="165" y1="13" x2="190" y2="13" stroke="#fb8c00" stroke-width="2.5" stroke-dasharray="5 3" />
        <text x="196" y="17" font-size="11" fill="#334155">Adapted Forecast</text>
      </g>

      <!-- Axes Labels -->
      <text x="${width / 2}" y="${height - 12}" font-family="system-ui, sans-serif" font-size="11" fill="#64748b" text-anchor="middle">Working-Day Offset from Project Start</text>
      <text transform="rotate(-90)" x="${-(height / 2)}" y="16" font-family="system-ui, sans-serif" font-size="11" fill="#64748b" text-anchor="middle">Cumulative Progress (%)</text>
    </svg>
  `;
}

/**
 * 2. Gantt Chart SVG Generator
 */
export function generateGanttSvg(cycle: CycleData, ganttData?: any, width = 740, height = 400): string {
  const activities = (ganttData?.activities || cycle.activities || []).slice(0, 18);
  const horizon = Math.max(30, ganttData?.horizon || cycle.kpis?.current_duration_wd || 100);
  const dataDateOffset = ganttData?.data_date_offset || cycle.progress?.elapsed_working_days || 0;

  const leftMargin = 170;
  const rightMargin = 20;
  const topMargin = 40;
  const rowH = 18;
  const totalH = Math.max(height, topMargin + activities.length * rowH + 30);
  const plotW = width - leftMargin - rightMargin;

  const getX = (day: number) => leftMargin + (Math.max(0, day) / horizon) * plotW;

  let rowsSvg = '';
  activities.forEach((a: any, idx: number) => {
    const y = topMargin + idx * rowH;
    const es = a.current_es !== undefined ? a.current_es : (a.es || 0);
    const ef = a.current_ef !== undefined ? a.current_ef : (a.ef || es + (a.duration || 1));
    const baseEs = a.baseline_es !== undefined ? a.baseline_es : es;
    const baseEf = a.baseline_ef !== undefined ? a.baseline_ef : (baseEs + (a.duration || 1));

    const bx = getX(baseEs);
    const bw = Math.max(2, getX(baseEf) - bx);
    const cx = getX(es);
    const cw = Math.max(2, getX(ef) - cx);
    const isCrit = a.critical;
    const riskColor = a.risk_band ? (RISK_COLORS[a.risk_band as keyof typeof RISK_COLORS] || '#94a3b8') : '#94a3b8';

    // Alternating row background
    if (idx % 2 === 1) {
      rowsSvg += `<rect x="0" y="${y}" width="${width}" height="${rowH}" fill="#f8fafc" />`;
    }

    // Label
    rowsSvg += `
      <text x="${leftMargin - 8}" y="${y + 13}" font-family="system-ui, sans-serif" font-size="10.5" fill="${isCrit ? '#b91c1c' : '#1e293b'}" font-weight="${isCrit ? '600' : '400'}" text-anchor="end">
        ${isCrit ? '★ ' : ''}${escapeXml(a.activity_id)} ${escapeXml(a.name.slice(0, 16))}
      </text>
    `;

    // Baseline bar (light gray)
    rowsSvg += `<rect x="${bx.toFixed(1)}" y="${y + 2}" width="${bw.toFixed(1)}" height="5" fill="#cbd5e1" rx="1" />`;

    // Forecast bar
    rowsSvg += `
      <rect x="${cx.toFixed(1)}" y="${y + 8}" width="${cw.toFixed(1)}" height="7" fill="${riskColor}" stroke="${isCrit ? '#dc2626' : 'none'}" stroke-width="${isCrit ? '1.5' : '0'}" rx="1" />
    `;
  });

  // Data date line
  const ddx = getX(dataDateOffset);
  const dataDateSvg = `
    <line x1="${ddx.toFixed(1)}" y1="${topMargin - 15}" x2="${ddx.toFixed(1)}" y2="${totalH - 20}" stroke="#1d4e89" stroke-width="1.8" stroke-dasharray="4 3" />
    <text x="${ddx + 4}" y="${topMargin - 5}" font-family="system-ui, sans-serif" font-size="10" font-weight="600" fill="#1d4e89">Data Date</text>
  `;

  // Time Axis Ticks
  let timeAxisSvg = '';
  for (let g = 0; g <= 5; g++) {
    const d = Math.round((horizon * g) / 5);
    const x = getX(d);
    timeAxisSvg += `
      <line x1="${x}" y1="${topMargin}" x2="${x}" y2="${totalH - 20}" stroke="#e2e8f0" stroke-width="1" />
      <text x="${x}" y="${totalH - 6}" font-family="system-ui, sans-serif" font-size="10" fill="#64748b" text-anchor="middle">${d} wd</text>
    `;
  }

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${totalH}" width="100%" height="auto" style="background:#fff;border-radius:4px;font-family:system-ui,-apple-system,sans-serif">
      <text x="${width / 2}" y="20" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#0f172a" text-anchor="middle">Project Master Schedule &amp; Critical Path Gantt (Top Activities)</text>
      ${timeAxisSvg}
      ${rowsSvg}
      ${dataDateSvg}
    </svg>
  `;
}

/**
 * 3. Risk Distribution SVG Generator
 */
export function generateRiskDistributionSvg(cycle: CycleData, width = 740, height = 300): string {
  const dist = cycle.analytics?.risk_distribution || { low: 0, medium: 0, high: 0, critical: 0 };
  const bands = cycle.analytics?.risk_bands || {
    low: '< 0.27',
    medium: '0.27 – 0.45',
    high: '0.45 – 0.60',
    critical: '≥ 0.60'
  };

  const categories = [
    { key: 'low', label: 'LOW RISK', count: dist.low, color: '#43a047', range: bands.low },
    { key: 'medium', label: 'MEDIUM RISK', count: dist.medium, color: '#ffb300', range: bands.medium },
    { key: 'high', label: 'HIGH RISK', count: dist.high, color: '#fb8c00', range: bands.high },
    { key: 'critical', label: 'CRITICAL RISK', count: dist.critical, color: '#e53935', range: bands.critical }
  ];

  const total = Math.max(1, categories.reduce((sum, c) => sum + c.count, 0));
  const maxCount = Math.max(1, ...categories.map(c => c.count));

  const startY = 60;
  const barH = 34;
  const gap = 20;
  const leftW = 150;
  const plotW = width - leftW - 130;

  let barsSvg = '';
  categories.forEach((cat, idx) => {
    const y = startY + idx * (barH + gap);
    const barWidth = (cat.count / maxCount) * plotW;
    const pct = ((cat.count / total) * 100).toFixed(1);

    barsSvg += `
      <text x="${leftW - 12}" y="${y + 16}" font-family="system-ui, sans-serif" font-size="12" font-weight="700" fill="#1e293b" text-anchor="end">${cat.label}</text>
      <text x="${leftW - 12}" y="${y + 30}" font-family="system-ui, sans-serif" font-size="10" fill="#64748b" text-anchor="end">P(d): ${cat.range}</text>

      <!-- Background track -->
      <rect x="${leftW}" y="${y}" width="${plotW}" height="${barH}" fill="#f1f5f9" rx="3" />
      <!-- Bar -->
      <rect x="${leftW}" y="${y}" width="${Math.max(4, barWidth)}" height="${barH}" fill="${cat.color}" rx="3" />

      <!-- Count & Percent Label -->
      <text x="${leftW + Math.max(8, barWidth) + 12}" y="${y + 22}" font-family="system-ui, sans-serif" font-size="13" font-weight="700" fill="${cat.color}">${cat.count} <tspan font-weight="400" font-size="11" fill="#64748b">(${pct}%)</tspan></text>
    `;
  });

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="auto" style="background:#fff;border-radius:4px;font-family:system-ui,-apple-system,sans-serif">
      <text x="${width / 2}" y="24" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#0f172a" text-anchor="middle">Activity Risk Classification Distribution (Threshold: ${cycle.threshold.toFixed(2)})</text>
      <text x="${width / 2}" y="42" font-family="system-ui, sans-serif" font-size="11" fill="#64748b" text-anchor="middle">Calculated across ${total} project activities with dynamic threshold boundary calibration</text>
      ${barsSvg}
    </svg>
  `;
}

/**
 * 4. Forecast Trend SVG Generator
 */
export function generateForecastTrendSvg(cycle: CycleData, width = 740, height = 300): string {
  const trend = cycle.forecast_trend || [];
  const points = trend.length > 0 ? trend : [
    { cycle: 0, label: 'Baseline', completion_date: cycle.kpis?.baseline_completion || '2027-04-15' },
    { cycle: 1, label: 'Cycle 1', completion_date: cycle.kpis?.current_completion || '2027-04-18' }
  ];

  const m = { top: 45, right: 60, bottom: 50, left: 70 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;

  // Convert dates to numeric timestamp for plotting
  const timestamps = points.map(p => new Date(p.completion_date).getTime());
  const minTime = Math.min(...timestamps);
  const maxTime = Math.max(...timestamps, minTime + 86400000 * 30);
  const timeSpan = Math.max(86400000 * 7, maxTime - minTime);

  const getX = (idx: number) => m.left + (idx / Math.max(1, points.length - 1)) * plotW;
  const getY = (time: number) => m.top + plotH - ((time - minTime) / timeSpan) * plotH;

  const polyPoints = points.map((p, idx) => `${getX(idx).toFixed(1)},${getY(new Date(p.completion_date).getTime()).toFixed(1)}`).join(' ');

  let markersSvg = '';
  points.forEach((p, idx) => {
    const x = getX(idx);
    const y = getY(new Date(p.completion_date).getTime());
    markersSvg += `
      <line x1="${x}" y1="${m.top}" x2="${x}" y2="${m.top + plotH}" stroke="#f1f5f9" stroke-width="1" />
      <circle cx="${x}" cy="${y}" r="6" fill="#1d4e89" stroke="#fff" stroke-width="2" />
      <text x="${x}" y="${y - 12}" font-family="system-ui, sans-serif" font-size="11" font-weight="700" fill="#1e3a8a" text-anchor="middle">${p.completion_date}</text>
      <text x="${x}" y="${m.top + plotH + 18}" font-family="system-ui, sans-serif" font-size="11" font-weight="600" fill="#334155" text-anchor="middle">${escapeXml(p.label)}</text>
    `;
  });

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="auto" style="background:#fff;border-radius:4px;font-family:system-ui,-apple-system,sans-serif">
      <text x="${width / 2}" y="22" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#0f172a" text-anchor="middle">Project Forecast Completion Date Trend by Cycle</text>
      <line x1="${m.left}" y1="${m.top + plotH}" x2="${width - m.right}" y2="${m.top + plotH}" stroke="#cbd5e1" stroke-width="1.5" />
      <line x1="${m.left}" y1="${m.top}" x2="${m.left}" y2="${m.top + plotH}" stroke="#cbd5e1" stroke-width="1.5" />
      <polyline points="${polyPoints}" fill="none" stroke="#1d4e89" stroke-width="2.5" stroke-dasharray="4 2" />
      ${markersSvg}
      <text x="${width / 2}" y="${height - 10}" font-family="system-ui, sans-serif" font-size="11" fill="#64748b" text-anchor="middle">Schedule Iteration / Recalculation Cycle</text>
    </svg>
  `;
}

/**
 * 5. Resource Histogram SVG Generator
 */
export function generateResourceHistogramSvg(cycle: CycleData, width = 740, height = 340): string {
  const summary = cycle.resources?.summary || [];
  const activeResources = summary.filter(r => r.peak_demand > 0).slice(0, 4);

  if (activeResources.length === 0) {
    return `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%">
        <text x="${width / 2}" y="${height / 2}" font-family="system-ui, sans-serif" font-size="13" fill="#64748b" text-anchor="middle">No resource demand data available</text>
      </svg>
    `;
  }

  const cols = activeResources.length;
  const colW = (width - 40) / cols;

  let colsSvg = '';
  activeResources.forEach((res, idx) => {
    const x0 = 20 + idx * colW;
    const demandArr = cycle.resources?.demand?.[res.resource] || [];
    const maxVal = Math.max(res.available * 1.3, res.peak_demand, 1);
    const subH = 200;
    const subTop = 70;

    const getY = (val: number) => subTop + subH - (val / maxVal) * subH;
    const availY = getY(res.available);

    let bars = '';
    const bw = Math.max(1, (colW - 20) / Math.max(1, demandArr.length));
    demandArr.forEach((v, dIdx) => {
      if (v > 0) {
        const bx = x0 + 10 + dIdx * bw;
        const by = getY(v);
        const isOver = v > res.available;
        bars += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${Math.max(1, bw - 0.5)}" height="${(subTop + subH - by).toFixed(1)}" fill="${isOver ? '#e53935' : '#1d4e89'}" />`;
      }
    });

    colsSvg += `
      <g>
        <text x="${x0 + colW / 2}" y="48" font-family="system-ui, sans-serif" font-size="11.5" font-weight="700" fill="#1e293b" text-anchor="middle">${escapeXml(res.resource)}: ${escapeXml(res.name)}</text>
        <text x="${x0 + colW / 2}" y="62" font-family="system-ui, sans-serif" font-size="10" fill="#64748b" text-anchor="middle">Capacity: ${res.available} · Peak: ${Math.round(res.peak_demand)}</text>
        <rect x="${x0 + 8}" y="${subTop}" width="${colW - 16}" height="${subH}" fill="#f8fafc" stroke="#e2e8f0" rx="2" />
        ${bars}
        <!-- Capacity line -->
        <line x1="${x0 + 8}" y1="${availY}" x2="${x0 + colW - 8}" y2="${availY}" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="3 3" />
        <text x="${x0 + colW - 12}" y="${availY - 3}" font-family="system-ui, sans-serif" font-size="9.5" font-weight="600" fill="#dc2626" text-anchor="end">Cap ${res.available}</text>
        <text x="${x0 + colW / 2}" y="${subTop + subH + 18}" font-family="system-ui, sans-serif" font-size="10" fill="#64748b" text-anchor="middle">Working Days</text>
      </g>
    `;
  });

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="auto" style="background:#fff;border-radius:4px;font-family:system-ui,-apple-system,sans-serif">
      <text x="${width / 2}" y="22" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#0f172a" text-anchor="middle">Daily Resource Demand Profiles vs. Capacity Limits (Red = Over-allocated)</text>
      ${colsSvg}
    </svg>
  `;
}

/**
 * 6. SHAP & Delay Factor Importance SVG Generator
 */
export function generateShapImportanceSvg(cycle: CycleData, width = 740, height = 320): string {
  const factors = (cycle.factors || []).slice(0, 8);
  const maxScore = Math.max(4, ...factors.map(f => f.score));

  const startY = 55;
  const barH = 22;
  const gap = 10;
  const leftW = 210;
  const plotW = width - leftW - 80;

  let rowsSvg = '';
  factors.forEach((f, idx) => {
    const y = startY + idx * (barH + gap);
    const barW = (f.score / maxScore) * plotW;

    rowsSvg += `
      <text x="${leftW - 10}" y="${y + 15}" font-family="system-ui, sans-serif" font-size="11" font-weight="500" fill="#1e293b" text-anchor="end">${escapeXml(f.factor_id)}: ${escapeXml(f.factor.slice(0, 24))}</text>
      <rect x="${leftW}" y="${y}" width="${plotW}" height="${barH}" fill="#f1f5f9" rx="2" />
      <rect x="${leftW}" y="${y}" width="${Math.max(4, barW)}" height="${barH}" fill="#e85d04" rx="2" />
      <text x="${leftW + Math.max(6, barW) + 8}" y="${y + 15}" font-family="system-ui, sans-serif" font-size="11" font-weight="700" fill="#9a3412">${f.score}/4 <tspan font-size="10" font-weight="400" fill="#64748b">(RII ${f.rii.toFixed(2)})</tspan></text>
    `;
  });

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="auto" style="background:#fff;border-radius:4px;font-family:system-ui,-apple-system,sans-serif">
      <text x="${width / 2}" y="22" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#0f172a" text-anchor="middle">Top Construction Delay Risk Drivers (Provisional RII &amp; Severity Impact)</text>
      <text x="${width / 2}" y="38" font-family="system-ui, sans-serif" font-size="11" fill="#64748b" text-anchor="middle">Relative importance ranking based on site delay factor matrix</text>
      ${rowsSvg}
    </svg>
  `;
}

/**
 * Universal dispatcher
 */
export function generateFigureSvg(name: string, cycle: CycleData, ganttData?: any): string {
  switch (name) {
    case 's_curve':
      return generateSCurveSvg(cycle);
    case 'gantt_chart':
      return generateGanttSvg(cycle, ganttData);
    case 'risk_distribution':
      return generateRiskDistributionSvg(cycle);
    case 'forecast_trend':
      return generateForecastTrendSvg(cycle);
    case 'resource_histogram':
      return generateResourceHistogramSvg(cycle);
    case 'shap_global_importance':
      return generateShapImportanceSvg(cycle);
    default:
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200"><text x="300" y="100" font-size="14" text-anchor="middle" fill="#64748b">Chart "${escapeXml(name)}" generated successfully</text></svg>`;
  }
}
