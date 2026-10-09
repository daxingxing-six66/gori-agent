# Gori deployment profile v2

Store one profile per SSH host at `.gori/deploy-<host>.md`. YAML front matter is required. Prefer v2 for new profiles:

```markdown
---
version: 2
project: example
target:
  host: example.org
  name: production
connection:
  profile: current-workspace
modules:
  - id: api
    name: API
    workdir: .
    build:
      instructions: >-
        Inspect Git changes and module dependencies. Build the modules needed
        for this release with the project's existing Maven workflow.
    upload:
      allowedDirectories:
        - /srv/api/lib
        - /srv/api/app
    restart:
      instructions: >-
        Restart the API using the documented service command after all selected
        artifacts have uploaded.
    verify:
      instructions: >-
        Check the API service status and health endpoint.
---

# Deployment notes
```

`target.host` must equal the current Workspace hostname. `connection.profile` is a display label only; Gori uses the Workspace connection and does not look up credentials by this field. `target.name` and `verify` are optional. `modules` contains 1–50 unique lowercase IDs. `workdir` is relative to the current Session's local project root. `upload.allowedDirectories` contains 1–16 distinct, normalized absolute **directories**, not artifact filenames. They must be usable within the Workspace remote directory. Build, restart, and optional verification instructions are nonempty reference text, not commands that the profile parser executes. Never put secrets or alternative hosts in the profile.

The profile gives the model stable service, host, build, and deployment knowledge. When `/deploy` is invoked, a separate planning Run inspects the **current** project and Git changes and proposes exact `buildSteps`, 1–16 regular-file artifacts with local sources and remote targets, and exact restart/optional verification commands. The artifact set may differ between releases. Gori validates paths and target identity, displays the complete proposal, and waits for user confirmation and separate Full Access approvals for each remote command. The model's proposal alone does not authorize execution. Remote commands start from `/`; include an explicit `cd` in a proposed command when needed. Workspace Guard still checks remote commands, and uploads remain constrained to the profile's allowed directories and the Workspace remote directory.

Existing v1 profiles remain readable. A v1 module has `build: { command, artifact }`, `upload: { target }`, `restart: { command }`, and optional `verify: { command }`; its upload target's parent directory is the allowed directory for a model-proposed release plan. The v1 fields provide defaults and knowledge for planning, while the approved release plan still freezes the exact commands, artifacts, and destinations used by that run. Do not change an existing v1 profile merely to satisfy this v2 recommendation.
