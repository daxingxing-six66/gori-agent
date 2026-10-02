# Gori deployment profile v1

Store one profile per SSH host at `.gori/deploy-<host>.md`. YAML front matter is required.

```markdown
---
version: 1
project: example
target:
  host: example.org
  name: production
connection:
  profile: current-workspace
modules:
  - id: api
    name: API
    workdir: ./apps/api
    build:
      command: npm run build
      artifact: ./dist/api.tar.gz
    upload:
      target: /srv/api/api.tar.gz
    restart:
      command: systemctl restart api
    verify:
      command: systemctl is-active api
---

# Deployment notes
```

`target.host` must exactly equal the current Workspace hostname. `connection.profile` is a label only; Gori uses the current Workspace connection and never resolves credentials from this field. `target.name` and `verify` are optional. `modules` contains at least one unique `id`. `workdir` and `build.artifact` are relative paths within the current Session's local project directory. The artifact must be a regular file when deployment runs. `upload.target` is an absolute **file** path, including the filename. `build.command`, `restart.command`, and optional `verify.command` are literal commands shown to the user in the deployment plan before execution. Do not add secrets or alternative hosts.
