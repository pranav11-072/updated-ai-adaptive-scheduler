(function() {
  const RISK = { low: '#43a047', medium: '#ffb300', high: '#fb8c00', critical: '#e53935' };
  const NS = 'http://www.w3.org/2000/svg';
  const dataEl = document.getElementById('cycle-data');
  const D = dataEl ? JSON.parse(dataEl.textContent) : null;
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
        <span style="width:90px;font-size:12px;color:var(--ink);text-overflow:ellipsis;overflow:hidden;white-space:nowrap" title="${i.label}">${i.label}</span>
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

  // --- PAGE SPECIFIC INITIALIZATION ---

  if (D && page === 'dashboard') {
    // 1. Activity Status Distribution
    const statusHost = document.getElementById('status-dist');
    if (statusHost) {
      if (D.analytics && D.analytics.status_distribution) {
        const st = D.analytics.status_distribution;
        bars(statusHost, [
          { label: 'Completed', value: st.completed, color: '#2e7d32' },
          { label: 'In Progress', value: st.in_progress, color: '#1976d2' },
          { label: 'Not Started', value: st.not_started, color: '#90a4ae' },
          { label: 'Critical Path', value: st.critical, color: '#d50000' },
          { label: 'Near Critical', value: st.near_critical, color: '#f57c00' },
          { label: 'Delayed Tasks', value: st.delayed, color: '#7b1fa2' }
        ]);
      } else {
        // Fallback aggregation
        let comp = 0, inprog = 0, notstart = 0, crit = 0, del = 0;
        D.activities.forEach(a => {
          if (a.percent_complete >= 100) comp++;
          else if (a.percent_complete > 0) inprog++;
          else notstart++;
          if (a.critical) crit++;
          if (a.injected_days > 0 || a.actual_delay_days > 0) del++;
        });
        bars(statusHost, [
          { label: 'Completed', value: comp, color: '#2e7d32' },
          { label: 'In Progress', value: inprog, color: '#1976d2' },
          { label: 'Not Started', value: notstart, color: '#90a4ae' },
          { label: 'Critical Path', value: crit, color: '#d50000' },
          { label: 'Delayed Tasks', value: del, color: '#7b1fa2' }
        ]);
      }
    }

    // 2. Risk Distribution
    const riskHost = document.getElementById('risk-dist');
    if (riskHost) {
      const c = { low: 0, medium: 0, high: 0, critical: 0 };
      if (D.analytics && D.analytics.risk_distribution) {
        Object.assign(c, D.analytics.risk_distribution);
      } else {
        D.activities.forEach(a => {
          if (a.risk_band && c[a.risk_band] !== undefined) c[a.risk_band]++;
        });
      }
      bars(riskHost, Object.keys(c).map(k => ({ label: k.toUpperCase(), value: c[k], color: RISK[k] })));
    }

    // 3. Floor-wise Distribution
    const floorHost = document.getElementById('floor-dist');
    if (floorHost) {
      const flData = (D.analytics && D.analytics.floor_analytics && D.analytics.floor_analytics.length > 0)
        ? D.analytics.floor_analytics.map(f => ({
            label: f.floor,
            tasks: f.total_activities,
            critical: f.critical_activities,
            planned: f.planned_pct,
            actual: f.actual_pct
          }))
        : (D.progress && D.progress.floor_progress)
        ? D.progress.floor_progress.map(f => ({
            label: f.floor,
            tasks: f.total_activities,
            critical: f.critical_activities,
            planned: f.planned_pct,
            actual: f.actual_pct
          }))
        : [];
      dualBars(floorHost, flData);
    }
  }

  if (D && page === 'progress') {
    const sc = D.progress ? D.progress.s_curve : [];
    const host = document.getElementById('scurve');
    if (host && sc.length > 0) {
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
            x: D.progress.elapsed_working_days,
            y: D.progress.actual_pct,
            color: '#d50000',
            label: `Actual ${D.progress.actual_pct.toFixed(1)}%`
          }
        ],
        vline: D.progress.elapsed_working_days
      });
    }
  }

  if (D && page === 'resources') {
    const host = document.getElementById('demand');
    if (host && D.resources && D.resources.summary) {
      D.resources.summary.forEach(r => {
        if (r.peak_demand > 0 && D.resources.demand[r.resource]) {
          const d = document.createElement('div');
          d.className = 'card';
          host.appendChild(d);
          demand(d, D.resources.demand[r.resource], r.available, `${r.resource} - ${r.name}`);
        }
      });
    }
  }

  if (page === 'gantt') {
    const q = location.search;
    fetch('/api/gantt' + q)
      .then(r => r.json())
      .then(G => {
        const wrap = document.getElementById('gantt');
        const tip = document.getElementById('tip');
        if (!wrap) return;

        const st = { ppd: 4, filter: 'all', floor: 'all', base: true, text: '' };
        const zoomEl = document.getElementById('zoom');
        if (zoomEl) zoomEl.oninput = e => { st.ppd = +e.target.value; draw(); };
        const filterEl = document.getElementById('filter');
        if (filterEl) filterEl.onchange = e => { st.filter = e.target.value; draw(); };
        const floorEl = document.getElementById('floor-select');
        if (floorEl) floorEl.onchange = e => { st.floor = e.target.value; draw(); };
        const baseEl = document.getElementById('base');
        if (baseEl) baseEl.onchange = e => { st.base = e.target.checked; draw(); };
        const findEl = document.getElementById('find');
        if (findEl) findEl.oninput = e => { st.text = e.target.value.toLowerCase(); draw(); };

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

        function draw() {
          const acts = G.activities.filter(ok).sort((a, b) => a.current_es - b.current_es || a.activity_id.localeCompare(b.activity_id));
          const ppd = st.ppd;
          const W = Math.max(600, (G.horizon + 6) * ppd);
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
          (G.offset_dates || []).forEach((d, k) => {
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
                // Milestone diamond
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
              // Milestone diamond
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
            x1: G.data_date_offset * ppd,
            x2: G.data_date_offset * ppd,
            y1: 0,
            y2: H,
            stroke: '#1d4e89',
            'stroke-dasharray': '4 3',
            'stroke-width': 1.6
          }, svg);

          const countEl = document.getElementById('count');
          if (countEl) countEl.textContent = `${acts.length} of ${G.activities.length} activities shown`;
        }

        draw();
      });
  }
})();
