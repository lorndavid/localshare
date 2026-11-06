import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as path from 'node:path';

test('Full E2E Developer Cloud Platform Journey + Accessibility + Screenshots @screenshots', async ({
  page,
}) => {
  const screenshotDir = path.resolve(process.cwd(), 'e2e', 'screenshots');
  const uniqueEmail = `e2e-${Date.now()}@customer.com`;

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

  // Overview page
  await expect(page.getByRole('heading', { name: /Hopper Systems — Overview/i })).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDir, '01-overview-dark.png'), fullPage: true });

  // Projects tab -> create workspace
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByLabel('Workspace name').fill('checkout-service');
  await page.getByLabel('Workspace description').fill('Next.js + FastAPI checkout stack');
  await page.getByRole('button', { name: 'Create Project' }).click();
  await expect(page.getByText('checkout-service')).toBeVisible();

  // Domains tab -> register custom domain & inspect DNS TXT challenge
  await page.getByRole('button', { name: 'Domains' }).click();
  const testHost = `preview-${Date.now()}.customer.com`;
  await page.getByLabel('Custom domain hostname').fill(testHost);
  await page.getByRole('button', { name: 'Add Domain' }).click();
  await expect(page.getByText(`_localshare-challenge.${testHost}`)).toBeVisible();
  await expect(page.getByText('PENDING_VERIFICATION')).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDir, '02-domains-dark.png'), fullPage: true });

  // Security tab -> create Access Policy & generate Personal API Token (show-once modal)
  await page.getByRole('button', { name: 'Security' }).click();
  await page.getByLabel('Policy name').fill('Customer QA Team');
  await page.getByLabel('Allowed emails or domains').fill('qa@customer.com, @customer.com');
  await page.getByRole('button', { name: 'Create Policy' }).click();
  await expect(page.getByText('Customer QA Team')).toBeVisible();

  await page.getByLabel('Personal API token name').fill('Windows Dev Laptop');
  await page.getByRole('button', { name: 'Generate Token' }).click();
  const dialog = page.getByRole('dialog', { name: 'New API token generated' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('code')).toContainText('lsk_');
  await page.screenshot({ path: path.join(screenshotDir, '03-security-token-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'I have saved this token' }).click();

  // Activity tab -> verify audit events recorded
  await page.getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByText('domain.created')).toBeVisible();

  // Toggle light theme & screenshot
  await page.getByRole('button', { name: 'Toggle color theme' }).click();
  await page.screenshot({ path: path.join(screenshotDir, '04-activity-light.png'), fullPage: true });

  // Logout
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'LocalShare Cloud' })).toBeVisible();
});

