// report.js — staff attendance report page

if (location.protocol === 'file:') {
  document.body.innerHTML =
    '<div class="setup-notice"><h2>Almost there!</h2>' +
    '<p>Run <code>npm start</code> then open <code>http://localhost:3000/report.html</code>.</p></div>';
  throw new Error('file:// not supported');
}

// ── Auth ──────────────────────────────────────────────────────────────────────
const authGate    = document.getElementById('auth-gate');
const reportMain  = document.getElementById('report-main');
const loginForm   = document.getElementById('login-form');
const loginError  = document.getElementById('login-error');
let sessionToken  = '';

function showGate(msg) {
  authGate.hidden   = false;
  reportMain.hidden = true;
  if (msg) loginError.textContent = msg;
}

function showReport() {
  authGate.hidden   = true;
  reportMain.hidden = false;
  init();
}

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  const submitBtn = loginForm.querySelector('[type=submit]');
  const password  = document.getElementById('staff-password').value;
  loginError.textContent   = '';
  submitBtn.disabled       = true;
  submitBtn.textContent    = 'Signing in…';

  const wakeMsg = setTimeout(() => {
    if (submitBtn.disabled)
      loginError.textContent = 'Server is waking up — this takes up to a minute on the free plan. Almost there…';
  }, 6000);

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 70000);

  try {
    const res  = await fetch('/api/staff/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password }),
      signal:  controller.signal,
    });
    const data = await res.json();
    clearTimeout(wakeMsg);
    clearTimeout(timeout);
    if (!res.ok) {
      loginError.textContent = data.error || 'Login failed.';
      submitBtn.disabled     = false;
      submitBtn.textContent  = 'Sign in';
      return;
    }
    sessionToken = data.token;
    showReport();
  } catch (err) {
    clearTimeout(wakeMsg);
    clearTimeout(timeout);
    loginError.textContent = err.name === 'AbortError'
      ? 'Server took too long to respond. Please try again.'
      : 'Could not connect to the server.';
    submitBtn.disabled    = false;
    submitBtn.textContent = 'Sign in';
  }
});

// ── Report ────────────────────────────────────────────────────────────────────
const reportContent = document.getElementById('report-content');
const reportStatus  = document.getElementById('report-status');
const loadBtn       = document.getElementById('load-btn');
const dateInput     = document.getElementById('report-date');

function todayLocal() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function init() {
  dateInput.value = todayLocal();
  loadReport();
}

loadBtn.addEventListener('click', loadReport);
dateInput.addEventListener('change', loadReport);

async function loadReport() {
  const date = dateInput.value;
  if (!date) return;

  reportContent.innerHTML = '';
  reportStatus.textContent = 'Loading…';
  reportContent.appendChild(reportStatus);

  try {
    const res = await fetch(`/api/staff/report?date=${date}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (res.status === 401) { showGate('Session expired. Please log in again.'); return; }
    const shifts = await res.json();

    reportStatus.textContent = '';

    if (!shifts.length) {
      reportStatus.textContent = 'No signups found for this date.';
      return;
    }

    shifts.forEach(shift => renderShift(shift, date));
  } catch {
    reportStatus.textContent = 'Could not load report. Please try again.';
  }
}

function renderShift(shift, date) {
  const section = document.createElement('div');
  section.className = 'report-shift';

  const heading = document.createElement('h2');
  heading.className = 'report-shift-title';
  heading.textContent = `${shift.shift_name}  ·  ${shift.shift_time}`;
  section.appendChild(heading);

  const table = document.createElement('div');
  table.className = 'report-table';
  shift.signups.forEach(vol => table.appendChild(renderVolRow(vol)));
  section.appendChild(table);

  // Per-shift notes
  const notesWrap = document.createElement('div');
  notesWrap.className = 'report-notes-wrap';

  const notesLabel = document.createElement('label');
  notesLabel.className = 'report-notes-label';
  notesLabel.textContent = 'Shift notes';
  notesWrap.appendChild(notesLabel);

  const textarea = document.createElement('textarea');
  textarea.className   = 'report-notes-textarea';
  textarea.placeholder = 'Record anything notable about this shift…';
  textarea.rows        = 3;
  notesWrap.appendChild(textarea);

  const saveBtn = document.createElement('button');
  saveBtn.className   = 'btn btn-secondary';
  saveBtn.textContent = 'Save note';
  saveBtn.addEventListener('click', async () => {
    const note = textarea.value.trim();
    if (!note) return;
    saveBtn.disabled     = true;
    saveBtn.textContent  = 'Saving…';
    try {
      const res = await fetch('/api/staff/report/note', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ date, shiftName: shift.shift_name, shiftTime: shift.shift_time, note }),
      });
      saveBtn.textContent = res.ok ? 'Saved ✓' : 'Error — try again';
      saveBtn.disabled    = false;
    } catch {
      saveBtn.textContent = 'Error — try again';
      saveBtn.disabled    = false;
    }
  });
  notesWrap.appendChild(saveBtn);

  section.appendChild(notesWrap);
  reportContent.appendChild(section);
}

function renderVolRow(vol) {
  const row = document.createElement('div');
  row.className = 'report-vol-row';

  const info = document.createElement('div');
  info.className = 'report-vol-info';
  info.innerHTML =
    `<span class="report-vol-name">${escapeHtml(vol.name)}</span>` +
    `<span class="report-vol-email">${escapeHtml(vol.email)}</span>`;
  row.appendChild(info);

  const statusEl = document.createElement('span');
  setStatus(statusEl, vol.attendance, vol.hours_logged);
  row.appendChild(statusEl);

  const actions = document.createElement('div');
  actions.className = 'report-vol-actions';

  ['Attended', 'No-show'].forEach(s => {
    const btn = document.createElement('button');
    btn.className   = 'btn ' + (s === 'Attended' ? 'btn-att-yes' : 'btn-att-no');
    btn.textContent = s === 'Attended' ? '✓ Attended' : '✕ No-show';
    if (vol.attendance === s) btn.classList.add('active');

    btn.addEventListener('click', async () => {
      if (btn.classList.contains('active')) return;
      actions.querySelectorAll('button').forEach(b => b.disabled = true);
      try {
        const res  = await fetch('/api/staff/report/attendance', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ signupId: vol.signup_id, status: s }),
        });
        const data = await res.json();
        if (res.ok) {
          vol.attendance   = s;
          vol.hours_logged = data.hours != null ? data.hours.toFixed(2) : '';
          setStatus(statusEl, s, vol.hours_logged);
          actions.querySelectorAll('button').forEach(b => {
            b.disabled = false;
            b.classList.remove('active');
          });
          btn.classList.add('active');
        } else {
          alert(data.error || 'Could not save attendance.');
          actions.querySelectorAll('button').forEach(b => b.disabled = false);
        }
      } catch {
        alert('Could not save attendance. Please try again.');
        actions.querySelectorAll('button').forEach(b => b.disabled = false);
      }
    });
    actions.appendChild(btn);
  });

  row.appendChild(actions);
  return row;
}

function setStatus(el, attendance, hours) {
  if (attendance === 'Attended') {
    el.textContent = hours ? `✅ ${hours}h` : '✅ Attended';
    el.className   = 'report-vol-status att-attended';
  } else if (attendance === 'No-show') {
    el.textContent = '❌ No-show';
    el.className   = 'report-vol-status att-noshow';
  } else {
    el.textContent = '⏳ Pending';
    el.className   = 'report-vol-status att-pending';
  }
}

function escapeHtml(t) {
  const el = document.createElement('div');
  el.textContent = t ?? '';
  return el.innerHTML;
}
