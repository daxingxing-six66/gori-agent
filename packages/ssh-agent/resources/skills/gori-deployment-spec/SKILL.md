---
name: gori-deployment-spec
description: Create a Gori deployment profile for the current project and Workspace SSH host when /deploy finds no matching profile.
---

# Create a Gori deployment profile

Use this skill only to prepare a profile. Do not build, upload, restart, or deploy while creating it.

1. Inspect the current local project for modules, build scripts, and file artifacts. Read existing deployment notes if present. Never infer a remote restart command or upload destination from a package name alone.
2. The profile must target the **current Workspace SSH host** shown in the Run context. Do not choose another host or copy credentials into the profile. If the host is unavailable, stop and explain what is missing.
3. Use `ask_user_decision` for choices that cannot be established from project files: deployable module, exact local build command or artifact, remote absolute file destination, restart command, and optional verification command. Each question must have exactly three mutually exclusive suggestions and a recommended index; the user can enter their own answer or skip. Treat skip as unresolved, never as consent.
4. Show the proposed profile with all commands and paths. Ask for an explicit final decision to save it. Do not write the file unless the user chooses the save option. A decision to save does not authorize deployment.
5. Save `.gori/deploy-<host>.md` under the current project root. If that name already exists, ask before replacing it. Keep other profiles. Use the YAML front matter in [profile-schema.md](references/profile-schema.md), followed by optional human notes. Never store passwords, keys, tokens, or SSH options in the file.
6. Validate the written file against the schema and report the path. Explain that the user should invoke `/deploy` again to review and start the pipeline.

The first version of the deployment runtime uploads **one regular file** per module. If the build produces a directory, ask the user for an existing command that packages it into a file and record that file as `build.artifact`. Do not silently pick an archive format or run extra packaging commands.
