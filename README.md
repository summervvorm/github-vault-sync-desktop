# GitHub Vault Sync (Desktop)

Sync your Obsidian vault with a GitHub repository. Your vault **is** the Git working tree — no export, no conversion, no intermediate format.

Once configured, the plugin commits your local changes, pulls remote updates, merges them, and pushes back to GitHub on a timer or on demand.

## What it does

- Treats the vault root as the Git working tree root, so the vault and the GitHub repository are the same thing.
- Commits local changes, fetches, three-way merges, and pushes in one safe sequence.
- Never force-pushes. If a push is rejected, it re-fetches and retries.
- Keeps conflict copies when a merge cannot be resolved automatically, so no note is ever lost.
- Ships a `.gitignore` that keeps secrets and noise out of your repository.

## Requirements

| Requirement | Notes |
|---|---|
| Obsidian 1.11.4 or later | Desktop only. The plugin uses Node.js APIs, so it cannot run on mobile. |
| Git 2.28 or later | Located automatically, or set a path manually in the settings. |
| A GitHub repository | Private or public. |
| A GitHub account | See [Disclosures](#disclosures). |

## Disclosures

The Obsidian [developer policies](https://docs.obsidian.md/community-directory/developer-policies) require the following to be stated clearly.

- **Network use.** This plugin sends and receives data over the network, exclusively by invoking your local `git` executable against the remote repository you configure. It talks to that one remote (normally `github.com`) and to nothing else. The plugin itself contains no HTTP client and contacts no other server. No telemetry of any kind is collected or transmitted.
- **Account required.** You need a GitHub account, and a repository you can push to. Authentication uses either your operating system's Git credential helper (recommended) or a personal access token that you provide. Tokens are stored with Obsidian's `secretStorage` API when available.
- **Files accessed.** The plugin operates on your vault directory, including its `.git` directory. It also probes common installation paths to locate the `git` executable, and launches that executable as a child process. It does not read or write files outside your vault, other than locating `git`.
- **No self-updating.** The plugin never installs or updates itself or its dependencies.

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest).
2. Create `<your-vault>/.obsidian/plugins/github-vault-sync-desktop/`.
3. Place the three files in that folder.
4. Reload Obsidian and enable **GitHub Vault Sync (Desktop)** under **Settings → Community plugins**.

### From source

```bash
git clone <this-repo>
cd <this-repo>
pnpm install
pnpm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` into your vault's plugin folder.

### Upgrading from the old `github-vault-sync` id

The plugin was renamed from `github-vault-sync` to `github-vault-sync-desktop` because that id was
already taken in the community registry. Obsidian keys a plugin's settings by its id, so an existing
install does not carry over automatically:

1. Turn off the old plugin, then move the folder
   `.obsidian/plugins/github-vault-sync/` to `.obsidian/plugins/github-vault-sync-desktop/`.
2. Copy the new `main.js`, `manifest.json`, and `styles.css` into that folder (replacing the old ones).
3. Reload Obsidian and enable **GitHub Vault Sync (Desktop)**.

Your `data.json` (repository URL, branch, schedule) comes along with the folder. The access token, if
you stored one, uses a new secret key — enter it once more when prompted.

## Usage

### Setting up

1. Create an empty repository on GitHub. Do **not** initialize it with a README.
2. In Obsidian, open **Settings → GitHub Vault Sync (Desktop)**.
3. Enter the repository URL, for example `https://github.com/you/your-vault.git`.
4. Choose an authentication method:
   - **System credential helper** (recommended) — Git uses your operating system's credential manager. The token never enters your vault.
   - **Personal access token** — paste a token with `Contents: Read and write`. Stored via Obsidian's `secretStorage` when available.
5. Run the command **GitHub Vault Sync (Desktop): Initialize repository**. This creates the local repository, writes `.gitignore` and `.gitattributes`, registers the merge driver, and makes the first commit and push.

### Day to day

| Action | How |
|---|---|
| Sync now | Click the status bar item, or run **GitHub Vault Sync (Desktop): Sync now** |
| Automatic | Every 300 seconds by default. Configurable, or turn it off. |
| View log | **GitHub Vault Sync (Desktop): View sync log** (credentials are redacted) |

### Status bar

| Display | Meaning |
|---|---|
| `✓ 已同步` | Local and remote are in sync |
| `⇅ 同步中…` | A sync is running |
| `↑2` | Two local commits are not pushed yet |
| `☁ 离线` | Fetch failed. Local commits are kept; the next run retries. |
| `⚠ 冲突 2` | Two files need manual conflict resolution |
| `⚠ 待解决` | A previous conflict is unresolved; syncing is paused |
| `✗ 失败` | The last run failed |

## Conflicts

When both sides change the same line of the same note, Git cannot merge automatically. The plugin then:

1. Leaves the conflict markers in the note.
2. **Saves the other side's version as a separate copy** — `note.conflict-<device>-<timestamp>.md` — so nothing is lost even if you delete the markers by accident.
3. **Does not commit and does not push.** The status bar shows `⚠ 冲突`.

Resolve it by editing the note into the version you want, removing the `<<<<<<<`, `|||||||`, `=======`, and `>>>>>>>` lines, then syncing again.

Before every merge the plugin records the pre-merge state as a `conflict/<timestamp>` branch ref, so a merge that goes wrong can be undone with `git reset --hard conflict/<timestamp>`.

## What is not synced

| Path | Why |
|---|---|
| `.obsidian/plugins/` | Plugin `data.json` files hold plaintext tokens and private keys; bundled `main.js` files are multi-megabyte build artifacts |
| `.obsidian/workspace.json` | Changes on every pane switch — pure noise |
| `.obsidian/graph.json` | Same |
| `.trash/` | Obsidian's trash |
| `*.conflict-*` | Conflict copies, so they cannot cause further conflicts |

Other configuration files such as `appearance.json`, `hotkeys.json`, and `community-plugins.json` **are** synced, so your setup stays consistent across devices.

## Troubleshooting

**The status bar shows `☁ 离线`**

Check, in order: the repository URL ends with `.git`; the credential helper is configured or the token is valid and unexpired; a fine-grained token has `Contents: Read and write`. Open the sync log for the specific reason — credentials are redacted.

**"Git executable not found"**

Use the **Detect** button in the settings. The plugin searches `PATH` first, then common installation locations, including the Git bundled with GitHub Desktop. If that fails, enter the full path manually.

**Sync is slow on a large vault**

The initial push of a large vault can take a while. Later syncs only transfer changes.

## Development

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm test            # 46 core tests + 26 plugin tests
pnpm run build       # produces main.js
```

The Git logic lives in `src/core/` and deliberately does **not** import `obsidian`. That keeps it testable in plain Node against real Git repositories, which is how the test suite exercises the full commit / merge / conflict / push path without launching Obsidian.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

**GitHub Vault Sync (Desktop)** 把 Obsidian 仓库与 GitHub 仓库统一成同一个东西：Vault 根目录就是 Git 工作区根目录，一次同步 = 一次 `commit + fetch + merge + push`，不需要任何导出或转换。

- 仅支持**桌面端**（使用了 Node.js API）
- 需要本机已安装 Git 2.28+
- 远端仓库可以是私有或公开
- 冲突时**不会自动提交、不会推送**，并把对方版本另存为副本，保证不丢数据
- 默认每 300 秒自动同步一次，也可手动触发

详细的中文使用说明见仓库文档目录。
