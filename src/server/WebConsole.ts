/**
 * 🖥️ Web Console Dashboard
 * Generates an HTML dashboard page similar to FastAPI docs
 */

import { ServerState } from '../types/VSCode';
import { API_ENDPOINTS } from '../constants/Config';

export interface ConsoleData {
    serverState: ServerState;
    version: string;
    endpoints: Array<{ method: string; path: string; description: string }>;
}

/**
 * Generate the web console HTML page
 */
export function generateConsoleHTML(data: ConsoleData): string {
    const uptime = data.serverState.startTime
        ? formatUptime(Date.now() - data.serverState.startTime.getTime())
        : 'N/A';

    const endpointRows = data.endpoints
        .map(ep => {
            const methodClass = ep.method === 'GET' ? 'method-get' : 'method-post';
            return `<tr>
                <td><span class="method ${methodClass}">${escapeHtml(ep.method)}</span></td>
                <td><code>${escapeHtml(ep.path)}</code></td>
                <td>${escapeHtml(ep.description)}</td>
                <td>${ep.method === 'GET' ? `<a class="try-link" href="${escapeHtml(ep.path)}" target="_blank">Try it ↗</a>` : ''}</td>
            </tr>`;
        })
        .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Copilot LMAPI - Console</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif; background: #0d1117; color: #c9d1d9; line-height: 1.6; }
  .header { background: linear-gradient(135deg, #161b22, #1c2333); padding: 2rem; border-bottom: 1px solid #30363d; }
  .header h1 { font-size: 1.75rem; color: #58a6ff; }
  .header p { color: #8b949e; margin-top: 0.25rem; }
  .container { max-width: 960px; margin: 0 auto; padding: 1.5rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; }
  .card .label { font-size: 0.75rem; text-transform: uppercase; color: #8b949e; letter-spacing: 0.05em; }
  .card .value { font-size: 1.5rem; font-weight: 600; color: #58a6ff; margin-top: 0.25rem; }
  .card .value.ok { color: #3fb950; }
  .card .value.err { color: #f85149; }
  h2 { font-size: 1.25rem; color: #c9d1d9; margin: 1.5rem 0 0.75rem; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 0.6rem 1rem; border-bottom: 1px solid #21262d; }
  th { background: #1c2333; color: #8b949e; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
  code { background: #1c2333; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9rem; color: #e6edf3; }
  .method { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 700; }
  .method-get { background: #1a3a2a; color: #3fb950; }
  .method-post { background: #3a2a1a; color: #d29922; }
  .try-link { color: #58a6ff; text-decoration: none; font-size: 0.85rem; }
  .try-link:hover { text-decoration: underline; }
  .footer { text-align: center; padding: 2rem; color: #484f58; font-size: 0.8rem; border-top: 1px solid #21262d; margin-top: 2rem; }
</style>
</head>
<body>
<div class="header">
  <div class="container">
    <h1>🚀 Copilot LMAPI Console</h1>
    <p>OpenAI-compatible API powered by GitHub Copilot &mdash; v${escapeHtml(data.version)}</p>
  </div>
</div>
<div class="container">
  <div class="cards">
    <div class="card">
      <div class="label">Status</div>
      <div class="value ${data.serverState.isRunning ? 'ok' : 'err'}">${data.serverState.isRunning ? '● Running' : '● Stopped'}</div>
    </div>
    <div class="card">
      <div class="label">Uptime</div>
      <div class="value">${escapeHtml(uptime)}</div>
    </div>
    <div class="card">
      <div class="label">Requests</div>
      <div class="value">${data.serverState.requestCount}</div>
    </div>
    <div class="card">
      <div class="label">Errors</div>
      <div class="value ${data.serverState.errorCount > 0 ? 'err' : ''}">${data.serverState.errorCount}</div>
    </div>
    <div class="card">
      <div class="label">Active Connections</div>
      <div class="value">${data.serverState.activeConnections}</div>
    </div>
  </div>

  <h2>API Endpoints</h2>
  <table>
    <thead><tr><th>Method</th><th>Path</th><th>Description</th><th></th></tr></thead>
    <tbody>
      ${endpointRows}
    </tbody>
  </table>
</div>
<div class="footer">Copilot LMAPI &copy; ${new Date().getFullYear()} &mdash; Serving on ${escapeHtml(data.serverState.host || '127.0.0.1')}:${data.serverState.port || '?'}</div>
</body>
</html>`;
}

/**
 * Get the list of API endpoints with descriptions
 */
export function getEndpointList(): ConsoleData['endpoints'] {
    return [
        { method: 'GET', path: '/', description: 'This console page' },
        { method: 'POST', path: API_ENDPOINTS.CHAT_COMPLETIONS, description: 'Create a chat completion (OpenAI-compatible)' },
        { method: 'GET', path: API_ENDPOINTS.MODELS, description: 'List available models' },
        { method: 'GET', path: API_ENDPOINTS.HEALTH, description: 'Server health check' },
        { method: 'GET', path: API_ENDPOINTS.STATUS, description: 'Server status and statistics' },
        { method: 'POST', path: '/v1/models/refresh', description: 'Refresh model cache' },
        { method: 'GET', path: '/v1/capabilities', description: 'Server capabilities and features' },
    ];
}

function formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) { return `${days}d ${hours % 24}h ${minutes % 60}m`; }
    if (hours > 0) { return `${hours}h ${minutes % 60}m ${seconds % 60}s`; }
    if (minutes > 0) { return `${minutes}m ${seconds % 60}s`; }
    return `${seconds}s`;
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
