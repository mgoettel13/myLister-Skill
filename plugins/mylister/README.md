# MyLister.dev Codex plugin (staging)

This package connects Codex to a MyLister staging account through OAuth. It does
not need an API key in Codex and does not replace the repository's standalone skill.

MCP endpoint: `https://mylister-connector-staging.up.railway.app/mcp`.
The service is under active staging validation; it is not a production release.

Install this directory through a local Codex marketplace for testing. Connect the
MyLister MCP server when prompted, sign in to your staging MyLister account, and
approve the full-app grant. Disconnect under MyLister Settings > API Keys > Connected apps.

Try:

- Add "Call Mama" to my Today list.
- Make "Call mama" in Today a priority.
- What are my priority items?
- Add a comment to a shared item or to one of its notes.
- Create a project and add a task with initial notes.

The deployment and production-release checklist lives in `../../connector/README.md`.
