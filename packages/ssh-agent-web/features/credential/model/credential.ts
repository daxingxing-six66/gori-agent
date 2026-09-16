interface CredentialBase {
	id: string;
	workspaceId: string;
	displayName: string;
	remoteUser: string;
	authVersion: number;
	revision: number;
	createdAt: number;
	updatedAt: number;
}

export type Credential =
	| (CredentialBase & {
			type: "private_key";
			publicKeyFingerprint?: string;
			hasPassphrase: boolean;
	  })
	| (CredentialBase & { type: "password" });

export type CreateCredentialInput =
	| {
			displayName: string;
			remoteUser: string;
			type: "private_key";
			privateKey: string;
			passphrase?: string;
	  }
	| {
			displayName: string;
			remoteUser: string;
			type: "password";
			password: string;
	  };

export interface WorkspaceCredential {
	workspaceId: string;
	workspaceRevision: number;
	credential: Credential;
}

export interface WorkspaceCredentials {
	workspaceId: string;
	activeCredentialId: string;
	workspaceRevision: number;
	credentials: Credential[];
}
