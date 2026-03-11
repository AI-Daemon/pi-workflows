# Wiki Authoring Guide

> **Who is this for?** Anyone contributing documentation to pi-workflows.
>
> **What you'll learn:** How to add, organise, and preview documentation that is automatically published to the GitHub Wiki.

## How the Wiki Sync Works

All documentation for pi-workflows lives in the `docs/` folder of the main repository. A GitHub Actions workflow (`.github/workflows/wiki-sync.yml`) watches for changes to that folder. Whenever a pull request that touches `docs/**` is merged into `main`, the workflow:

1. Clones the Wiki repository.
2. Copies every `*.md` file from `docs/` into the Wiki, translating the directory structure into a flat namespace.
3. Removes any Wiki pages whose source file no longer exists in `docs/` (only pages the workflow previously created — manually-authored Wiki pages are never touched).
4. Commits and pushes the changes to the Wiki.

The entire process is automatic. You never need to edit the Wiki directly.

## Adding a New Documentation Page

1. Create a new Markdown file inside `docs/`. For example:

   ```
   docs/my-new-guide.md
   ```

2. Open a pull request with your changes. The normal review process applies — your documentation goes through the same code review as any other change.

3. Once the PR is merged to `main`, the Wiki sync workflow runs and your page appears in the Wiki within a couple of minutes.

That's it. No extra steps required.

## File Naming Conventions

GitHub Wiki does not support subdirectories. The sync workflow flattens the `docs/` folder structure using a **double-dash (`--`) separator** to encode path segments.

| Source Path in Repo              | Wiki Page Name              |
| -------------------------------- | --------------------------- |
| `docs/foo.md`                    | `foo`                       |
| `docs/bar/baz.md`               | `bar--baz`                  |
| `docs/adr/001-decision.md`      | `adr--001-decision`         |
| `docs/deep/nested/page.md`      | `deep--nested--page`        |

### Rules

- Use lowercase filenames with hyphens for word separation (e.g., `workflow-authoring-guide.md`).
- Avoid spaces, uppercase letters, or special characters in filenames — they create awkward Wiki URLs.
- The double-dash `--` is reserved for encoding directory separators. Do not use `--` in regular filenames.

## Folder Notes

Sometimes you want a landing page for an entire subdirectory (e.g., an index page for `docs/adr/`). The sync workflow supports **folder notes** using two conventions:

| Source Path              | Wiki Page Name | Purpose                         |
| ------------------------ | -------------- | ------------------------------- |
| `docs/adr/_index.md`    | `adr`          | Landing page for the ADR section |
| `docs/adr/README.md`    | `adr`          | Same — alternative convention    |
| `docs/_index.md`         | `Home`         | Wiki home page                   |

Either `_index.md` or `README.md` works. Pick one convention per directory and stick with it. `_index.md` is preferred because it is more explicit and avoids confusion with the repository root `README.md`.

## Organising Subdirectories

Use subdirectories in `docs/` to group related pages:

```
docs/
  contributing.md
  wiki-guide.md
  architecture.md
  adr/
    _index.md              → Wiki page: "adr"
    001-zod-runtime.md     → Wiki page: "adr--001-zod-runtime"
    002-jexl-engine.md     → Wiki page: "adr--002-jexl-engine"
  guides/
    _index.md              → Wiki page: "guides"
    workflow-authoring.md  → Wiki page: "guides--workflow-authoring"
    expression-reference.md→ Wiki page: "guides--expression-reference"
```

There is no depth limit, but keep nesting shallow (2 levels max is recommended) for readability in both the repo and the Wiki.

## Previewing Documentation Locally

Since documentation is plain Markdown in the `docs/` folder, you can preview it with any Markdown viewer:

- **VS Code** — Open the file and press `Ctrl+Shift+V` (or `Cmd+Shift+V` on macOS) for a live preview.
- **GitHub** — Push your branch and browse `docs/` on GitHub. GitHub renders Markdown natively.
- **CLI** — Use tools like `glow` or `mdcat` to render Markdown in the terminal.

No special build step is needed. What you see in `docs/` is what will appear in the Wiki.

## Cross-Referencing Other Pages

When linking between documentation pages, use **relative links** that work in the `docs/` folder:

```markdown
See the [Contributing Guide](./contributing.md) for PR requirements.

For architecture decisions, see the [ADR index](./adr/_index.md).
```

These links work when browsing the repo on GitHub. The Wiki will resolve them through its own page lookup.

## What NOT to Do

> **⚠️ Do not edit the Wiki directly for synced pages.**

Any manual edits to Wiki pages that originated from `docs/` **will be overwritten** on the next sync. The workflow treats `docs/` as the single source of truth.

If you need to make a quick fix to documentation:

1. Edit the file in `docs/`.
2. Open a PR.
3. Merge it.

The Wiki will update automatically. This keeps all documentation changes in version control with full review history.

Pages that were created **manually** in the Wiki (i.e., not synced from `docs/`) are safe — the workflow tracks which pages it manages via a `.sync-manifest` file and never deletes pages it didn't create.

## Summary

| Task                        | How                                                        |
| --------------------------- | ---------------------------------------------------------- |
| Add a new doc page          | Create `docs/my-page.md`, open PR, merge                  |
| Add a folder landing page   | Create `docs/folder/_index.md`                             |
| Set the Wiki home page      | Create `docs/_index.md`                                    |
| Edit existing documentation | Edit the file in `docs/`, open PR, merge                   |
| Delete a doc page           | Delete the file from `docs/`, open PR, merge               |
| Preview locally             | Open the Markdown file in any viewer                       |
| Edit the Wiki directly      | **Don't** — changes will be overwritten on next sync       |
