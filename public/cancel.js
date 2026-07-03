// cancel.js — volunteer self-cancellation page (cancel.html).
// Step 1: enter email → Step 2: pick shift → confirm dialog → Step 3: done.

if (location.protocol === 'file:') {
  document.body.innerHTML =
    '<div class="setup-notice">' +
    '<h2>Almost there!</h2>' +
    '<p>Run <code>npm start</code> in your terminal, then open ' +
    '<code>http://localhost:3000/cancel</code> in your browser.</p>' +
    '</div>';
  throw new Error('Opened via file:// — server not running.');
}

const stepEmail  = document.getElementById('step-email');
const stepList   = document.getElementById('step-list');
const stepNone   = document.getElementById('step-none');
const stepDone   = document.getElementById('step-done');

const emailForm   = document.getElementById('email-form');
const emailInput  = document.getElementById('email-input');
const emailSubmit = document.getElementById('email-submit');
const emailError  = document.getElementById('email-error');

const signupList = document.getElementById('signup-list');
const listError  = document.getElementById('list-error');
const doneMsg    = document.getElementById('done-msg');

const dialog     = document.getElementById('confirm-dialog');
const confirmMsg = document.getElementById('confirm-msg');
const confirmYes = document.getElementById('confirm-yes');
const confirmNo  = document.getElementById('confirm-no');

function showStep(name) {
  [stepEmail, stepList, stepNone, stepDone].forEach(el => el.hidden = true);
  document.getElementById(`step-${name}`).hidden = false;
}

function goBack() {
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
  emailSubmit.textContent = 'Searching…';

  try {
    const res  = await fetch(`/api/signups?email=${encodeURIComponent(email)}`);
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

    buildList(data);
    showStep('list');

  } catch {
    emailError.textContent = 'Could not connect. Please try again.';
    emailError.hidden = false;
  } finally {
    emailSubmit.disabled = false;
    emailSubmit.textContent = 'Find my signups';
  }
});

// ── Step 2: signup list ───────────────────────────────────────────────────────

function buildList(signups) {
  signupList.innerHTML = '';
  listError.hidden = true;

  signups.forEach(signup => {
    const card = document.createElement('div');
    card.className = 'cancel-signup-card card';

    const info = document.createElement('div');
    info.className = 'cancel-signup-info';
    info.innerHTML = `
      <p class="cancel-signup-name">${escapeHtml(signup.name)}</p>
      <p class="cancel-signup-when">${escapeHtml(signup.shift_name)} on ${escapeHtml(formatDate(signup.shift_date))} at ${escapeHtml(signup.shift_time)}</p>
    `;

    // Email-the-staff button — opens a pre-addressed email to whoever is
    // running this visit (from the calendar guest list), so volunteers can
    // report a change or delay. Mirrors the staff page's "Notify volunteers".
    const contacts = signup.staff_contacts || [];
    if (contacts.length) {
      const emails  = contacts.map(c => c.email).join(',');
      const names   = contacts.map(c => c.name.split(/\s+/)[0]).join(' & ');
      const subject = `Change/delay for my signup: ${signup.shift_name} on ${formatDate(signup.shift_date)}`;
      const mail = document.createElement('a');
      mail.className   = 'btn btn-secondary cancel-notify-btn';
      mail.href        = `mailto:${emails}?subject=${encodeURIComponent(subject)}`;
      mail.textContent = `✉️ Email ${names} about a change or delay`;
      info.appendChild(mail);
    }

    const btn = document.createElement('button');
    btn.className   = 'btn btn-danger cancel-signup-btn';
    btn.textContent = 'Cancel';
    btn.addEventListener('click', () => askConfirm(signup, btn));

    card.appendChild(info);
    card.appendChild(btn);
    signupList.appendChild(card);
  });
}

// ── Confirmation dialog ───────────────────────────────────────────────────────

let pendingSignup = null;

function askConfirm(signup, triggerBtn) {
  pendingSignup = signup;
  confirmMsg.textContent =
    `Are you sure you want to cancel ${signup.name}'s signup for ${signup.shift_name} on ${formatDate(signup.shift_date)} at ${signup.shift_time}?`;
  dialog.showModal();
}

confirmNo.addEventListener('click', () => {
  dialog.close();
  pendingSignup = null;
});

dialog.addEventListener('cancel', () => { pendingSignup = null; }); // Esc key

confirmYes.addEventListener('click', async () => {
  if (!pendingSignup) return;
  const signup = pendingSignup;

  confirmYes.disabled = true;
  confirmYes.textContent = 'Cancelling…';
  confirmNo.disabled  = true;
  listError.hidden = true;

  try {
    const res  = await fetch('/api/signups/cancel', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ signupId: signup.signup_id }),
    });
    const data = await res.json();

    dialog.close();

    if (!res.ok) {
      listError.textContent = data.error || 'Something went wrong. Please try again.';
      listError.hidden = false;
    } else {
      doneMsg.textContent =
        `${signup.name}'s signup for ${signup.shift_name} on ${formatDate(signup.shift_date)} has been cancelled.`;
      showStep('done');
    }
  } catch {
    dialog.close();
    listError.textContent = 'Could not connect. Please try again.';
    listError.hidden = false;
  } finally {
    confirmYes.disabled = false;
    confirmYes.textContent = 'Yes, cancel it';
    confirmNo.disabled  = false;
    pendingSignup = null;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function escapeHtml(t) {
  const el = document.createElement('div');
  el.textContent = t ?? '';
  return el.innerHTML;
}

showStep('email');
emailInput.focus();
