// checkin.js — volunteer self-check-in page (checkin.html).
// Step 1: enter email → Step 2: confirm shift → Step 3: success.

const stepEmail  = document.getElementById('step-email');
const stepShifts = document.getElementById('step-shifts');
const stepNone   = document.getElementById('step-none');
const stepSuccess = document.getElementById('step-success');

const emailForm   = document.getElementById('email-form');
const emailInput  = document.getElementById('email-input');
const emailSubmit = document.getElementById('email-submit');
const emailError  = document.getElementById('email-error');

const shiftList   = document.getElementById('shift-list');
const shiftsSub   = document.getElementById('shifts-sub');
const shiftsError = document.getElementById('shifts-error');
const successMsg  = document.getElementById('success-msg');

function showStep(name) {
  [stepEmail, stepShifts, stepNone, stepSuccess].forEach(el => el.hidden = true);
  document.getElementById(`step-${name}`).hidden = false;
}

function goBack() {
  emailInput.value = '';
  emailError.hidden = true;
  showStep('email');
  emailInput.focus();
}

// ── Step 1: look up email ─────────────────────────────────────────────────────

emailForm.addEventListener('submit', async e => {
  e.preventDefault();
  const email = emailInput.value.trim();
  if (!email) return;

  emailError.hidden = true;
  emailSubmit.disabled = true;
  emailSubmit.textContent = 'Looking up…';

  try {
    const res  = await fetch(`/api/checkin?email=${encodeURIComponent(email)}`);
    const data = await res.json();

    if (!res.ok) {
      emailError.textContent = data.error || 'Something went wrong. Please try again.';
      emailError.hidden = false;
      return;
    }

    if (!data.length) {
      showStep('none');
      return;
    }

    buildShiftList(data, email);
    shiftsSub.textContent = data.length === 1
      ? 'Please confirm you\'re here for this shift.'
      : 'You have multiple shifts today — pick the one you\'re checking into.';
    showStep('shifts');

  } catch {
    emailError.textContent = 'Could not connect. Please try again.';
    emailError.hidden = false;
  } finally {
    emailSubmit.disabled = false;
    emailSubmit.textContent = 'Find my shift';
  }
});

// ── Step 2: shift list ────────────────────────────────────────────────────────

function buildShiftList(signups, email) {
  shiftList.innerHTML = '';
  shiftsError.hidden  = true;

  signups.forEach(signup => {
    const card = document.createElement('div');
    card.className = 'checkin-shift-card card';

    // Already checked in?
    const alreadyIn = signup.attendance === 'Attended';

    card.innerHTML = `
      <p class="checkin-shift-name">${escapeHtml(signup.shift_name)}</p>
      <p class="checkin-shift-time">${escapeHtml(signup.shift_time)}</p>
      ${alreadyIn ? '<p class="checkin-already">✅ Already checked in</p>' : ''}
    `;

    if (!alreadyIn) {
      const btn = document.createElement('button');
      btn.className   = 'btn btn-primary btn-full checkin-confirm-btn';
      btn.textContent = 'Yes, I\'m here for this shift';
      btn.addEventListener('click', () => confirmCheckin(signup, btn));
      card.appendChild(btn);
    }

    shiftList.appendChild(card);
  });
}

// ── Step 3: confirm check-in ──────────────────────────────────────────────────

async function confirmCheckin(signup, btn) {
  btn.disabled    = true;
  btn.textContent = 'Checking in…';
  shiftsError.hidden = true;

  try {
    const res  = await fetch('/api/checkin', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ signupId: signup.signup_id }),
    });
    const data = await res.json();

    if (!res.ok) {
      shiftsError.textContent = data.error || 'Something went wrong. Please try again.';
      shiftsError.hidden = false;
      btn.disabled    = false;
      btn.textContent = 'Yes, I\'m here for this shift';
      return;
    }

    successMsg.textContent = `Checked in for: ${signup.shift_name} · ${signup.shift_time}`;
    showStep('success');

  } catch {
    shiftsError.textContent = 'Could not connect. Please try again.';
    shiftsError.hidden = false;
    btn.disabled    = false;
    btn.textContent = 'Yes, I\'m here for this shift';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(t) {
  const el = document.createElement('div');
  el.textContent = t ?? '';
  return el.innerHTML;
}

// Start on the email step.
showStep('email');
emailInput.focus();
