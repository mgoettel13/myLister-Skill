# Install MyLister for Dot or OpenClaw

Follow this guide when an operator asks you to install or update the generic MyLister skill. Finish installation and staging checks on the computer that will actually run its Node client. The skill name is `lister`; the repository is [mgoettel13/myLister-Skill](https://github.com/mgoettel13/myLister-Skill).

## 1. Find the execution host and skills directory

Identify the host, OS user, active agent/profile, and whether commands run locally, remotely, or in a container. Use the host's current skill catalog and configuration to locate its skill roots. Read only the relevant configuration fields; do not print entire configuration files, which may contain secrets.

### Dot

1. Use the user's **connected personal computer** for this local skill. If it is not connected, direct the user to their dot's profile in the ChatGPT desktop app: **Computers → Your computer → Allow access**. Keep that computer online with the app open. These requirements are documented in [Dot computer access](https://learn.chatgpt.com/docs/dots/computers-and-apps).
2. Inspect the local task's available skills and their file locations. Use a confirmed, writable personal skill root. Do not install into a bundled plugin cache or system skill directory.
3. For a local Codex task coordinated by Dot, the documented user root is `~/.agents/skills` (`%USERPROFILE%\.agents\skills` on Windows); install into its `lister` child directory. A project-only alternative is `<project>/.agents/skills/lister`. These are [Codex discovery locations](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills), not a promise of a separate universal Dot directory. Use a legacy location such as `~/.codex/skills` only when the actual runtime/catalog confirms it is loaded.
4. Refresh the local Skills view or start a fresh local task and confirm `lister` resolves to the installed `SKILL.md`. If the Dot runtime does not expose local skill discovery directly, have Dot delegate the request to a local Codex task on that same connected computer and give it the installed skill's absolute path. Verify that task loads it; installing on the cloud computer alone does not establish local discovery.

### OpenClaw

1. Identify the active Gateway/profile, agent workspace, and command execution host. For remote Gateways, install on the relevant remote host, not merely on the computer showing its dashboard.
2. Inspect the active configuration's agent workspace, state directory, and `skills.load.extraDirs`. Respect custom config/state locations; do not assume every profile uses `~/.openclaw`.
3. Prefer `<active-workspace>/skills/lister` for this agent. For an intentionally shared installation, use `<active-state-directory>/skills/lister` (normally `~/.openclaw/skills/lister`). An explicitly configured extra skill root is also valid. Workspace skills can shadow shared copies of the same name; check which copy wins. See [OpenClaw loading order](https://docs.openclaw.ai/tools/skills#loading-order).
4. If the agent has an explicit skills allowlist, add `lister` without replacing its other entries. Refresh discovery using the installed version's Skills controls, then use a fresh session to confirm the selected source. See [OpenClaw skills configuration](https://docs.openclaw.ai/tools/skills-config).

Before writing, check for an existing `lister` skill at the chosen destination and other loaded copies with that name. Update the intended installation; preserve local changes and report conflicts instead of overwriting them. Dot and OpenClaw should have separate API keys and private configuration directories even when they run as the same OS user.

## 2. Install the complete repository

Use Git, Node.js **22.13 or later**, and npm in the actual execution environment. Check `node --version` and `npm --version`. In PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`.

Set `skills_root` or `$skillsRoot` to the absolute root discovered above. The following commands are for a **new, absent destination**.

**Linux/macOS shell:**

```sh
set -eu
mkdir -p -- "$skills_root"
lister_install="$skills_root/lister"
git clone https://github.com/mgoettel13/myLister-Skill.git "$lister_install"
cd -- "$lister_install"
npm ci
node -e "if (!require('node:fs').existsSync('dist/index.js')) process.exit(1); console.log('MyLister client built')"
```

**Windows PowerShell:**

```powershell
$listerInstall = Join-Path $skillsRoot 'lister'
New-Item -ItemType Directory -Path $skillsRoot -Force -ErrorAction Stop | Out-Null
git clone https://github.com/mgoettel13/myLister-Skill.git $listerInstall
if ($LASTEXITCODE -ne 0) { throw 'Clone failed' }
Set-Location -LiteralPath $listerInstall -ErrorAction Stop
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Install/build failed' }
if (-not (Test-Path -LiteralPath 'dist/index.js')) { throw 'Client was not built' }
```

`npm ci` runs the prepare build. Install development dependencies for this build; do not use `--omit=dev` or `--ignore-scripts` for source installation. Copying only `SKILL.md` leaves the client missing.

For an existing Git installation, verify its origin is this repository and check for local changes. Fast-forward its clean `main` checkout with `git pull --ff-only`, then run `npm ci` again. Preserve the private configuration directory during updates. If the checkout is modified or diverged, report the specific conflict before replacing anything.

Run subsequent commands in the installed directory, or use the absolute path to `dist/index.js`. When OpenClaw uses a sandbox/container, build and check Node inside that execution environment; a successful host installation does not prove the sandbox can run it.

## 3. Configure credentials privately

Have the user create a **new staging API key for this installation** in [MyLister staging](https://listerbeta.up.railway.app) → **Settings → API Keys**, with a recognizable name such as `Dot staging` or `OpenClaw staging`. Reuse that installation's existing key when updating it.

The user enters the key through a private secret-entry facility or configures their existing secret manager/service launcher to inject it into the Node process as **`LISTER_STAGING_API_KEY`**. Do not ask them to paste it into chat. Do not put the value in command arguments, shell history, Git, screenshots, task reports, or skill instructions. This guide does not assume Dot provides a particular API-key settings panel.

Configure these **non-secret** settings in the same launcher/runtime:

| Setting | Staging value |
| --- | --- |
| `LISTER_ENVIRONMENT` | `staging` |
| `LISTER_CONFIG_DIR` | Absolute, private, persistent directory specific to this installation |

Example private directories are `%LOCALAPPDATA%\MyListerSkill\dot-staging` or `%LOCALAPPDATA%\MyListerSkill\openclaw-staging` on Windows, and `~/.config/mylister-skill/dot-staging` or `~/.config/mylister-skill/openclaw-staging` on Linux/macOS. Expand these examples to absolute paths before configuring `LISTER_CONFIG_DIR`; the client does not expand a literal `~` in that variable. Restrict the directory to its owning OS user. In a container, use a private persistent volume that survives recreation.

### Getting the credential into the right process

- **Dot/local tasks:** configure the connected computer's task/command launcher or existing secret-manager integration. A variable entered in an unrelated terminal is not proof that an already running app or a delegated task inherits it. Refresh/relaunch the relevant runtime if needed, then check from the exact task that will run MyLister.
- **OpenClaw:** inject the real `LISTER_STAGING_API_KEY` through the execution service's approved secret delivery mechanism. This skill currently has **no `metadata.openclaw.primaryEnv`**, so setting only `skills.entries.lister.apiKey` does not configure it. Do not insert a SecretRef object or a vault-reference string into the environment variable and treat it as the resolved key. The client needs the actual key bytes locally for authentication and encryption-key derivation.
- OpenClaw can keep the **non-secret** pin in `skills.entries.lister.env`, for example `{ "LISTER_ENVIRONMENT": "staging" }`, and set `skills.entries.lister.enabled` to `true`. Merge these fields into the active configuration; retain unrelated settings. These host-run entries do not automatically inject values into a sandbox. Give the selected sandbox its own approved credential delivery and persistent config mount; do not disable sandboxing just to make setup pass. See [host versus sandbox environment](https://docs.openclaw.ai/tools/skills-config#sandboxed-skills-and-env-vars).

If no private credential-entry or delivery mechanism is available, finish installation and report that credential configuration is pending, naming the required variable and execution host. Do not request the value in a normal agent question. An operator can configure it privately and resume setup.

### OpenClaw private-Gateway alternative

For a private, single-owner Gateway using OpenClaw-managed **host exec**, the operator can run the following in their own private terminal and enter the key at its no-echo prompt:

```sh
openclaw secrets store set LISTER_STAGING_API_KEY --kind env
```

Use the active Gateway/profile's CLI context; check the installed version's `openclaw secrets store set --help` first. Do not append `--value` or run an agent-visible credential listing afterward. This deliberately creates an **agent-readable, Gateway/team-scoped environment entry**; it is appropriate only when that Gateway's agents are intended to have this account authority. Start a new agent run before checking setup. With OpenClaw's Codex harness, use `gateway_exec` for Gateway-hosted commands. This store route does not supply sandbox, remote-node, ACP, or Codex-native shell environments; use their own private credential delivery instead. See [OpenClaw's store CLI](https://docs.openclaw.ai/cli/secrets#set-values-safely).

Protected `secret` entries can supply opaque egress placeholders instead. As a consequence of [MyLister's local key derivation](https://github.com/mgoettel13/myLister-Skill/blob/main/src/identity.ts), an egress-only placeholder is insufficient for this client, even if an HTTPS proxy later substitutes a valid authentication header. See [stored-credential behavior](https://docs.openclaw.ai/tools/secrets#using-a-stored-credential). Do not disable the host's security controls to bypass this distinction. The Node process needs the actual credential; environment delivery keeps it out of chat, but does not make it unreadable to every command with the same execution authority.

## 4. Verify staging selection without revealing the key

Run this from the installed directory in the **same execution context** that will run normal skill commands:

```sh
node --input-type=module -e "import { initialConfiguration } from './dist/configuration.js'; const c = initialConfiguration(); console.log(JSON.stringify({environment:c.environment,baseUrl:c.baseUrl,keyConfigured:Boolean(c.apiKey)}));"
```

Expected output has `environment: "staging"`, `baseUrl: "https://lister-api-public-staging.up.railway.app"`, and `keyConfigured: true`. The command prints no credential. Check for unexpected origin overrides before continuing. Use that public API origin without `/api` or `/v1` appended; `https://listerbeta.up.railway.app` is the approval UI, not the API base.

If the key is absent, repair the secret delivery on the actual host/profile/container. Do not copy a production key into the staging variable. Keep `LISTER_ENVIRONMENT=staging` for this staging installation; it intentionally prevents accidental switches to production.

## 5. Enroll and obtain the owner's approval

```sh
node dist/index.js switch to staging
node dist/index.js setup encryption
```

Setup creates an encrypted local installation identity and requests approval. Return the MyLister approval link and **public installation fingerprint** to the user. The user opens the link in their normal browser, signs in to the correct staging account, compares the fingerprint, and approves **Enable encrypted access / Approve with passkey** in **Settings → API Keys**. If asked to unlock the account first, they complete that step in Security settings and return to API Keys.

The user performs the passkey step themselves. Never request their passkey, recovery material, browser cookies, or account root. Approval delegates the account's existing and future content access with its current shared-list rights; there are no per-list integration permissions.

Do not create another API key, delete local identity files, or repeat enrollment from a different config directory while approval is pending. Retry with the same installation, key, origin, and configuration directory.

## 6. Confirm completion from a fresh task/session

After approval, run:

```sh
node dist/index.js show connection status
node dist/index.js get my lists
```

Require status to report **staging**, the expected account, and **active encrypted access for this installation**, followed by a successful list read. Readable list content is private: report success/counts rather than copying titles into installation logs. An empty account may validly return no lists. Do not create/delete content or send email as an installation test.

Repeat the status check in a fresh task/session on the intended host to verify persistent credentials and identity storage. Confirm the host discovers the intended `lister/SKILL.md` path. A direct CLI success without host skill discovery is only a partial installation.

Report the host/profile, installed absolute path, source revision, selected environment/API origin, skill discovery result, and enrollment/read result. If waiting for private credential entry or passkey approval, state that exact remaining step; do not mark installation complete.

## Troubleshooting and maintenance

| Symptom | Agent action |
| --- | --- |
| Skill missing or wrong implementation selected | Inspect effective catalog, source precedence, allowlist and execution host; refresh/start a fresh task. Preserve other installations. |
| `dist/index.js` missing | Run `npm ci` in the complete repository with build dependencies enabled. |
| Key present in an operator terminal but missing in the task | Fix launcher/service/container injection; check with the redacted configuration command above. The client does not automatically load `.env` files. |
| Environment is pinned to production | Correct the host's non-secret `LISTER_ENVIRONMENT` setting to `staging`; do not bypass the pin. |
| Pending approval or installation mismatch | Use the same key and persistent config directory, and review the fingerprint in API Keys. |
| Invalid/expired/revoked key | Have the user configure a valid staging key privately. A replacement key is a new enrollment. |
| Lost/corrupt local identity | Preserve evidence; do not silently overwrite it. If unrecoverable, the owner revokes the old key and sets up a new key/installation. |
| Unsupported encrypted API or locked/stale content | Verify the staging origin and account readiness; report the error. Never use a plaintext fallback or weaken TLS. |

Keep source updates separate from credential changes. Preserve `LISTER_CONFIG_DIR` and its encrypted identity across updates and restarts. To remove access, revoke the installation's API key in MyLister. Removing only the skill folder does not revoke that key.
