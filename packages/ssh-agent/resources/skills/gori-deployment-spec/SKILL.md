---
name: gori-deployment-spec
description: Create a Gori deployment profile for the current project and Workspace SSH host when /deploy finds no matching profile.
---

# Create a Gori deployment profile

Use this skill only to prepare reusable deployment knowledge. Do not build, upload, restart, verify, or start a deployment while creating the profile.

1. Inspect the local project, build scripts, module dependencies, and existing deployment notes. Identify the service the user intends to deploy and the directories where its artifacts may be uploaded. Do not infer a remote location or restart procedure from a package name alone.
2. Bind the profile to the **current Workspace SSH host** shown in the Run context. Do not choose another host or include credentials, secrets, or SSH connection options. If the host is unavailable, explain what is missing.
3. Use `ask_user_decision` for unresolved choices: deployable service, reusable build procedure, allowed remote upload directories, restart procedure, and optional verification procedure. Each question has exactly three mutually exclusive suggestions and a recommended index; free input and skip remain available. A skip leaves the item unresolved, never approved.
4. Prefer the v2 schema in [profile-schema.md](references/profile-schema.md). Record procedures as `instructions` and upload boundaries as `allowedDirectories`. These describe what the model should inspect and propose **for each release**; do not freeze the jars, exact build commands, or exact remote commands for every future deployment. Keep an existing valid v1 profile compatible unless the user wants to migrate it.
5. Show the complete proposed profile and ask for an explicit final decision to save it. Saving a profile does not authorize a deployment or Full Access command.
6. Save `.gori/deploy-<host>.md` under the current project root. If the file already exists, ask before replacing it and preserve other profiles. Use YAML front matter followed by optional human notes; never put passwords, keys, or tokens in either section.
7. Validate the saved file against the schema and report its path. Explain that `/deploy` will inspect the current changes, propose this release's exact build steps, artifact list, destinations, and remote commands, then wait for the user's review before execution.

Only regular files can be uploaded. If a service produces a directory, record the packaging procedure in `build.instructions` so the future planning Run can propose a specific command and output file for the user to review. Do not silently choose an archive format or execute packaging while creating the profile.
