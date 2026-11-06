import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as path from 'node:path';

test('Full E2E Developer Cloud Platform Journey + Create Share + Mobile Drawer + Accessibility @screenshots', async ({
  page,
}) => {
  const screenshotDir = path.resolve(process.cwd(), 'e2e', 'screenshots');
  const uniqueEmail = `e2e-${Date.now()}@customer.com`;
  const consoleErrors: string[] = [];

  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'LocalShare Cloud' })).toBeVisible();

  // Accessibility check on Login page
  const loginA11y = await new AxeBuilder({ page }).analyze();
  expect(loginA11y.violations.filter((v) => v.impact === 'critical')).toEqual([]);

  // Switch to Register and create an account
  await page.getByRole('button', { name: /Need an account\? Register/i }).click();
  await page.getByLabel('Full Name').fill('Grace Hopper');
  await page.getByLabel('Email Address').fill(uniqueEmail);
  await page.getByLabel(/Password/i).fill('grace-hopper-strong-pass');
  await page.getByRole('button', { name: 'Create Account' }).click();

  // Onboarding: create organization
  await expect(page.getByRole('heading', { name: 'Create Your Organization' })).toBeVisible();
  await page.getByLabel('New organization name').fill('Hopper Systems');
  await page.getByRole('button', { name: 'Create' }).click();

  // 22.1 Overview page & metric cards + zero horizontal overflow
  await expect(page.getByRole('heading', { name: /Hopper Systems — Overview/i })).toBeVisible();
  await expect(page.getByText('Active Tunnels')).toBeVisible();
  await expect(page.getByText('Online Tunnels')).toBeVisible();
  await expect(page.getByText('Shares This Month')).toBeVisible();

  const desktopOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(desktopOverflow).toBe(true);
  await page.screenshot({ path: path.join(screenshotDir, '01-overview-dark.png'), fullPage: true });

  // 22.3 Projects tab -> create workspace
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByLabel('Workspace name').fill('checkout-service');
  await page.getByLabel('Workspace description').fill('Next.js + FastAPI checkout stack');
  await page.getByRole('button', { name: 'Create Project' }).click();
  await expect(page.getByText('checkout-service')).toBeVisible();

  // 22.4 Create Share modal flow -> open modal, configure port & subdomain, confirm exposure, create share
  await page.getByRole('button', { name: 'New Share' }).first().click();
  const createDialog = page.getByRole('dialog', { name: 'Create New Share' });
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole('button', { name: /:5173 \(Vite \/ React\)/i }).click();
  await createDialog.getByLabel('3. Share Name').fill('Checkout UI Preview');
  await createDialog.getByLabel(/Subdomain/i).fill('checkout-ui');
  await createDialog.getByRole('checkbox').check();
  await createDialog.getByRole('button', { name: 'Start Sharing' }).click();

  await expect(createDialog.getByText('https://checkout-ui.lorndavid.online')).toBeVisible();
  await createDialog.getByRole('button', { name: 'Copy Public URL' }).click();
  await createDialog.getByRole('button', { name: 'Done' }).click();

  // 22.5 Tunnel management -> view tunnels list, search & filter, stop & restart tunnel
  await page.getByRole('button', { name: 'Tunnels' }).click();
  await expect(page.getByRole('heading', { name: 'Tunnel Inventory' })).toBeVisible();
  await expect(page.getByText('Checkout UI Preview')).toBeVisible();

  await page.getByLabel('Search tunnels').fill('Checkout UI');
  await expect(page.getByText('Checkout UI Preview')).toBeVisible();
  await page.getByLabel('Search tunnels').fill('');

  await page.getByRole('button', { name: 'Stop tunnel Checkout UI Preview' }).click();
  await expect(
    page.getByRole('button', { name: 'Restart tunnel Checkout UI Preview' }),
  ).toBeVisible();

  // 22.6 Domains tab -> register custom domain & inspect DNS TXT challenge
  await page.getByRole('button', { name: 'Domains' }).click();
  const testHost = `preview-${Date.now()}.customer.com`;
  await page.getByLabel('Custom domain hostname').fill(testHost);
  await page.getByRole('button', { name: 'Add Domain' }).click();
  await expect(page.getByText(`_localshare-challenge.${testHost}`)).toBeVisible();
  await expect(page.getByText('PENDING_VERIFICATION')).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDir, '02-domains-dark.png'), fullPage: true });

  // 22.7 Security tab -> create Access Policy & generate Personal API Token (show-once modal)
  await page.getByRole('button', { name: 'Security' }).click();
  await page.getByLabel('Policy name').fill('Customer QA Team');
  await page.getByLabel('Allowed emails or domains').fill('qa@customer.com, @customer.com');
  await page.getByRole('button', { name: 'Create Policy' }).click();
  await expect(page.getByText('Customer QA Team')).toBeVisible();

  await page.getByLabel('Personal API token name').fill('Windows Dev Laptop');
  await page.getByRole('button', { name: 'Generate Token' }).click();
  const tokenDialog = page.getByRole('dialog', { name: 'New API token generated' });
  await expect(tokenDialog).toBeVisible();
  await expect(tokenDialog.locator('code')).toContainText('lsk_');
  await page.screenshot({
    path: path.join(screenshotDir, '03-security-token-dark.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'I have saved this token' }).click();

  // Activity tab -> verify audit events recorded
  await page.getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByText('domain.created')).toBeVisible();

  // 22.2 Theme switching & persistence in Settings
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await page.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.screenshot({ path: path.join(screenshotDir, '04-activity-light.png'), fullPage: true });

  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);

  // 22.8 Mobile responsiveness at 375x812
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Toggle navigation menu' }).click();
  const mobileNav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(mobileNav).toBeVisible();
  await mobileNav.getByRole('button', { name: 'Overview' }).click();
  await expect(page.getByRole('heading', { name: /Hopper Systems — Overview/i })).toBeVisible();

  const mobileNoOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(mobileNoOverflow).toBe(true);

  // Restore desktop viewport & logout
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'LocalShare Cloud' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
