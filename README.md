# Parallel VS Code Extension

Parallel brings an agent-style workflow into VS Code. It blends your Parallel workspace context (assigned tasks + recent assistant chats) with the open repo so you can ask for changes, review the proposed diffs, and apply only after you explicitly grant permission.

## What it does

- Sign in with your Parallel account in the browser (OAuth; tokens stored in VS Code Secret Storage) and select a workspace.
- Context service (“Parallel Memory”) fetches a backend bundle via `GET /api/v1/workspaces/{id}/vscode/context` (tasks + assistant chats) with a 5-minute TTL; cache key includes workspace, server, and user.
- Agent panel webview (“Parallel Agent”) with chat input, context sidebar, plan, and per-file diff preview.
- Prompt builder automatically includes repo info (workspace name, open files, diagnostics) plus Parallel context in every request.
- Agent calls `POST /api/v1/workspaces/{id}/vscode/agent/propose` to get a plan + multi-file edits (diff shown if supplied; otherwise computed locally for preview).
- Agent can propose shell commands; you explicitly approve and run them, with results shown in the panel.
- Edit pipeline supports read-only suggestions (dry run) vs apply-capable mode. Applying always requires Full Permission, a per-apply confirmation modal, and a final Apply click; nothing auto-writes on reload. Writes are restricted to workspace folders.
- Audit log in the Parallel output channel tracks sign-in, context fetches, and edits.

## Quickstart

1. Install dependencies: `npm ci`
2. Build: `npm run build` (or `npm run watch`)
3. Open this repo in the official Microsoft VS Code (Cursor may not support `extensionHost` debugging).
4. Run & Debug → **Run Extension** (or press `F5`) to launch the Extension Development Host.
5. Use the **Sign In** panel in the Parallel sidebar:
   - **Sign in with Browser** (OAuth; tokens stored in Secret Storage).
6. Run **Parallel: Select Workspace**.
   - If you can type but **Send** is disabled, sign in first.
   - The sidebar uses a single active chat (no session list). Use the **New Chat** icon in the header/composer to start over, or just **Send** to auto-create a chat.
   - Quick action cards prefill a high-quality prompt using the current workspace and recent changes.
7. Open **Parallel: Open Agent**. Ask for a change (dry-run by default), inspect the plan/diffs, then toggle **Parallel: Toggle Full Permission** and click Apply to write changes.
8. Refresh context anytime with **Parallel: Refresh Context**.

## Local development (backend + frontend)

1. Start the backend on `http://localhost:8000` (see `MongoDBHack/README.md`).
2. Start the frontend dev server on `http://localhost:5173` (from `MongoDBHack/apps/web`, run `npm install` then `npm run dev`).
3. In this repo, run `npm ci` and `npm run watch`.
4. Set settings:
   - `parallel.apiBaseUrl` → `http://localhost:8000`
   - `parallel.webBaseUrl` → your frontend URL (e.g., `http://localhost:5173` for Vite)
   - Optional: `parallel.sync.requestTimeoutMs` → increase if initial sync times out (default 120000)
   - Optional: `parallel.sync.pageSize` → lower for slower databases (default 200)
5. Open in official VS Code → Run & Debug → **Run Extension** (or `F5`).
6. Sign in from the Parallel sidebar (browser OAuth).
   - Tip: use `/agent <request>` or `/apply <request>` in the Chat sidebar to send a prompt to the Agent panel.

## Authentication notes

- OAuth uses `vscode://<extension-id>/auth-callback` as the redirect URI. Ensure the backend OAuth client allows this exact URI for your extension ID (e.g. `parallel.parallel-vscode`).
- `parallel.token` in settings is legacy and is migrated once into VS Code Secret Storage.

## Commands

- `Parallel: Sign In` (`parallel.signIn`)
- `Parallel: Sign Out` (`parallel.signOut`)
- `Parallel: Select Workspace` (`parallel.selectWorkspace`)
- `Parallel: Refresh Context` (`parallel.refreshContext`)
- `Parallel: Open Agent` (`parallel.agent.open`)
- `Parallel: Toggle Full Permission` (`parallel.toggleFullPermission`)
- `Parallel: Force Sync` (`parallel.forceSync`) / `Parallel: Force Full Resync` (`parallel.forceFullResync`)
- `Parallel: Search` (`parallel.search.prompt`)
- `Parallel: Insert Context Summary` (`parallel.insertContextSummary`)
- `Parallel: Open Details` (`parallel.openDetails`)

## Permission model

- Full Permission is **off by default**. Enabling requires a modal confirmation and is persisted in global state; if it persists across reloads, a startup warning is shown and the first apply requires reconfirmation.
- Read-only suggestions (dry run) are the default mode in the Agent panel; dry-run proposals are blocked from applying at the UI, apply handler, and workspace write layer.
- Even with Full Permission on, each batch apply triggers a modal confirmation that lists the target files, and writes are only attempted inside workspace folders (path traversal is rejected).
- Command runs also require Full Permission plus a per-run confirmation; working directories are restricted to workspace folders.
- Audit log entries note when context is fetched, proposals are prepared, applies are confirmed, and files are applied/skipped.

## Context and security

- Access/refresh tokens are stored in VS Code SecretStorage.
- Context cache (tasks + assistant chat summaries) is scoped per workspace, kept for 5 minutes, and avoids storing long raw transcripts.
- Status bar shows signed-in state and the active workspace; refresh context manually if needed.

## Development

- Build: `npm run build`
- Tests: `npm test`
- Lint/format: `npm run lint`, `npm run format`
- Package VSIX: `npm run package`

## Verification checklist

- Backend running on `http://localhost:8000`.
- Frontend running on `http://localhost:5173`.
- `F5` opens the **Extension Development Host** window.
- Sidebar shows the Copilot-style chat UI under the Parallel activity bar.
- No session list; the header/composer **New Chat** icon resets the active chat.
- **Open Web App** opens `http://localhost:5173`.
- **Sign In** (browser or token) completes successfully.
- **Select Workspace** completes successfully.
- **Force Sync** succeeds.
- Sending a message works (if backend chat routes are enabled).
- Quick action cards prefill the composer with a workspace-aware prompt.
- Logs appear in the **Parallel** output channel.
