// checkout.js — volunteer self-check-out page (checkout.html).
// Step 1: enter name + email → Step 2: confirm shift → Step 3: success with hours.

const stepEmail   = document.getElementById('step-email');
const stepShifts  = document.getElementById('step-shifts');
const stepNone    = document.getElementById('step-none');
const stepSuccess = document.getElementById('step-success');

const emailForm   = document.getElementById('email-form');
const nameInput   = document.getElementById('name-input');
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
  emailError.hidden = true;
  showStep('email');
  nameInput.focus();
}

// ── Step 1: look up name + email ──────────────────────────────────────────────

emailForm.addEventListener('submit', async e => {
  e.preventDefault();
  const name  = nameInput.value.trim();
  const email = emailInput.value.trim();
  if (!name || !email) return;

  emailError.hidden = true;
  emailSubmit.disabled = true;
  emailSubmit.textContent = 'Looking up…';

  try {
    const res  = await fetch(`/api/checkout?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`);
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

    buildShiftList(data);
    shiftsSub.textContent = data.length === 1
      ? 'Tap the button to log your hours for this shift.'
      : 'You have multiple active shifts — pick the one you are checking out of.';
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

function buildShiftList(signups) {
  shiftList.innerHTML = '';
  shiftsError.hidden  = true;

  signups.forEach(signup => {
    const card = document.createElement('div');
    card.className = 'checkin-shift-card card';

    card.innerHTML = `
      <p class="checkin-shift-name">${escapeHtml(signup.shift_name)}</p>
      <p class="checkin-shift-time">${escapeHtml(signup.shift_time)}</p>
      ${signup.checkin_time ? `<p class="checkin-already">🕐 Checked in: ${escapeHtml(signup.checkin_time)}</p>` : ''}
    `;

    const btn = document.createElement('button');
    btn.className   = 'btn btn-primary btn-full checkin-confirm-btn';
    btn.textContent = 'Check out of this shift';
    btn.addEventListener('click', () => confirmCheckout(signup, btn));
    card.appendChild(btn);

    shiftList.appendChild(card);
  });
}

// ── Step 3: confirm check-out ─────────────────────────────────────────────────

async function confirmCheckout(signup, btn) {
  btn.disabled    = true;
  btn.textContent = 'Checking out…';
  shiftsError.hidden = true;

  try {
    const res  = await fetch('/api/checkout', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ signupId: signup.signup_id }),
    });
    const data = await res.json();

    if (!res.ok) {
      shiftsError.textContent = data.error || 'Something went wrong. Please try again.';
      shiftsError.hidden = false;
      btn.disabled    = false;
      btn.textContent = 'Check out of this shift';
      return;
    }

    const hoursText = data.hours != null ? ` You logged ${data.hours} hour${data.hours === 1 ? '' : 's'}.` : '';
    successMsg.textContent =
      `Checked out of: ${signup.shift_name} · ${signup.shift_time}.${hoursText}`;
    showStep('success');

  } catch {
    shiftsError.textContent = 'Could not connect. Please try again.';
    shiftsError.hidden = false;
    btn.disabled    = false;
    btn.textContent = 'Check out of this shift';
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
nameInput.focus();
