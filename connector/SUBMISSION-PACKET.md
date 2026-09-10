# MyLister.dev Submission Packet

Draft created in the OpenAI portal 2026-09-10. Not submitted or published. Owner approval is required
for publisher identity, legal attestations, reviewer access and public availability.

## Listing Copy

| Field | Value |
| --- | --- |
| Display name | MyLister.dev |
| Category | Productivity |
| Short description | Lists, projects, and notes |
| Description | Connect your MyLister.dev account to manage tasks, projects, journal entries, notes, priorities, comments, sharing, sending, reminders, and attachments. Your existing account and shared-list permissions apply. |
| Website | https://mylister.dev |
| MCP URL | https://mcp.mylister.dev/mcp |
| URL type | Universal |
| Authentication | OAuth authorization code with PKCE; scope `mylister`. No API key entered in chat. |
| Logo | plugins/mylister-production/assets/logo.png (repository root) |
| Skill | plugins/mylister-production/skills/mylister/SKILL.md |
| Privacy, terms, support | Owner-approved public URLs still required. |
| Developer identity | Must be selected from the publisher's verified OpenAI organization. |
| Countries/regions | Owner decision required. |

Starter prompts:
- What are my priority items?
- Add Call Mama to my Today list.
- Create a project for my next launch.

Initial-release notes: MyLister.dev adds account-connected task, notebook, project,
collaboration and file workflows through a production MCP endpoint. Authorization
uses dedicated integration credentials and excludes private account management and
API-key creation. The standalone API-key skill remains a separate installation.

## Bundles

From the repository root, use PowerShell 7:

```powershell
./connector/scripts/package-production.ps1 -OutputDirectory /path/to/new-output
```

This generates a complete plugin ZIP and a skill-only ZIP. The packager includes
dotfiles, whitelists only the four needed plugin files, verifies every archive
entry's SHA-256 against its source, and refuses to overwrite existing bundles.
The skill ZIP contains `mylister/SKILL.md`; upload it for the skills-plus-MCP draft.
The complete local plugin ZIP is not a replacement for entering/scanning the MCP
endpoint in the portal.

2026-09-09 bundle hashes (version `0.1.0-rc.1`):

```text
0E84DDE439EF0DAB6C8604B0479AED38DAD223B021A4F878B9EF5C1BD2B30800  mylister-production-0.1.0-rc.1.zip
34ABAE7B04A095B3214304D2196EE0718E51F618CEFAE78ACAACF559278BC7BA  mylister-skills-0.1.0-rc.1.zip
```

## Reviewer Preparation

Use [PRODUCTION-REVIEWER-CASES.md](tests/PRODUCTION-REVIEWER-CASES.md) for five
positive and three negative cases. Cases are a plan until actual results are
recorded. Supply a dedicated fixture account in the portal, never in GitHub.
It must work without email OTP, SMS or MFA; do not weaken normal user accounts.

The [annotation review](TOOL-ANNOTATIONS.md) explains every tool category and is
backed by exact-name coverage tests plus deployed metadata comparison.
The [readiness record](PRODUCTION-READINESS.md) distinguishes live checks from
unfinished coverage. Neither bundle generation nor portal tool scan proves release readiness.

## Owner Sign-Off

- Review the selected verified publisher identity in the saved draft.
- Provide approved public privacy, terms and support URLs and permitted regions.
- Supply reviewer access and approve any production fixture/email testing.
- Resolve the two newer comment findings and complete remaining regression coverage.
- Complete the exact OpenAI domain challenge if issued, scan tools, upload skills,
  review the draft and authorize submission. Publication follows approval separately.

The submission draft has been created; no legal attestations or submission have
been made by this agent.
Source: [OpenAI submission guide](https://developers.openai.com/plugins/deploy/submission).

## Portal Check (2026-09-09)

The internal browser is now signed in, with project `MyLister.dev` selected under
the `Personal` organization. Selecting Create plugin > With MCP displays
`Complete identity verification` and blocks draft creation. The organization
settings page offers Individual and Business verification, both with Start buttons.
Neither verification flow was started by the agent; no identity documents, legal
attestations, account changes, or submission uploads were provided.

The owner must choose the intended publisher identity (and organization, if this
is not the intended one) and complete verification. Once verified, resume creation
of the MCP-backed draft, upload the prepared skill, and obtain the actual domain
challenge. Publisher role and domain verification are not established by sign-in.

## Saved Portal Draft (2026-09-10)

This supersedes the identity-verification gate in the historical check above.
The owner completed verification; the draft uses the verified Individual identity
in the Personal organization with project MyLister.dev selected.

- [Open the draft](https://platform.openai.com/plugins/edit/asdk_app_6aa290be8fbc81918c133a767a2accb1/asdk_app_v_6aa290c024708191bf0cc110d73a0d34?section=App%20Info).
- Listing name, subtitle, description, Productivity category, website, verified
  author, three starter prompts, and initial-release notes are saved.
- Portal version is `0.1.0`: the form rejected `0.1.0-rc.1`. Local packages and
  installed plugins remain `0.1.0-rc.1`; no release was published or rebuilt.
- Directory and composer icons were uploaded from the existing UI repository's
  `public/mylister-logo-512.png`. The packaged 180px icon is below the directory's
  256px minimum. Both uploaded icons were read back in the portal.
- The skill-only ZIP listed above was uploaded. Its safety scan shows **Passed**.
- MCP URL `https://mcp.mylister.dev/mcp` and OAuth are saved. Metadata discovery
  works; enterprise domain restrictions are unavailable, as expected.
- Tool scanning requests a new OAuth authorization. It was canceled pending
  explicit owner approval; no new grant or tool scan was completed.
- Domain verification remains incomplete. The issued token is visible on the
  draft's MCP page and must be served at
  `https://mcp.mylister.dev/.well-known/openai-apps-challenge` before verification.
  No connector deployment or challenge publication was performed in this session.
- Five positive and three non-invocation negative cases are drafted. They describe
  expected behavior, not completed production reviewer-account results.
- Reviewer credentials, approved privacy/terms/support URLs, and a demo recording
  URL remain blank. Do not use a real user's personal account as reviewer access.
- Country availability is the portal's unchanged **Allow all** default and still
  requires owner review. All policy attestations remain unchecked.

Draft autosave and field readback do not establish production acceptance or
submission readiness. Complete the outstanding regression and reviewer checks in
[PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) before submission.
