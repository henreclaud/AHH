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

const form      = document.getElementById('cancel-form');
const codeInput = document.getElementById('cancel-code');
const errorEl   = document.getElementById('cancel-error');
const successEl = document.getElementById('cancel-success');
const submitBtn = document.getElementById('cancel-submit');

// Force uppercase as the user types.
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase();
});

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

  const signupId = codeInput.value.trim().toUpperCase();

  try {
    const res  = await fetch('/api/signups/cancel', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ signupId }),
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
