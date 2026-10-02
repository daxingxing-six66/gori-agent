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
});
