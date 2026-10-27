(function() {
  const RISK = { low: '#43a047', medium: '#ffb300', high: '#fb8c00', critical: '#e53935' };
  const NS = 'http://www.w3.org/2000/svg';
  const dataEl = document.getElementById('cycle-data');
  let D = dataEl ? JSON.parse(dataEl.textContent) : null;
  window.__CYCLE_DATA = D;
  const page = document.body.dataset.page;

  function s(tag, a, p) {
    const e = document.createElementNS(NS, tag);
    for (const k in a || {}) e.setAttribute(k, a[k]);
    if (p) p.appendChild(e);
    return e;
  }

  function lineChart(host, o) {
    if (!host) return;
    const W = o.w || 680;
    const H = o.h || 280;
    const m = { l: 46, r: 24, t: 16, b: 38 };
    host.innerHTML = '';

    if (!o.xs || o.xs.length === 0) {
      host.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted)">No chart data available</div>';
      return;
    }

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' }, host);
    const xmax = Math.max(1, ...o.xs);
    const ymax = o.ymax || 100;
    const X = x => m.l + (x / xmax) * (W - m.l - m.r);
    const Y = y => H - m.b - (Math.min(ymax, Math.max(0, y)) / ymax) * (H - m.t - m.b);

    // Y grid and labels
    for (let g = 0; g <= 4; g++) {
      const y = (ymax * g) / 4;
      s('line', { x1: m.l, x2: W - m.r, y1: Y(y), y2: Y(y), stroke: '#e2dccb' }, svg);
      const t = s('text', { x: m.l - 6, y: Y(y) + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#5c6477' }, svg);
      t.textContent = y.toFixed(0) + (o.yunit || '%');
    }

    // X grid and labels
    for (let g = 0; g <= 6; g++) {
      const x = (xmax * g) / 6;
      s('line', { x1: X(x), x2: X(x), y1: m.t, y2: H - m.b, stroke: '#f0ebe0' }, svg);
      const t = s('text', { x: X(x), y: H - m.b + 14, 'text-anchor': 'middle', 'font-size': 10, fill: '#5c6477' }, svg);
      t.textContent = Math.round(x);
    }

    const xl = s('text', { x: W / 2, y: H - 4, 'text-anchor': 'middle', 'font-size': 10, fill: '#5c6477' }, svg);
    xl.textContent = o.xlabel || 'Working-day offset';

    // Series polylines
    (o.series || []).forEach(se => {
      const pts = o.xs.map((x, k) => `${X(x)},${Y(se.ys[k] !== undefined ? se.ys[k] : 0)}`).join(' ');
      s('polyline', {
        points: pts,
        fill: 'none',
        stroke: se.color,
        'stroke-width': 2.2,
        'stroke-dasharray': se.dash || ''
      }, svg);
    });

    // Special markers / data date point
    (o.points || []).forEach(p => {
      if (p.x !== undefined && p.y !== undefined) {
        s('circle', { cx: X(p.x), cy: Y(p.y), r: 5.5, fill: p.color, stroke: '#fff', 'stroke-width': 1.5 }, svg);
        const t = s('text', { x: Math.min(W - m.r - 40, X(p.x) + 8), y: Y(p.y) - 6, 'font-size': 10.5, 'font-weight': '600', fill: p.color }, svg);
        t.textContent = p.label;
      }
    });

    // Vertical line at data date
    if (o.vline !== undefined) {
      s('line', {
        x1: X(o.vline),
        x2: X(o.vline),
        y1: m.t,
        y2: H - m.b,
        stroke: '#1d4e89',
        'stroke-width': 1.5,
        'stroke-dasharray': '4 3'
      }, svg);
      const vlText = s('text', { x: X(o.vline) + 4, y: m.t + 10, 'font-size': 9.5, fill: '#1d4e89' }, svg);
      vlText.textContent = 'Data date (' + o.vline + ' wd)';
    }
  }

  function renderSCurve(host, progressData) {
    if (!host || !progressData) return;
    const sc = progressData.s_curve || [];
    if (sc.length === 0) return;
    lineChart(host, {
      xs: sc.map(r => r.day),
      xlabel: 'Working-day offset from start',
      yunit: '%',
      series: [
        { name: 'Planned (baseline)', color: '#1d4e89', ys: sc.map(r => r.planned) },
        { name: 'Forecast (adapted)', color: '#fb8c00', dash: '6 4', ys: sc.map(r => r.forecast) }
      ],
      points: [
        {
          x: progressData.elapsed_working_days || 0,
          y: progressData.actual_pct || 0,
          color: '#d50000',
          label: `Actual ${(progressData.actual_pct || 0).toFixed(1)}%`
        }
      ],
      vline: progressData.elapsed_working_days
    });
  }

  function bars(host, items) {
    if (!host) return;
    host.innerHTML = '';
    if (!items || items.length === 0) {
      host.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px">No data available</div>';
      return;
    }
    const mx = Math.max(1, ...items.map(i => i.value));
    const total = items.reduce((sum, i) => sum + i.value, 0);

    items.forEach(i => {
      const pct = total > 0 ? Math.round((i.value / total) * 100) : 0;
      const r = document.createElement('div');
      r.style.cssText = 'display:flex;align-items:center;gap:8px;margin:6px 0';
      r.innerHTML = `
        <span style="width:115px;font-size:11.5px;color:var(--ink);text-overflow:ellipsis;overflow:hidden;white-space:nowrap;font-weight:500" title="${i.label}">${i.label}</span>
        <div style="flex:1;background:#eee7d6;height:16px;border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${(i.value / mx) * 100}%;background:${i.color};transition:width .2s"></div>
        </div>
        <span class="mono" style="width:40px;text-align:right;font-size:12px;font-weight:600">${i.value}</span>
        <span style="width:36px;font-size:11px;color:var(--muted);text-align:right">${pct}%</span>
      `;
      host.appendChild(r);
    });
  }

  function dualBars(host, items) {
    if (!host) return;
    host.innerHTML = '';
    if (!items || items.length === 0) {
      host.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px">No floor data available</div>';
      return;
    }
    items.forEach(it => {
      const r = document.createElement('div');
      r.style.cssText = 'margin:7px 0;padding-bottom:5px;border-bottom:1px solid #f0ebe0';
      r.innerHTML = `
        <div style="display:flex;justify-content:space-between;margin-bottom:2px;align-items:center">
          <span style="font-weight:600;font-size:11.5px;color:var(--ink)">${it.label}</span>
          <span style="font-size:11px;color:var(--muted)">${it.tasks} tasks ${it.critical > 0 ? `<b style="color:var(--critical);margin-left:4px">(${it.critical} crit)</b>` : ''}</span>
        </div>
        <div style="display:grid;grid-template-columns:40px 1fr 35px;align-items:center;gap:6px;margin:2px 0">
          <span style="font-size:10.5px;color:#1d4e89">Plan:</span>
          <div style="background:#e8edf5;height:8px;border-radius:2px;overflow:hidden">
            <div style="background:#1d4e89;height:100%;width:${Math.min(100, Math.max(0, it.planned))}%"></div>
          </div>
          <span class="mono" style="font-size:10.5px;text-align:right">${it.planned.toFixed(0)}%</span>
        </div>
        <div style="display:grid;grid-template-columns:40px 1fr 35px;align-items:center;gap:6px;margin:2px 0">
          <span style="font-size:10.5px;color:${it.actual < it.planned ? '#e53935' : '#43a047'}">Act:</span>
          <div style="background:#e8edf5;height:8px;border-radius:2px;overflow:hidden">
            <div style="background:${it.actual < it.planned ? '#e53935' : '#43a047'};height:100%;width:${Math.min(100, Math.max(0, it.actual))}%"></div>
          </div>
          <span class="mono" style="font-size:10.5px;text-align:right">${it.actual.toFixed(0)}%</span>
        </div>
      `;
      host.appendChild(r);
    });
  }

  function demand(host, vals, avail, title) {
    if (!host) return;
    host.innerHTML = '';
    const W = 420;
    const H = 120;
    const m = { l: 30, r: 6, t: 16, b: 14 };
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' }, host);
    const ymax = Math.max(avail, ...vals) * 1.15 || 1;
    const bw = (W - m.l - m.r) / (vals.length || 1);
    const Y = y => H - m.b - (y / ymax) * (H - m.t - m.b);

    vals.forEach((v, i) => {
      if (v > 0) {
        s('rect', {
          x: m.l + i * bw,
          y: Y(v),
          width: Math.max(bw - 0.2, 0.6),
          height: H - m.b - Y(v),
          fill: v > avail ? '#e53935' : '#1d4e89'
        }, svg);
      }
    });

    s('line', {
      x1: m.l,
      x2: W - m.r,
      y1: Y(avail),
      y2: Y(avail),
      stroke: '#000',
      'stroke-dasharray': '4 3'
    }, svg);

    const t = s('text', { x: m.l, y: 11, 'font-size': 11, fill: '#14213d' }, svg);
    t.textContent = title + ' (capacity ' + avail + ', dashed)';
  }

  // --- DASHBOARD REAL-TIME RENDERER ---
  function renderDashboard(data) {
    if (!data) return;
    const k = data.kpis;

    const setEl = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    const setHtml = (id, html) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    };

    // 1. Dashboard KPI Cards
    if (k) {
      setEl('kpi-baseline-completion', k.baseline_completion || '–');
      setEl('kpi-baseline-duration', `${k.baseline_duration_wd} working days`);
      setEl('kpi-current-completion', k.current_completion || '–');
      setEl('kpi-current-duration', `${k.current_duration_wd} working days`);

      const varEl = document.getElementById('kpi-schedule-variance');
      if (varEl) {
        varEl.textContent = (k.schedule_variance_wd > 0 ? '+' : '') + k.schedule_variance_wd + ' wd';
        varEl.className = 'v ' + (k.schedule_variance_wd > 0 ? 'bad' : 'ok');
      }
      setEl('kpi-calendar-slip', (k.calendar_slip_days > 0 ? '+' : '') + k.calendar_slip_days + ' calendar days');

      setEl('kpi-cpm-migration', k.critical_path_migrated ? 'YES' : 'No');
      setEl('kpi-cpm-details', `new: ${(k.newly_critical || []).join(', ') || 'none'} · left: ${(k.left_critical || []).join(', ') || 'none'}`);

      setEl('kpi-progress', `${(k.planned_pct || 0).toFixed(1)} / ${(k.actual_pct || 0).toFixed(1)} %`);
      setEl('kpi-progress-variance', `variance ${(k.progress_variance_pct > 0 ? '+' : '') + (k.progress_variance_pct || 0).toFixed(1)} pts`);

      setEl('kpi-critical-counts', `${k.critical_activities} / ${k.near_critical_count}`);
      setEl('kpi-float-erosion', `${k.eroded_float_count} with float erosion`);

      setEl('kpi-at-risk-count', k.at_risk_count !== null && k.at_risk_count !== undefined ? k.at_risk_count : 'n/a');
      setEl('kpi-at-risk-sub', `${k.adapted_activities} adapted · ${k.recommendation_count} recommendations`);

      setEl('kpi-risk-index', (data.composite_risk_index !== undefined ? data.composite_risk_index.toFixed(2) : '0.00'));
    }

    // 2. EVM Block
    const evm = data.analytics ? data.analytics.evm : null;
    if (evm) {
      setHtml('evm-status-chip', `${evm.schedule_status} · ${evm.cost_status}`);
      setEl('evm-pv', `₹${evm.planned_value.toLocaleString()}`);
      setEl('evm-bac', `Budget (BAC): ₹${evm.budget_at_completion.toLocaleString()}`);
      setEl('evm-ev', `₹${evm.earned_value.toLocaleString()}`);
      setHtml('evm-sv', `SV: <b class="${evm.schedule_variance >= 0 ? 'ok' : 'bad'}">${evm.schedule_variance >= 0 ? '+' : ''}₹${evm.schedule_variance.toLocaleString()}</b>`);
      setEl('evm-ac', `₹${evm.actual_cost.toLocaleString()}`);
      setHtml('evm-cv', `CV: <b class="${evm.cost_variance >= 0 ? 'ok' : 'bad'}">${evm.cost_variance >= 0 ? '+' : ''}₹${evm.cost_variance.toLocaleString()}</b>`);
      setHtml('evm-spi', `SPI: <b class="${evm.spi >= 1.0 ? 'ok' : 'bad'}">${evm.spi.toFixed(2)}</b>`);
      setHtml('evm-cpi', `CPI: <b class="${evm.cpi >= 1.0 ? 'ok' : 'bad'}">${evm.cpi.toFixed(2)}</b>`);
      setEl('evm-eac', `Estimate at finish: ₹${evm.estimate_at_completion.toLocaleString()}`);
      setEl('evm-data-date-note', `Calculated from activity cost & progress weights at data date ${data.data_date}`);
    }

    // 3. Status Distribution Chart
    const statusHost = document.getElementById('status-dist');
    if (statusHost && data.analytics && data.analytics.status_distribution) {
      const st = data.analytics.status_distribution;
      bars(statusHost, [
        { label: 'Completed', value: st.completed, color: '#2e7d32' },
        { label: 'In Progress', value: st.in_progress, color: '#1976d2' },
        { label: 'Not Started', value: st.not_started, color: '#90a4ae' },
        { label: 'Critical Path', value: st.critical, color: '#d50000' },
        { label: 'Near Critical', value: st.near_critical, color: '#f57c00' },
        { label: 'Delayed Tasks', value: st.delayed, color: '#7b1fa2' }
      ]);
    }

    // 4. Risk Distribution Chart
    const riskHost = document.getElementById('risk-dist');
    if (riskHost) {
      const c = data.analytics && data.analytics.risk_distribution
        ? data.analytics.risk_distribution
        : { low: 0, medium: 0, high: 0, critical: 0 };
      const rb = data.analytics && data.analytics.risk_bands ? data.analytics.risk_bands : null;
      const bandLabels = {
        low: rb ? `LOW (${rb.low})` : 'LOW',
        medium: rb ? `MEDIUM (${rb.medium})` : 'MEDIUM',
        high: rb ? `HIGH (${rb.high})` : 'HIGH',
        critical: rb ? `CRITICAL (${rb.critical})` : 'CRITICAL'
      };
      bars(riskHost, [
        { label: bandLabels.low, value: c.low || 0, color: RISK.low },
        { label: bandLabels.medium, value: c.medium || 0, color: RISK.medium },
        { label: bandLabels.high, value: c.high || 0, color: RISK.high },
        { label: bandLabels.critical, value: c.critical || 0, color: RISK.critical }
      ]);

      const legendEl = document.getElementById('risk-bands-legend');
      if (legendEl && rb) {
        legendEl.innerHTML = `Delay probabilities classified by threshold <b>${Number(data.threshold).toFixed(2)}</b>: Critical (${rb.critical}), High (${rb.high}), Med (${rb.medium}), Low (${rb.low})`;
      }
    }

    // 5. Floor-wise Distribution Chart
    const floorHost = document.getElementById('floor-dist');
    if (floorHost) {
      const flData = (data.analytics && data.analytics.floor_analytics && data.analytics.floor_analytics.length > 0)
        ? data.analytics.floor_analytics.map(f => ({
            label: f.floor,
            tasks: f.total_activities,
            critical: f.critical_activities,
            planned: f.planned_pct,
            actual: f.actual_pct
          }))
        : (data.progress && data.progress.floor_progress)
        ? data.progress.floor_progress.map(f => ({
            label: f.floor,
            tasks: f.total_activities,
            critical: f.critical_activities,
            planned: f.planned_pct,
            actual: f.actual_pct
          }))
        : [];
      dualBars(floorHost, flData);
    }

    // 6. S-Curve on Dashboard
    const dScurve = document.getElementById('dashboard-scurve');
    if (dScurve && data.progress) {
      renderSCurve(dScurve, data.progress);
    }

    // 7. Forecast Completion Trend Table & Chart
    const trendTbody = document.getElementById('forecast-trend-tbody');
    if (trendTbody && data.forecast_trend) {
      trendTbody.innerHTML = data.forecast_trend.map(p => `
        <tr>
          <td><b>${p.label}</b></td>
          <td>${p.data_date || '–'}</td>
          <td class="num mono"><b>${p.completion_date}</b></td>
        </tr>
      `).join('');
    }

    const trendChart = document.getElementById('forecast-trend-chart');
    if (trendChart && data.threshold !== undefined) {
      fetch(`/figures/forecast_trend.svg?threshold=${data.threshold}&t=${Date.now()}`)
        .then(r => r.text())
        .then(svgText => {
          if (trendChart) trendChart.innerHTML = svgText;
        })
        .catch(() => {});
    }

    // 8. Highest-risk activities table
    const riskTbody = document.getElementById('highest-risk-tbody');
    if (riskTbody && data.activities) {
      const sortedActs = data.activities.slice().sort((a, b) => (b.p_delay || 0) - (a.p_delay || 0)).slice(0, 8);
      riskTbody.innerHTML = sortedActs.map(a => `
        <tr>
          <td>${a.activity_id}</td>
          <td>${a.name}</td>
          <td class="num">${a.p_delay !== null ? Number(a.p_delay).toFixed(2) : '-'}</td>
          <td><span class="chip ${a.risk_band}">${a.risk_band}</span></td>
          <td class="num">${a.predicted_delay_days}</td>
          <td class="num">${a.injected_days}</td>
          <td>${a.critical ? '<span class="tag">critical</span>' : ''}</td>
          <td>${a.drivers || ''}</td>
        </tr>
      `).join('');
    }
  }

  function renderProgressPage(data) {
    if (!data || !data.progress) return;
    const p = data.progress;
    const scurveHost = document.getElementById('scurve');
    if (scurveHost) {
      renderSCurve(scurveHost, p);
    }

    // Update Progress KPIs
    const kpiElements = document.querySelectorAll('.grid.g4 .card.kpi .v');
    if (kpiElements.length >= 4) {
      kpiElements[0].textContent = (p.planned_pct || 0).toFixed(1) + ' %';
      kpiElements[1].textContent = (p.actual_pct || 0).toFixed(1) + ' %';
      const varEl = kpiElements[2];
      if (varEl) {
        varEl.textContent = ((p.variance_pct || 0) >= 0 ? '+' : '') + (p.variance_pct || 0).toFixed(1) + ' pts';
        varEl.className = 'v ' + ((p.variance_pct || 0) < 0 ? 'bad' : 'ok');
      }
      kpiElements[3].textContent = String(p.elapsed_working_days || 0);
    }
  }

  function renderResourcesPage(data) {
    if (!data || !data.resources) return;
    const host = document.getElementById('demand');
    if (!host) return;
    host.innerHTML = '';
    const res = data.resources;
    if (res.summary) {
      const row = document.createElement('div');
      row.className = 'grid g2';
      res.summary.forEach(r => {
        if (r.peak_demand > 0 && res.demand && res.demand[r.resource]) {
          const d = document.createElement('div');
          d.className = 'card';
          row.appendChild(d);
          demand(d, res.demand[r.resource], r.available, `${r.resource} - ${r.name}`);
        }
      });
      host.appendChild(row);
    }
  }

  // --- INITIAL PAGE RENDER ---
  if (D && page === 'dashboard') {
    renderDashboard(D);
  }

  if (D && page === 'progress') {
    const scHost = document.getElementById('scurve');
    if (scHost && D.progress) {
      renderSCurve(scHost, D.progress);
    }
  }

  if (page === 'gantt') {
    let currentG = null;
    const initialGanttEl = document.getElementById('gantt-initial-data');
    if (initialGanttEl) {
      try {
        currentG = JSON.parse(initialGanttEl.textContent);
      } catch (e) {
        currentG = null;
      }
    }

    const wrap = document.getElementById('gantt');
    const tip = document.getElementById('tip');

    const st = { ppd: 4, filter: 'all', floor: 'all', base: true, text: '' };
    const zoomEl = document.getElementById('zoom');
    if (zoomEl) zoomEl.oninput = e => { st.ppd = +e.target.value; drawGantt(); };
    const filterEl = document.getElementById('filter');
    if (filterEl) filterEl.onchange = e => { st.filter = e.target.value; drawGantt(); };
    const floorEl = document.getElementById('floor-select');
    if (floorEl) floorEl.onchange = e => { st.floor = e.target.value; drawGantt(); };
    const baseEl = document.getElementById('base');
    if (baseEl) baseEl.onchange = e => { st.base = e.target.checked; drawGantt(); };
    const findEl = document.getElementById('find');
    if (findEl) findEl.oninput = e => { st.text = e.target.value.toLowerCase(); drawGantt(); };

    function ok(a) {
      if (st.text && !(a.name + a.activity_id).toLowerCase().includes(st.text)) return false;
      if (st.floor !== 'all' && (a.floor || '') !== st.floor) return false;
      const f = st.filter;
      return f === 'all' ||
        (f === 'critical' && a.critical) ||
        (f === 'near' && a.near_critical) ||
        (f === 'atrisk' && (a.risk_band === 'high' || a.risk_band === 'critical')) ||
        (f === 'delayed' && a.injected_days > 0);
    }

    function drawGantt() {
      if (!currentG || !wrap) return;
      const acts = currentG.activities.filter(ok).sort((a, b) => a.current_es - b.current_es || a.activity_id.localeCompare(b.activity_id));
      const ppd = st.ppd;
      const W = Math.max(600, (currentG.horizon + 6) * ppd);
      const RH = 22;
      const top = 36;
      const H = top + acts.length * RH;

      wrap.innerHTML = '<div class="gantt-inner"><div class="gantt-labels"></div></div>';
      const L = wrap.querySelector('.gantt-labels');
      L.innerHTML = '<div class="hd">Activity</div>' + acts.map(a => `
        <div title="${a.name}">
          ${a.critical ? '<b style="color:#d50000">▌</b>' : '&nbsp;'}
          ${a.floor ? `<span style="font-size:9.5px;color:#475569;background:#e2e8f0;padding:1px 4px;border-radius:2px;margin-right:2px">${a.floor}</span> ` : ''}
          <b>${a.activity_id}</b> ${a.name}
        </div>
      `).join('');

      const svg = s('svg', { width: W, height: H });
      wrap.querySelector('.gantt-inner').appendChild(svg);

      // Timeline Month Markers & working days ticks
      let lastM = '';
      (currentG.offset_dates || []).forEach((d, k) => {
        const m = d.slice(0, 7);
        if (m !== lastM) {
          lastM = m;
          s('line', { x1: k * ppd, x2: k * ppd, y1: 0, y2: H, stroke: '#e6dfcc' }, svg);
          const t = s('text', { x: k * ppd + 3, y: 14, 'font-size': 10, fill: '#14213d' }, svg);
          t.textContent = new Date(d).toLocaleString('en', { month: 'short', year: '2-digit' });
        }
        if (k % 10 === 0) {
          const t = s('text', { x: k * ppd + 3, y: 30, 'font-size': 9, fill: '#7a8194' }, svg);
          t.textContent = k;
        }
      });

      // Activity Bars
      acts.forEach((a, i) => {
        const y = top + i * RH;
        // Baseline bar
        if (st.base) {
          const bDur = Math.max(a.baseline_ef - a.baseline_es, 0);
          if (bDur === 0) {
            const mx = a.baseline_es * ppd;
            s('polygon', {
              points: `${mx},${y + 11} ${mx + 6},${y + 5} ${mx + 12},${y + 11} ${mx + 6},${y + 17}`,
              fill: '#94a3b8'
            }, svg);
          } else {
            s('rect', {
              x: a.baseline_es * ppd,
              y: y + 3,
              width: Math.max(bDur * ppd, 2),
              height: 16,
              fill: '#cfd8dc'
            }, svg);
          }
        }

        // Current Forecast Bar
        const col = a.risk_band ? RISK[a.risk_band] : '#90a4ae';
        const cDur = Math.max(a.current_ef - a.current_es, 0);

        if (cDur === 0) {
          const mx = a.current_es * ppd;
          const poly = s('polygon', {
            points: `${mx},${y + 11} ${mx + 6},${y + 5} ${mx + 12},${y + 11} ${mx + 6},${y + 17}`,
            fill: a.critical ? '#d50000' : col,
            stroke: a.critical ? '#000' : 'none'
          }, svg);
          attachTip(poly, a);
        } else {
          const r = s('rect', {
            x: a.current_es * ppd,
            y: y + 6,
            width: Math.max(cDur * ppd, 2),
            height: 10,
            fill: col,
            stroke: a.critical ? '#d50000' : 'none',
            'stroke-width': a.critical ? 2 : 0
          }, svg);
          attachTip(r, a);
        }
      });

      function attachTip(elem, a) {
        if (!tip) return;
        elem.onmousemove = e => {
          tip.style.display = 'block';
          tip.style.left = (e.clientX + 14) + 'px';
          tip.style.top = (e.clientY + 14) + 'px';
          tip.innerHTML = `
            <b>${a.activity_id} ${a.name}</b> ${a.floor ? `[${a.floor}]` : ''}<br>
            Forecast: ${a.current_start} → ${a.current_finish} (${a.current_ef - a.current_es} wd)<br>
            Baseline: ${a.baseline_start} → ${a.baseline_finish} (${a.baseline_ef - a.baseline_es} wd)<br>
            Total float: <b>${a.total_float} wd</b> ${a.critical ? '<span style="color:#ef4444">(CRITICAL)</span>' : a.near_critical ? '<span style="color:#f59e0b">(near-critical)</span>' : ''}<br>
            ${a.p_delay !== null ? `P(delay): ${(a.p_delay * 100).toFixed(0)}% · Risk: ${a.risk_band} · Delay pred: ${a.predicted_delay_days}d<br>` : ''}
            Injected delay: ${a.injected_days}d · Progress: ${a.percent_complete}%<br>
            ${a.drivers ? `<span style="font-size:11px;color:#94a3b8">${a.drivers}</span>` : ''}
          `;
        };
        elem.onmouseleave = () => { tip.style.display = 'none'; };
      }

      // Data Date line
      s('line', {
        x1: currentG.data_date_offset * ppd,
        x2: currentG.data_date_offset * ppd,
        y1: 0,
        y2: H,
        stroke: '#1d4e89',
        'stroke-dasharray': '4 3',
        'stroke-width': 1.6
      }, svg);

      const countEl = document.getElementById('count');
      if (countEl) countEl.textContent = `${acts.length} of ${currentG.activities.length} activities shown`;
    }

    window.__LOAD_GANTT = function(newData) {
      if (newData) {
        currentG = newData;
        drawGantt();
        return;
      }
      const q = location.search;
      fetch('/api/gantt' + q)
        .then(r => r.json())
        .then(G => {
          currentG = G;
          drawGantt();
        })
        .catch(err => {
          console.error('[Gantt load error]', err);
        });
    };

    if (currentG) {
      drawGantt();
    } else {
      window.__LOAD_GANTT();
    }
  }

  // --- THRESHOLD FORM REAL-TIME RECALCULATION HANDLER ---
  const paramsForm = document.getElementById('params-form');
  const threshInput = document.getElementById('threshold-input');
  const applyBtn = document.getElementById('btn-apply-threshold');
  const feedbackEl = document.getElementById('threshold-feedback');

  function showFeedback(type, message) {
    if (!feedbackEl) return;
    feedbackEl.style.display = 'block';
    if (type === 'error') {
      feedbackEl.style.background = '#fdecea';
      feedbackEl.style.color = '#b71c1c';
      feedbackEl.style.borderBottom = '2px solid #ef5350';
      feedbackEl.innerHTML = `<b>⚠ Validation Error:</b> ${message}`;
    } else if (type === 'success') {
      feedbackEl.style.background = '#e8f5e9';
      feedbackEl.style.color = '#1b5e20';
      feedbackEl.style.borderBottom = '2px solid #66bb6a';
      feedbackEl.innerHTML = message;
    } else if (type === 'loading') {
      feedbackEl.style.background = '#e3f2fd';
      feedbackEl.style.color = '#0d47a1';
      feedbackEl.style.borderBottom = '2px solid #42a5f5';
      feedbackEl.innerHTML = `<i>${message}</i>`;
    }
  }

  if (paramsForm) {
    paramsForm.addEventListener('submit', async function(e) {
      e.preventDefault();

      const threshRaw = threshInput ? threshInput.value.trim() : '';
      const thresh = parseFloat(threshRaw);

      if (threshRaw === '' || isNaN(thresh) || thresh < 0.0 || thresh > 1.0) {
        if (threshInput) {
          threshInput.style.borderColor = '#d50000';
          threshInput.style.boxShadow = '0 0 0 1px #d50000';
          threshInput.focus();
        }
        showFeedback('error', 'Please enter a valid threshold value between 0.00 and 1.00 (e.g., 0.3, 0.5, 0.7, 0.9).');
        return;
      }

      if (threshInput) {
        threshInput.style.borderColor = '';
        threshInput.style.boxShadow = '';
      }

      const dataDateInput = document.getElementById('data-date-input') || paramsForm.querySelector('[name="data_date"]');
      const modeSelect = document.getElementById('mode-select') || paramsForm.querySelector('[name="mode"]');
      const dataDate = dataDateInput ? dataDateInput.value : undefined;
      const mode = modeSelect ? modeSelect.value : 'expected';

      if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Calculating...';
      }
      showFeedback('loading', `Recalculating project schedule, CPM, and risk bands for threshold ${thresh.toFixed(2)}...`);

      try {
        const res = await fetch('/api/recalculate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            threshold: thresh,
            data_date: dataDate,
            mode: mode
          })
        });

        const resData = await res.json();
        if (!res.ok || !resData.success) {
          throw new Error(resData.error || `Server returned error status ${res.status}`);
        }

        const cycle = resData.cycle;
        D = cycle;
        window.__CYCLE_DATA = cycle;

        // Update URL query params without reloading
        const url = new URL(window.location.href);
        url.searchParams.set('threshold', thresh.toString());
        if (dataDate) url.searchParams.set('data_date', dataDate);
        if (mode) url.searchParams.set('mode', mode);
        window.history.replaceState({}, '', url.toString());

        // Refresh DOM elements depending on active page
        if (page === 'dashboard') {
          renderDashboard(cycle);
        } else if (page === 'gantt' && window.__LOAD_GANTT) {
          window.__LOAD_GANTT(resData.gantt);
        } else if (page === 'progress') {
          renderProgressPage(cycle);
        } else if (page === 'resources') {
          renderResourcesPage(cycle);
        } else if (page === 'reports') {
          // Refresh all SVG report figures
          document.querySelectorAll('img.fig').forEach(img => {
            const baseSrc = img.src.split('?')[0];
            img.src = `${baseSrc}?threshold=${thresh}&t=${Date.now()}`;
          });
        } else if (page === 'predictions') {
          const predRows = cycle.activities.slice().sort((a, b) => (b.p_delay || 0) - (a.p_delay || 0));
          const tbody = document.querySelector('table tbody');
          if (tbody) {
            tbody.innerHTML = predRows.map(a => `
              <tr>
                <td>${a.activity_id}</td>
                <td>${a.name} ${a.critical ? '<span class="tag">critical</span>' : ''}</td>
                <td>${a.type}</td>
                <td class="num">${a.p_delay !== null ? Number(a.p_delay).toFixed(3) : '-'}</td>
                <td><span class="chip ${a.risk_band}">${a.risk_band}</span></td>
                <td class="num">${a.predicted_delay_days}</td>
                <td class="num">${a.injected_days}${a.injected_source === 'observed' ? ' (obs.)' : ''}</td>
                <td>${a.drivers || ''}</td>
              </tr>
            `).join('');
          }
        } else if (page === 'recommendations') {
          const tbody = document.querySelector('table tbody');
          if (tbody && cycle.recommendations) {
            tbody.innerHTML = cycle.recommendations.map(r => `
              <tr>
                <td class="num">${r.rank}</td>
                <td>${r.activity_id} ${r.activity_name}</td>
                <td>${r.status}</td>
                <td>${r.cause}</td>
                <td class="num">${r.shap_share !== null ? Math.round(r.shap_share * 100) + '%' : '–'}</td>
                <td>${r.action}</td>
                <td class="num">${r.recovery_days}</td>
                <td class="num">${Math.round(r.cost_impact_inr).toLocaleString()}</td>
                <td>${r.basis}</td>
                <td>${r.priority}</td>
              </tr>
            `).join('');
          }
        }

        const rb = cycle.analytics && cycle.analytics.risk_bands ? cycle.analytics.risk_bands : null;
        const bandText = rb
          ? ` (Risk bands: Crit ${rb.critical}, High ${rb.high}, Med ${rb.medium}, Low ${rb.low})`
          : '';

        showFeedback(
          'success',
          `✓ <b>Recalculated successfully for threshold ${thresh.toFixed(2)}</b>: <b>${cycle.kpis.at_risk_count}</b> activities at risk, <b>${cycle.kpis.adapted_activities}</b> adapted, schedule variance <b>${cycle.kpis.schedule_variance_wd > 0 ? '+' : ''}${cycle.kpis.schedule_variance_wd} wd</b>, forecast completion <b>${cycle.kpis.current_completion}</b>.${bandText}`
        );
      } catch (err) {
        console.error('[Recalculation error]', err);
        showFeedback('error', `Recalculation failed: ${err.message || 'Network error'}. Old results remain displayed.`);
      } finally {
        if (applyBtn) {
          applyBtn.disabled = false;
          applyBtn.textContent = 'Apply';
        }
      }
    });
  }
})();
