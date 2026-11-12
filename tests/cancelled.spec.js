// @ts-check
// Cancelled events ("Canceled" in the calendar title) stay on the volunteer
// page so people who don't read email still find out — marked Canceled, with
// no way to sign up, and left out of the open-visit counts.

const { test, expect } = require('@playwright/test');

const MOCK_SHIFTS = [
  { id: 'open', title: 'Farm Chores',                         category: 'Farm Chores',  date: '2099-01-02', start_time: '9:00am',  end_time: '11:00am', has_limit: true, capacity: 6, spots_left: 4, is_full: false, cancelled: false },
  { id: 'canc', title: 'CANCELED - Mobile Visit (Stress Relief)', category: 'Mobile Visit', date: '2099-01-03', start_time: '12:25pm', end_time: '1:25pm',  has_limit: true, capacity: 6, spots_left: 6, is_full: false, cancelled: true },
];

async function load(page, path) {
  await page.route('/api/shifts', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SHIFTS) })
  );
  await page.goto(path);
}

test('volunteer page: a cancelled event is shown, marked Canceled, and cannot be signed up for', async ({ page }) => {
  await load(page, '/');
  const card = page.locator('.scard', { hasText: 'Stress Relief' });
  await expect(card).toBeVisible();
  await expect(card.locator('.spots-pill.cancelled')).toHaveText('Canceled');
  await expect(card.getByText(/spots? left/)).toHaveCount(0);
  const btn = card.locator('.scard-btn');
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveText(/Canceled/);
  await btn.click({ force: true });
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  // The normal event next to it is unaffected.
  const open = page.locator('.scard', { hasText: 'Farm Chores' }).filter({ hasNot: page.locator('.spots-pill.cancelled') });
  await expect(open.locator('.scard-btn')).toBeEnabled();
  await expect(open.locator('.spots-pill')).toHaveText('4 spots left');
});

test('volunteer page: a cancelled event does not count as an open visit', async ({ page }) => {
  await load(page, '/');
  await expect(page.locator('.scard')).toHaveCount(2);
  await expect(page.locator('#filter-openings .chip-count')).toHaveText('1');
  await page.locator('#filter-openings').click();
  await expect(page.locator('.scard')).toHaveCount(1);
  await expect(page.locator('.scard', { hasText: 'Stress Relief' })).toHaveCount(0);
});

test('calendar page: a cancelled event is marked Canceled', async ({ page }) => {
  await load(page, '/calendar.html');
  await page.waitForSelector('.cal-row');
  await expect(page.locator('.cal-row.is-cancelled')).toHaveCount(1);
  await expect(page.locator('.cal-row.is-cancelled .spots-pill.cancelled')).toHaveText('Canceled');
});
