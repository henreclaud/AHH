// cancel.js — handles the Cancel Signup page (cancel.html).

if (location.protocol === 'file:') {
  document.body.innerHTML =
    '<div class="setup-notice">' +
    '<h2>Almost there!</h2>' +
    '<p>Run <code>npm start</code> in your terminal, then open ' +
    '<code>http://localhost:3000/cancel.html</code> in your browser.</p>' +
    '</div>';
  throw new Error('Opened via file:// — server not running.');
}

const form       = document.getElementById('cancel-form');
const nameInput  = document.getElementById('cancel-name');
const emailInput = document.getElementById('cancel-email');
const dateInput  = document.getElementById('cancel-date');
const timeInput  = document.getElementById('cancel-time');
const errorEl    = document.getElementById('cancel-error');
const successEl  = document.getElementById('cancel-success');
const submitBtn  = document.getElementById('cancel-submit');

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  successEl.hidden = true;
}

function showSuccess(msg) {
  successEl.textContent = msg;
  successEl.hidden = false;
  errorEl.hidden = true;
  form.reset();
  submitBtn.disabled = false;
  submitBtn.textContent = 'Cancel my signup';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  successEl.hidden = true;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Searching…';

  const payload = {
    name:      nameInput.value.trim(),
    email:     emailInput.value.trim(),
    date:      dateInput.value,          // "YYYY-MM-DD"
    startTime: timeInput.value.trim(),   // "9am", "3pm", "10:30am", etc.
  };

  try {
    const res  = await fetch('/api/signups/cancel', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Something went wrong. Please try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Cancel my signup';
    } else {
      showSuccess(data.message);
    }
  } catch {
    showError('Network error — please check your connection and try again.');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Cancel my signup';
  }
});
