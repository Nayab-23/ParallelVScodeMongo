import * as vscode from 'vscode';

import { EntityRecord } from '../store/store';
import { safeJsonStringify } from '../util/safeJson';

function nonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 16 })
    .map(() => possible.charAt(Math.floor(Math.random() * possible.length)))
    .join('');
}

export class DetailsPanel {
  private panel: vscode.WebviewPanel | null = null;

  constructor(private extensionUri: vscode.Uri) {}

  show(record: EntityRecord): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'parallelDetails',
        'Parallel Details',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          localResourceRoots: [this.extensionUri],
        }
      );
      this.panel.onDidDispose(() => {
        this.panel = null;
      });
    } else {
      this.panel.reveal();
    }
    if (this.panel) {
      this.panel.title = `Parallel: ${record.entity_type} ${record.id}`;
      this.panel.webview.html = this.renderHtml(record);
    }
  }

  private renderHtml(record: EntityRecord): string {
    const nonceValue = nonce();
    const data = {
      id: record.id,
      entity_type: record.entity_type,
      updated_at: record.updated_at,
      deleted: record.deleted ?? false,
      payload: record.payload ?? {},
    };
    const pretty = safeJsonStringify(data);
    return `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonceValue}'; script-src 'nonce-${nonceValue}';" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <style nonce="${nonceValue}">
            body { font-family: -apple-system, Segoe UI, sans-serif; padding: 16px; color: #0f172a; }
            h1 { font-size: 18px; margin-bottom: 8px; }
            .meta { color: #475569; margin-bottom: 12px; }
            pre { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; overflow-x: auto; }
            button { background: #2563eb; color: white; border: none; padding: 8px 12px; border-radius: 6px; cursor: pointer; }
            button:hover { background: #1d4ed8; }
          </style>
        </head>
        <body>
          <h1>${data.entity_type} – ${data.id}</h1>
          <div class="meta">
            Updated: ${data.updated_at}<br/>
            Deleted: ${data.deleted ? 'Yes' : 'No'}
          </div>
          <button id="copy">Copy JSON</button>
          <pre id="payload">${pretty}</pre>
          <script nonce="${nonceValue}">
            (function() {
              const btn = document.getElementById('copy');
              const content = document.getElementById('payload').innerText;
              btn?.addEventListener('click', async () => {
                try {
                  await navigator.clipboard.writeText(content);
                } catch (err) {
                  console.error(err);
                }
              });
            })();
          </script>
        </body>
      </html>`;
  }
}
