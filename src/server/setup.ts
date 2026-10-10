/**
 * The relay's setup pages. The button links here when it is not connected yet, so a
 * site owner can see what is missing for their repo and fix it from GitHub.
 */
import { SETTINGS_PATH } from './githubApp.ts'

export interface SetupState {
  repo: string
  /** The page the button is on, when the button sent us here. */
  origin?: string
  webUrl: string
  appConfigured: boolean
  /** The one repo token mode files into, if any. */
  tokenRepo?: string
  installUrl?: string
  installed?: boolean
  origins?: string[]
  originAllowed?: boolean
  defaultBranch?: string
  connected?: boolean
  installedJustNow?: boolean
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const STYLE = `<style>
  :root{--bg:#f6f8fa;--card:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--accent:#394eff;--ok:#1a7f37;--warn:#9a6700;--code:#eff1f3}
  @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--accent:#7d8bff;--ok:#3fb950;--warn:#d29922;--code:#1f242c}}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,sans-serif}
  main{max-width:680px;margin:0 auto;padding:40px 16px 64px} h1{font-size:24px;margin:0 0 4px} .sub{color:var(--muted);margin:0 0 24px}
  .step{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:12px 0}
  .step h2{font-size:16px;margin:0 0 6px;display:flex;gap:8px;align-items:center} .step p{margin:6px 0}
  .badge{font-size:12px;font-weight:600;border-radius:999px;padding:1px 8px;border:1px solid currentColor}
  .ok{color:var(--ok)} .warn{color:var(--warn)} .muted{color:var(--muted)}
  .btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;border:0;border-radius:8px;padding:8px 14px;font:600 14px system-ui,sans-serif;cursor:pointer;margin-top:6px}
  .btn.secondary{background:transparent;color:var(--accent);border:1px solid var(--line)}
  pre,code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:6px} code{padding:1px 5px}
  pre{padding:10px 12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
  input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);width:100%;max-width:320px}
  form{display:flex;gap:8px;flex-wrap:wrap;align-items:center} a{color:var(--accent)}
</style>`

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${STYLE}</head><body><main>${body}</main></body></html>`

const badge = (done: boolean | undefined, yes = 'done', no = 'to do') =>
  done ? `<span class="badge ok">${yes}</span>` : `<span class="badge warn">${no}</span>`

function settingsYaml(origin: string | undefined, existing: string[] = []): string {
  const origins = [...new Set([...existing, ...(origin ? [origin] : [])])]
  return [
    '# Read by report-button. Every key is optional.',
    'origins:            # pages allowed to file issues; omit to allow any',
    ...(origins.length ? origins.map((o) => `  - ${o}`) : ['  - https://your-site.example.com']),
    'labels: [user-report]',
    '# assignees: your-github-login',
    '',
  ].join('\n')
}

export function renderSetup(s: SetupState): string {
  const head = `<h1>Connect report-button to GitHub</h1>`
  const repoForm = `<form method="get" action="/setup">
      <input name="repo" placeholder="owner/repo" value="${esc(s.repo)}" aria-label="Repository" required>
      ${s.origin ? `<input type="hidden" name="origin" value="${esc(s.origin)}">` : ''}
      <button class="btn" type="submit">Check</button></form>`

  if (!s.repo) {
    return page(
      'Connect report-button',
      `${head}<p class="sub">${s.installedJustNow ? 'The app is installed. Enter the repo to check the rest, or go back to your page and click the button again.' : 'Which repo should reports go to?'}</p>
      <div class="step">${repoForm}</div>`,
    )
  }

  const repo = esc(s.repo)
  const sub = `<p class="sub">Repo <b>${repo}</b>${s.origin ? ` · page <b>${esc(s.origin)}</b>` : ''}</p>`

  const fallback = `<div class="step"><h2>Reports open in GitHub ${badge(true, 'works now')}</h2>
    <p>Until this is connected, the button opens a prefilled new-issue page on ${repo} with the screenshot on the
    clipboard. That works for anyone who can open issues there: your team, testers, contributors.</p></div>`

  if (s.tokenRepo && s.tokenRepo.toLowerCase() === s.repo.toLowerCase()) {
    return page(
      'Connect report-button',
      `${head}${sub}<div class="step"><h2>Connected with a token ${badge(s.connected, 'connected', 'origin blocked')}</h2>
      <p>This server files issues into ${repo} with its own token.${s.connected ? ' Reload your page; reports go straight in.' : ' This page is not in its <code>ALLOWED_ORIGINS</code>.'}</p></div>`,
    )
  }

  if (!s.appConfigured) {
    return page(
      'Connect report-button',
      `${head}${sub}${fallback}<div class="step"><h2>Let anyone report ${badge(false, '', 'not available')}</h2>
      <p>This server has no GitHub App configured${s.tokenRepo ? ` and its token only covers ${esc(s.tokenRepo)}` : ''}.
      Whoever runs it can register one at <a href="/setup/app">/setup/app</a>.</p></div>`,
    )
  }

  const install = `<div class="step"><h2>1. Install the GitHub App on ${repo} ${badge(s.installed)}</h2>
    ${
      s.installed
        ? '<p>Installed. Issues are filed by the app, so reporters need no GitHub account.</p>'
        : `<p>Pick <b>${repo}</b> on the next screen. The app asks for:</p>
      <p class="muted">Issues: write, to open the issue · Contents: write, to commit the screenshot to a separate
      <code>report-screenshots</code> branch (never your code branches) · Metadata: read</p>
      <a class="btn" href="${esc(s.installUrl ?? '#')}">Install on GitHub</a>`
    }</div>`

  let lock = ''
  if (s.installed) {
    const branch = encodeURIComponent(s.defaultBranch ?? 'main')
    const hasFile = (s.origins?.length ?? 0) > 0
    const yaml = settingsYaml(s.origin, s.origins)
    const href = hasFile
      ? `${s.webUrl}/${s.repo}/edit/${branch}/${SETTINGS_PATH}`
      : `${s.webUrl}/${s.repo}/new/${branch}?filename=${encodeURIComponent(SETTINGS_PATH)}&value=${encodeURIComponent(yaml)}`
    const blocked = hasFile && !s.originAllowed
    lock = `<div class="step"><h2>2. Lock it to your site ${blocked ? badge(false, '', 'this page is blocked') : badge(hasFile, 'done', 'optional')}</h2>
      ${
        blocked
          ? `<p><code>${SETTINGS_PATH}</code> lists other origins, so reports from ${esc(s.origin ?? 'this page')} are refused. Add it:</p>`
          : hasFile
            ? `<p>Only these pages can file: ${s.origins!.map((o) => `<code>${esc(o)}</code>`).join(' ')}</p>`
            : `<p>Right now any site can file issues into ${repo} through this app. Commit this file to allow only yours:</p>`
      }
      ${!hasFile || blocked ? `<pre>${esc(yaml)}</pre>` : ''}
      <a class="btn secondary" href="${esc(href)}">${hasFile ? 'Edit' : 'Create'} ${SETTINGS_PATH} on GitHub</a></div>`
  }

  const done = s.connected
    ? `<div class="step"><h2>Connected ${badge(true, 'ready')}</h2><p>Reload your page. Reports now go straight into ${repo}, from anyone.</p></div>`
    : ''

  return page(
    'Connect report-button',
    `${head}${sub}${s.connected ? '' : fallback}${install}${lock}${done}
    <p class="muted">Changes on GitHub can take a minute to show up here. <a href="">Check again</a></p>`,
  )
}

/** The form that hands GitHub an app manifest; GitHub creates the app and calls back. */
export function renderRegisterApp(base: string, webUrl: string): string {
  const manifest = {
    name: 'report-button',
    url: base,
    redirect_url: `${base}/setup/app/callback`,
    setup_url: `${base}/setup`,
    setup_on_update: true,
    public: true,
    hook_attributes: { url: `${base}/webhook`, active: false },
    default_permissions: { issues: 'write', contents: 'write', metadata: 'read' },
  }
  return page(
    'Register the GitHub App',
    `<h1>Register the report-button GitHub App</h1>
    <p class="sub">One time, for whoever runs this server at <b>${esc(base)}</b>. GitHub creates the app, then sends you
    back here with its id and private key.</p>
    <div class="step">
      <form id="f" method="post" action="${esc(webUrl)}/settings/apps/new">
        <input id="name" value="report-button" aria-label="App name" required>
        <input id="org" placeholder="organization (optional)" aria-label="Organization">
        <input type="hidden" name="manifest" id="manifest">
        <button class="btn" type="submit">Create on GitHub</button>
      </form>
      <p class="muted">App names are unique across GitHub; pick another if this one is taken.
      It asks for Issues: write, Contents: write and Metadata: read.</p>
    </div>
    <script>
      const m = ${JSON.stringify(manifest).replace(/</g, '\\u003c')};
      document.getElementById('f').addEventListener('submit', (e) => {
        const org = document.getElementById('org').value.trim();
        m.name = document.getElementById('name').value.trim() || m.name;
        document.getElementById('manifest').value = JSON.stringify(m);
        if (org) e.target.action = ${JSON.stringify(webUrl)} + '/organizations/' + encodeURIComponent(org) + '/settings/apps/new';
      });
    </script>`,
  )
}

export function renderAppCreated(app: { id: number; slug: string; pem: string; html_url: string }): string {
  const env = [
    `GITHUB_APP_ID=${app.id}`,
    `GITHUB_APP_SLUG=${app.slug}`,
    `GITHUB_APP_PRIVATE_KEY=${app.pem.trim().replace(/\n/g, '\\n')}`,
  ].join('\n')
  return page(
    'GitHub App created',
    `<h1>App created: ${esc(app.slug)}</h1>
    <p class="sub">Set these on this server and restart it. The key is shown once; GitHub will not show it again.</p>
    <div class="step"><pre>${esc(env)}</pre></div>
    <p><a href="${esc(app.html_url)}">App settings on GitHub</a></p>`,
  )
}
