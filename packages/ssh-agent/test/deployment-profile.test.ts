import { describe, expect, it } from "vitest";
import { parseDeploymentProfile } from "../src/domain/deployment.ts";

const profile = `---
version: 1
project: test
target:
  host: example.org
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
# Human notes are not executable
`;

const knowledgeProfile = `---
version: 2
project: test
target:
  host: example.org
connection:
  profile: current-workspace
modules:
  - id: api
    name: API
    workdir: .
    build:
      instructions: Build the changed Maven modules and verify dependent artifacts.
    upload:
      allowedDirectories:
        - /srv/api/lib
        - /srv/api/app
    restart:
      instructions: Restart the API after uploading all selected artifacts.
    verify:
      instructions: Confirm the API is healthy.
---
`;

describe("deployment profile", () => {
	it("reads strict YAML front matter and ignores human notes", () => {
		expect(parseDeploymentProfile(profile)).toMatchObject({
			version: 1, target: { host: "example.org" },
			modules: [{ id: "api", build: { artifact: "./dist/api.tar.gz" }, upload: { target: "/srv/api/api.tar.gz" } }],
		});
	});

	it("rejects ambiguous and unsafe profile fields", () => {
		expect(() => parseDeploymentProfile(profile.replace("version: 1", "version: 1\nversion: 1"))).toThrow();
		expect(() => parseDeploymentProfile(profile.replace("./apps/api", "../../other"))).toThrow();
		expect(() => parseDeploymentProfile(profile.replace("/srv/api/api.tar.gz", "/srv/api/../secret"))).toThrow();
		expect(() => parseDeploymentProfile(profile.replace("  profile: current-workspace", "  profile: current-workspace\n  password: secret"))).toThrow();
		expect(() => parseDeploymentProfile(profile.replace("  - id: api", "  - id: api\n    id: api"))).toThrow();
	});

	it("reads v2 deployment knowledge without freezing this release's artifacts", () => {
		expect(parseDeploymentProfile(knowledgeProfile)).toMatchObject({
			version: 2,
			modules: [{
				id: "api",
				build: { instructions: "Build the changed Maven modules and verify dependent artifacts." },
				upload: { allowedDirectories: ["/srv/api/lib", "/srv/api/app"] },
				restart: { instructions: "Restart the API after uploading all selected artifacts." },
			}],
		});
	});

	it("rejects unsafe or oversized v2 upload directories and executable v1 fields", () => {
		expect(() => parseDeploymentProfile(knowledgeProfile.replace("/srv/api/lib", "/srv/api/../secret"))).toThrow();
		expect(() => parseDeploymentProfile(knowledgeProfile.replace("/srv/api/app", "/srv/api/lib"))).toThrow();
		const tooManyDirectories = knowledgeProfile.replace("        - /srv/api/app", [
			"        - /srv/api/app",
			...Array.from({ length: 15 }, (_, index) => `        - /srv/api/extra-${index}`),
		].join("\n"));
		expect(() => parseDeploymentProfile(tooManyDirectories)).toThrow("1 to 16 directories");
		expect(() => parseDeploymentProfile(knowledgeProfile.replace("      instructions: Build", "      command: mvn package\n      instructions: Build"))).toThrow();
		expect(() => parseDeploymentProfile(knowledgeProfile.replace("      allowedDirectories:\n", "      target: /srv/api/app.jar\n      allowedDirectories:\n"))).toThrow();
	});
});
