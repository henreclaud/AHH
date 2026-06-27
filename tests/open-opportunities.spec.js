// @ts-check
// Tests for the "Open Opportunities" filter chip.
//
// Rule: a shift should be HIDDEN when it has a defined limit AND is completely full.
// All other shifts (spots remaining, or no limit at all) must remain visible.

const { test, expect } = require('@playwright/test');

const FUTURE_DATE = '2099-12-31'; // far future so date filters never exclude these

const TEST_SHIFTS = [
  {
    id: 'shift-partial',
    title: 'Partially Full Shift',       // has limit, 10/25 taken → open
    date: FUTURE_DATE,
    start_time: '9:00am',
    end_time: '11:00am',
    category: 'Farm Chores',
    description: 'Limit 25 volunteers',
    location: '',
    capacity: 25,
    has_limit: true,
    spots_left: 15,
    taken: 10,
    is_full: false,
    is_farm: true,
  },
  {
    id: 'shift-full',
    title: 'Completely Full Shift',       // has limit, 25/25 taken → should be hidden
    date: FUTURE_DATE,
    start_time: '10:00am',
    end_time: '12:00pm',
    category: 'Farm Chores',
    description: 'Limit 25 volunteers',
    location: '',
    capacity: 25,
    has_limit: true,
    spots_left: 0,
    taken: 25,
    is_full: true,
    is_farm: true,
  },
  {
    id: 'shift-unlimited',
    title: 'Unlimited Shift',             // no limit → always open
    date: FUTURE_DATE,
    start_time: '1:00pm',
    end_time: '3:00pm',
    category: 'Open Hours',
    description: '',
    location: '',
    capacity: 999999,
    has_limit: false,
    spots_left: 999999,
    taken: 0,
    is_full: false,
    is_farm: true,
  },
];

async function loadWithMockShifts(page) {
  await page.route('/api/shifts', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TEST_SHIFTS),
    })
  );
  await page.goto('/');
  // Wait for shifts to render
  await page.waitForSelector('.scard-title');
}

async function clickOpenOpportunities(page) {
  await page.getByRole('button', { name: /open opportunities/i }).click();
}

// ── Test 1: shift with spots remaining appears in Open Opportunities ──────────
test('shift with spots remaining appears when Open Opportunities is active', async ({ page }) => {
  await loadWithMockShifts(page);

  // Shift should already be visible before filtering
  await expect(page.getByText('Partially Full Shift')).toBeVisible();

  await clickOpenOpportunities(page);

  // Still visible after filtering — it has spots left
  await expect(page.getByText('Partially Full Shift')).toBeVisible();
});

// ── Test 2: completely full shift is hidden by Open Opportunities ─────────────
test('completely full shift is hidden when Open Opportunities is active', async ({ page }) => {
  await loadWithMockShifts(page);

  // Visible before filtering
  await expect(page.getByText('Completely Full Shift')).toBeVisible();

  await clickOpenOpportunities(page);

  // Hidden after filtering — it's full
  await expect(page.getByText('Completely Full Shift')).not.toBeVisible();
});

// ── Test 3: unlimited shift (no limit) appears in Open Opportunities ──────────
test('shift with no limit appears when Open Opportunities is active', async ({ page }) => {
  await loadWithMockShifts(page);

  await expect(page.getByText('Unlimited Shift')).toBeVisible();

  await clickOpenOpportunities(page);

  // Still visible — unlimited shifts are always open
  await expect(page.getByText('Unlimited Shift')).toBeVisible();
});
