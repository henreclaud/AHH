// admin.js — runs on the admin page (admin.html).
// It lets you add new visits and see everyone who has signed up.

// Safety net: this page needs the running server. If opened as a file, explain.
if (location.protocol === 'file:') {
  document.body.innerHTML =
    '<div class="setup-notice">' +
    '<h2>Almost there! 🐾</h2>' +
    '<p>This page needs the app to be running. In your terminal run ' +
    '<code>npm start</code>, then open ' +
    '<code>http://localhost:3000/admin.html</code> in your browser.</p>' +
    '</div>';
  throw new Error('Opened via file:// — server not running.');
}

const addShiftForm = document.getElementById('add-shift-form');
const addError = document.getElementById('add-error');
const adminShifts = document.getElementById('admin-shifts');
const adminStatus = document.getElementById('admin-status');

// Load all shifts (with their signups) and show them.
async function loadAdminShifts() {
  adminStatus.textContent = 'Loading…';
  adminShifts.innerHTML = '';

  try {
    const response = await fetch('/api/admin/shifts');
    const shifts = await response.json();

    if (shifts.length === 0) {
      adminStatus.textContent = 'No visits yet. Add one above.';
      return;
    }

    adminStatus.textContent = '';
    shifts.forEach((shift) => {
      adminShifts.appendChild(createAdminShift(shift));
    });
  } catch (error) {
    adminStatus.textContent = 'Sorry, something went wrong loading the data.';
  }
}

// Build the block of HTML for one shift in the admin list.
function createAdminShift(shift) {
  const wrapper = document.createElement('div');
  wrapper.className = 'card admin-shift';

  // Header row: icon + shift info on the left, delete button on the right.
  const header = document.createElement('div');
  header.className = 'admin-shift-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'admin-shift-title';

  const icon = document.createElement('div');
  icon.className = 'shift-icon';
  icon.textContent = shift.icon || '🐾';
  titleWrap.appendChild(icon);

  const info = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = shift.title;
  info.appendChild(title);

  const meta = document.createElement('p');
  meta.className = 'shift-meta';
  meta.textContent =
    `${shift.date} · ${shift.start_time}–${shift.end_time} · ` +
    `${shift.signups.length} / ${shift.capacity} filled`;
  info.appendChild(meta);

  // Show the address as a clickable Google Maps link, if one was given.
  if (shift.location) {
    const loc = document.createElement('a');
    loc.className = 'shift-loc';
    loc.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(shift.location);
    loc.target = '_blank';
    loc.rel = 'noopener';
    loc.textContent = '📍 ' + shift.location;
    info.appendChild(loc);
  }

  titleWrap.appendChild(info);
  header.appendChild(titleWrap);

  const deleteButton = document.createElement('button');
  deleteButton.className = 'btn btn-danger';
  deleteButton.textContent = 'Delete';
  deleteButton.addEventListener('click', () => deleteShift(shift));
  header.appendChild(deleteButton);

  wrapper.appendChild(header);

  // List of people who signed up (or a note if there are none yet).
  if (shift.signups.length === 0) {
    const none = document.createElement('p');
    none.className = 'no-signups';
    none.textContent = 'No signups yet.';
    wrapper.appendChild(none);
  } else {
    const list = document.createElement('ul');
    list.className = 'signup-list';
    shift.signups.forEach((person) => {
      const item = document.createElement('li');
      // Name in normal text, email in muted text.
      item.appendChild(document.createTextNode(person.name + ' '));
      const emailSpan = document.createElement('span');
      emailSpan.textContent = `· ${person.email}`;
      item.appendChild(emailSpan);
      list.appendChild(item);
    });
    wrapper.appendChild(list);
  }

  return wrapper;
}

// Send the new-shift form to the server.
addShiftForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  addError.textContent = '';

  // Collect the values the admin typed into the form.
  const newShift = {
    title: document.getElementById('title').value.trim(),
    icon: document.getElementById('icon').value.trim(),
    category: document.getElementById('category').value.trim(),
    location: document.getElementById('location').value.trim(),
    date: document.getElementById('date').value,
    start_time: document.getElementById('start_time').value,
    end_time: document.getElementById('end_time').value,
    capacity: Number(document.getElementById('capacity').value),
  };

  try {
    const response = await fetch('/api/shifts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newShift),
    });

    const data = await response.json();

    if (!response.ok) {
      addError.textContent = data.error || 'Something went wrong.';
      return;
    }

    // Success: clear the form and reload the list.
    addShiftForm.reset();
    document.getElementById('capacity').value = 1;
    await loadAdminShifts();
  } catch (error) {
    addError.textContent = 'Sorry, something went wrong. Please try again.';
  }
});

// Delete a shift after asking for confirmation.
async function deleteShift(shift) {
  const ok = confirm(`Delete "${shift.title}"? This also removes its signups.`);
  if (!ok) return;

  try {
    const response = await fetch(`/api/shifts/${shift.id}`, { method: 'DELETE' });
    if (!response.ok) {
      alert('Sorry, could not delete that shift.');
      return;
    }
    await loadAdminShifts();
  } catch (error) {
    alert('Sorry, something went wrong.');
  }
}

// Load everything when the page opens.
loadAdminShifts();
