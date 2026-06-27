// @ts-check
// Tests for the read-only Calendar page (calendar.html):
//  - reachable from a "Calendar" link in the main nav
//  - shows a cleaned activity label (e.g. "Feeding"), not the volunteer's name
//  - hides "Not Available" blocker entries
//  - is view-only: no Sign up buttons

const { test, expect } = require('@playwright/test');

const MOCK_SHIFTS = [
  { id: 'a', title: 'Alyssa - Feeding',            category: 'Visit',       date: '2099-01-02', start_time: '9:00am',  end_time: '11:00am', has_limit: false, is_full: false, capacity: 999999 },
  { id: 'b', title: 'Jasmine -Feeding Farm Chores', category: 'Farm Chores', date: '2099-01-02', start_time: '1:00pm',  end_time: '3:00pm',  has_limit: false, is_full: false, capacity: 999999 },
  { id: 'c', title: 'Eric Not Available 6/21-6/27', category: 'Visit',       date: '2099-01-03', start_time: '12:00am', end_time: '11:59pm', has_limit: false, is_full: false, capacity: 999999 },
  { id: 'd', title: 'Hailey Feeding',               category: 'Visit',       date: '2099-01-04', start_time: '8:00am',  end_time: '9:00am',  has_limit: false, is_full: false, capacity: 999999 },
];

async function loadCalendar(page) {
  await page.route('/api/shifts', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SHIFTS) })
  );
  await page.goto('/calendar.html');
  await page.waitForSelector('.cal-row');
}

test('the homepage nav has a Calendar link pointing to calendar.html', async ({ page }) => {
  await page.goto('/');
  const link = page.getByRole('link', { name: /^calendar$/i });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', /calendar\.html/);
});

test('calendar shows cleaned activity labels, not volunteer names', async ({ page }) => {
  await loadCalendar(page);

  // "Alyssa - Feeding" should display as just "Feeding"
  await expect(page.locator('.cal-activity', { hasText: /^Feeding$/ }).first()).toBeVisible();
  // The volunteer's name must not appear anywhere
  await expect(page.getByText('Alyssa')).toHaveCount(0);
  await expect(page.getByText('Hailey')).toHaveCount(0);
  // A shift with two activities shows both
  await expect(page.getByText(/Feeding\s*&\s*Farm Chores/)).toBeVisible();
});

test('calendar hides "Not Available" blocker entries', async ({ page }) => {
  await loadCalendar(page);
  await expect(page.getByText(/not available/i)).toHaveCount(0);
  await expect(page.getByText('Eric')).toHaveCount(0);
});

test('calendar is view-only — no Sign up buttons', async ({ page }) => {
  await loadCalendar(page);
  await expect(page.getByRole('button', { name: /sign up/i })).toHaveCount(0);
});
