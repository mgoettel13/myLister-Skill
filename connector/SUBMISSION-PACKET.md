# MyLister.dev Submission Packet

Draft prepared 2026-09-09. Not submitted or published. Owner approval is required
for publisher identity, legal attestations, reviewer access and public availability.

## Listing Copy

| Field | Value |
| --- | --- |
| Display name | MyLister.dev |
| Category | Productivity |
| Short description | Lists, projects, and shared notes in MyLister.dev. |
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

- Sign in at https://platform.openai.com/plugins; verify publisher identity and role.
- Provide approved public privacy, terms and support URLs and permitted regions.
- Supply reviewer access and approve any production fixture/email testing.
- Resolve the two newer comment findings and complete remaining regression coverage.
- Complete the exact OpenAI domain challenge if issued, scan tools, upload skills,
  review the draft and authorize submission. Publication follows approval separately.

No submission form has been created or attested by this agent.
Source: [OpenAI submission guide](https://developers.openai.com/plugins/deploy/submission).
