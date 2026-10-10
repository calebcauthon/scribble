# report-button

A "Report a problem" button for any web page. The user draws on a screenshot of what they
see, types a note, and it lands as a GitHub issue.

<img src="https://cdn.jsdelivr.net/npm/report-button@0/docs/annotate.png" alt="The annotation overlay: a frozen screenshot with a circle, a box and a text label drawn on it, the password field blacked out, and the toolbar with a note field" width="49%"> <img src="https://cdn.jsdelivr.net/npm/report-button@0/docs/github-issue.jpg" alt="The resulting issue on github.com: the annotated screenshot inline, the note, and a table of page, viewport, browser and context" width="49%">

*Left: the overlay. Right: the issue it filed on github.com.*

## Install

```html
<script src="https://cdn.jsdelivr.net/npm/report-button@0" data-repo="you/your-app"></script>
```

That's the whole install. Leave `data-repo` off and the button asks for the repo and gives
you the finished tag to paste.

## How it gets to GitHub

| | Works for | Setup |
|---|---|---|
| **Open in GitHub** (default) | Anyone who can open issues on the repo: your team, testers, contributors | None |
| **Connected** | Anyone, no GitHub account needed | Install the GitHub App on the repo |

**Open in GitHub** needs no server. On send, the screenshot goes to the clipboard and a
prefilled new-issue page opens. The reporter pastes the screenshot (Cmd+V) and submits.

**Connected** runs reports through a relay (the server in this repo) that files them as a
GitHub App, so reporters don't need an account. When the button isn't connected yet, it
links to the relay's setup page, which checks your repo and walks you through:

1. **Install the app** on the repo. It asks for Issues: write (to open the issue),
   Contents: write (to commit the screenshot to a separate `report-screenshots` branch) and
   Metadata: read.
2. **Optionally lock it to your site**: commit `.github/report-button.yml` (the page
   prefills it for you):
   ```yaml
   origins: [https://app.example.com]   # omit to allow any site
   labels: [user-report]
   assignees: octocat
   ```

The button checks again every time it opens, so once the app is installed it switches to
direct filing without a code change.

## Options

| Attribute | |
|---|---|
| `data-repo` | `owner/name` to file into. |
| `data-relay` | Your relay's URL, if you run your own. `""` means always open GitHub. |
| `data-label`, `data-position`, `data-accent` | Button text, corner, colour. |
| `data-mask` | Extra selectors to black out. Password fields and `[data-report-mask]` always are. |
| `data-manual` | Don't auto-mount. Call `ReportButton.init({...})` yourself. |

As a module: `npm install report-button`, then
`init({ repo, context: () => ({ User: me.email }) })`. Each `context` entry becomes a row
in the issue, which is the place for a user id or a session-replay link. See
[the `Options` type](https://cdn.jsdelivr.net/npm/report-button@0/dist/types/client/Report.d.ts) for every option.

## Running the relay

One Node process with no database: it talks only to GitHub. `Dockerfile` and `railway.json`
are included.

- **GitHub App** (any repo that installs it): start the server, open `/setup/app`, click
  *Create on GitHub*, then set the `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and
  `GITHUB_APP_PRIVATE_KEY` it shows you.
- **Token** (one repo): set `GITHUB_TOKEN` (a fine-grained token with Issues and Contents
  write on that repo) and `GITHUB_REPO`. `ALLOWED_ORIGINS` limits which sites can submit.

Both modes can run in the same server. Other settings are in
[the `Config` type](https://cdn.jsdelivr.net/npm/report-button@0/dist/types/server/config.d.ts).

## Development

```bash
npm run fixture    # demo + relay against a fake GitHub: http://localhost:8787/demo
npm run test:all   # unit tests, then Playwright end to end
```

MIT.
