# MyLister skill

One generic API client and skill for Dot, OpenClaw, Codex, and other hosts supporting SKILL.md. It manages MyLister content and encrypts/decrypts on the computer running the skill.

## Install

Requires Node.js 22.13 or later.

```sh
git clone https://github.com/mgoettel13/MyLister-Skill.git
cd MyLister-Skill
npm ci
```

The prepare script builds the client. Install this complete folder in your host's configured skills directory. Copying SKILL.md alone does not install the executable. For OpenClaw, use the skills directory configured for that instance. Dot uses local skills through its connected computer, which must be online with the ChatGPT app running. See [official Dot documentation](https://learn.chatgpt.com/docs/dots).

## Staging setup

1. Create a separate API key for this installation in MyLister Settings > API Keys.
2. Set LISTER_STAGING_API_KEY through the host's secret/environment settings. Keep keys out of chat, command arguments, and this repository.
3. Run:

```sh
node dist/index.js switch to staging
node dist/index.js setup encryption
```

4. Open the returned MyLister approval link, compare the installation fingerprint, and approve encrypted access with your passkey.
5. Check:

```sh
node dist/index.js show connection status
node dist/index.js get my lists
```

Encrypted setup requires the matching MyLister API release. Staging API: https://lister-api-public-staging.up.railway.app. Staging app: https://listerbeta.up.railway.app.

The installation inherits all account content access, including future content. Existing shared-list read/edit permissions remain enforced. Give Dot and OpenClaw separate API keys so either can be revoked independently.

## Encryption and storage

Setup generates a P-256 key pair. The private key is encrypted locally with an API-key-derived key and bound to the API origin. MyLister receives the public key and, after approval, stores an account-key envelope encrypted for this installation. The client opens it locally and uses the browser-compatible list-key/content formats.

New lists include an owner account-key envelope, making them readable by the app and other authorized installations. Keys are used in memory. The agent receives the readable content needed for the request; keys never need to enter the conversation.

This reuses MyLister's existing account root and recovery model, including its server-assisted recovery. It does not replace account recovery or make a new claim that the server can never recover the root.

Private configuration defaults to %LOCALAPPDATA%\MyListerSkill on Windows, or ${XDG_CONFIG_HOME:-~/.config}/mylister-skill on Linux/macOS. LISTER_CONFIG_DIR can override it. Revoking the API key blocks future API access. A key alone on another host is not a replacement for the enrolled local identity; run setup with a separate key.

## Configuration

| Variable | Purpose |
| --- | --- |
| LISTER_STAGING_API_KEY | Staging credential |
| LISTER_PRODUCTION_API_KEY | Separate production credential |
| LISTER_ENVIRONMENT | Optional explicit host pin: staging, production, custom |
| LISTER_STAGING_BASE_URL | Trusted staging origin override |
| LISTER_PRODUCTION_BASE_URL | Trusted production origin override |
| LISTER_BASE_URL | Trusted custom origin or legacy default |
| LISTER_API_KEY | Legacy key bound to LISTER_BASE_URL, or production |
| LISTER_CONFIG_DIR | Settings and encrypted identity location |
| LISTER_CONTACTS | Optional JSON name-to-email aliases |

Selected environments persist across separate CLI calls. An explicit LISTER_ENVIRONMENT pins the host and overrides saved selection. Production defaults to https://api.mylister.dev. Staging never inherits a production key. Custom origins must be configured explicitly. Requests require HTTPS and do not follow redirects.

## Use

```sh
node dist/index.js add "Call Mama" to my Today list
node dist/index.js create notebook list Journal
node dist/index.js create project list Launch
node dist/index.js get priority items
node dist/index.js search for meeting
node dist/index.js mark item 0123456789abcdef01234567 done
node dist/index.js email my Shopping list to Sarah
```

Send and email are aliases. "To me" uses the current account. Named recipients use actual contact information or configured aliases; ambiguous names are not guessed. Sending a copy is separate from granting shared-list membership. A successful email response means API acceptance, not confirmed delivery.

```ts
import { handleCommand } from './dist/index.js';
const result = await handleCommand('get priority items');
```

Agent hosts can translate natural requests into the parser's syntax. Commands also cover list/item edits and deletion, notes/comments, reminders, ordering, sharing, exports, attachments, and media. Permission and security failures never trigger a plaintext fallback.

Current encrypted-client limits: changing an existing list's type, generating legacy file URLs, voice transcription, and voice duration metadata are not supported. Create notebooks/projects with the desired type. Encrypted sharing requires the recipient to accept the key transfer in MyLister. Older media without stable encryption bindings cannot be moved safely. Reads beyond the raw API's pagination ceiling stop with an explicit error rather than returning a partial list. HTML exports use a basic escaped layout rather than the app's full themed presentation.

## Development

```sh
npm ci
npm test
npm pack --dry-run
```

Tests use synthetic keys, isolated temporary directories, and mocked HTTP. Do not target a real user's account. This skill is independent of the MyLister OAuth/Codex plugin.
