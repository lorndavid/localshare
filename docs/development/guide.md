# LocalShare Development Guide

## Monorepo Layout

- `apps/vscode-extension`: LocalShare VS Code extension (`localshare-vscode`).
- `apps/api`: Optional NestJS + Prisma + PostgreSQL control-plane API (`@localshare/api`).
- `apps/web-dashboard`: Optional React 19 + Vite + Tailwind CSS v4 team dashboard (`@localshare/web-dashboard`).
- `packages/config`: Shared TypeScript (`tsconfig.base.json`) and ESLint flat config (`eslint.config.mjs`).
- `packages/shared-types`: Shared DTOs, enums, and role hierarchy (`@localshare/shared-types`).
- `packages/validation`: Pure validation & security helpers (`@localshare/validation`).
- `packages/ui`: Shared design tokens and status badge metadata (`@localshare/ui`).

## Setup & Workflow

1. Install dependencies:
   ```powershell
   pnpm install
   ```
2. Build shared packages:
   ```powershell
   pnpm build:packages
   ```
3. Run typecheck, lint, and unit tests across all workspaces:
   ```powershell
   pnpm typecheck
   pnpm lint
   pnpm test
   ```
4. Package the VS Code extension into `apps/vscode-extension/dist/localshare.vsix`:
   ```powershell
   pnpm package:extension
   ```

