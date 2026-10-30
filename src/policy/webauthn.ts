import crypto from 'crypto';

export interface WebAuthnCredential {
  credentialId: string;
  userId: string;
  publicKeyPem: string;
  algorithm: 'ES256' | 'Ed25519';
  signCount: number;
  createdAt: Date;
}

export interface WebAuthnChallengeRecord {
  challenge: string;
  userId: string;
  rpId: string;
  origin: string;
  expiresAt: number; // epoch ms
}

export interface WebAuthnAssertion {
  credentialId: string;
  clientDataJson: string;
  authenticatorData: Buffer;
  signature: Buffer;
  userHandle?: string;
}

export interface WebAuthnVerificationResult {
  verified: boolean;
  userId?: string;
  userPresent: boolean;
  userVerified: boolean; // Biometric or device PIN
  stepUpSessionId?: string;
  expiresInSeconds?: number;
  purpose?: string;
  error?: string;
  details?: {
    challengeMatch: boolean;
    originMatch: boolean;
    rpIdMatch: boolean;
    signatureMatch: boolean;
    userVerificationMatch: boolean;
  };
}

// In-memory challenge store (in production backed by Redis / PostgreSQL)
const challengeStore = new Map<string, WebAuthnChallengeRecord>();

/**
 * Generates a high-entropy FIDO2 / WebAuthn cryptographic challenge.
 */
export function generateWebAuthnChallenge(
  userId: string,
  rpId: string = 'commerce.manifest.internal',
  origin: string = 'https://commerce.manifest.internal'
): WebAuthnChallengeRecord {
  const challenge = crypto.randomBytes(32).toString('base64url');
  const record: WebAuthnChallengeRecord = {
    challenge,
    userId,
    rpId,
    origin,
    expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes TTL
  };
  challengeStore.set(challenge, record);
  return record;
}

/**
 * Cryptographically verifies a WebAuthn / Passkey assertion ceremony.
 * 
 * Verifications performed:
 * 1. Challenge match and expiration check.
 * 2. Relying Party ID (rpIdHash) match against authenticatorData[0..32].
 * 3. User Presence flag (bit 0 = 0x01) and User Verification flag (bit 2 = 0x04) in authenticatorData[32].
 * 4. SHA-256 clientDataHash computation from clientDataJSON.
 * 5. Asymmetric cryptographic signature verification over (authenticatorData || clientDataHash).
 */
export function verifyWebAuthnPasskeyCeremony(
  assertion: WebAuthnAssertion,
  expectedChallenge: string,
  credential: WebAuthnCredential,
  expectedRpId: string = 'commerce.manifest.internal',
  expectedOrigin: string = 'https://commerce.manifest.internal'
): WebAuthnVerificationResult {
  const challengeRecord = challengeStore.get(expectedChallenge);
  if (!challengeRecord || challengeRecord.expiresAt < Date.now()) {
    return {
      verified: false,
      userPresent: false,
      userVerified: false,
      error: 'EXPIRED_OR_INVALID_CHALLENGE',
      details: {
        challengeMatch: false,
        originMatch: false,
        rpIdMatch: false,
        signatureMatch: false,
        userVerificationMatch: false
      }
    };
  }

  // Parse Client Data JSON
  let clientData: any;
  try {
    clientData = JSON.parse(assertion.clientDataJson);
  } catch {
    return {
      verified: false,
      userPresent: false,
      userVerified: false,
      error: 'INVALID_CLIENT_DATA_JSON'
    };
  }

  const challengeMatch = clientData.challenge === expectedChallenge;
  const originMatch = clientData.origin === expectedOrigin || clientData.origin === challengeRecord.origin;

  if (!challengeMatch || !originMatch) {
    return {
      verified: false,
      userPresent: false,
      userVerified: false,
      error: !challengeMatch ? 'CHALLENGE_MISMATCH' : 'ORIGIN_MISMATCH',
      details: {
        challengeMatch,
        originMatch,
        rpIdMatch: false,
        signatureMatch: false,
        userVerificationMatch: false
      }
    };
  }

  // Verify Authenticator Data (minimum 37 bytes)
  const authData = assertion.authenticatorData;
  if (authData.length < 37) {
    return {
      verified: false,
      userPresent: false,
      userVerified: false,
      error: 'INVALID_AUTHENTICATOR_DATA_LENGTH'
    };
  }

  const rpIdHash = authData.subarray(0, 32);
  const expectedRpIdHash = crypto.createHash('sha256').update(expectedRpId).digest();
  const rpIdMatch = crypto.timingSafeEqual(rpIdHash, expectedRpIdHash);

  const flags = authData[32];
  const userPresent = (flags & 0x01) !== 0; // Bit 0: User Present (UP)
  const userVerified = (flags & 0x04) !== 0; // Bit 2: User Verified (UV - Biometrics / PIN)

  if (!rpIdMatch || !userPresent || !userVerified) {
    return {
      verified: false,
      userPresent,
      userVerified,
      error: !rpIdMatch ? 'RP_ID_MISMATCH' : !userPresent ? 'USER_NOT_PRESENT' : 'USER_NOT_VERIFIED',
      details: {
        challengeMatch: true,
        originMatch: true,
        rpIdMatch,
        signatureMatch: false,
        userVerificationMatch: userVerified
      }
    };
  }

  // Verify Asymmetric Signature over (authenticatorData || SHA-256(clientDataJSON))
  const clientDataHash = crypto.createHash('sha256').update(assertion.clientDataJson).digest();
  const signedPayload = Buffer.concat([authData, clientDataHash]);

  let signatureMatch = false;
  try {
    if (credential.algorithm === 'ES256') {
      const verifier = crypto.createVerify('SHA256');
      verifier.update(signedPayload);
      signatureMatch = verifier.verify(credential.publicKeyPem, assertion.signature);
    } else {
      signatureMatch = crypto.verify(null, signedPayload, credential.publicKeyPem, assertion.signature);
    }
  } catch (err: any) {
    signatureMatch = false;
  }

  // Consume challenge
  challengeStore.delete(expectedChallenge);

  if (!signatureMatch) {
    return {
      verified: false,
      userPresent,
      userVerified,
      error: 'INVALID_AUTHENTICATOR_SIGNATURE',
      details: {
        challengeMatch: true,
        originMatch: true,
        rpIdMatch: true,
        signatureMatch: false,
        userVerificationMatch: true
      }
    };
  }

  const stepUpSessionId = `stepup_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

  return {
    verified: true,
    userId: challengeRecord.userId,
    userPresent: true,
    userVerified: true,
    stepUpSessionId,
    expiresInSeconds: 300, // 5 minutes
    purpose: 'CREATE_AUTONOMOUS_DELEGATION',
    details: {
      challengeMatch: true,
      originMatch: true,
      rpIdMatch: true,
      signatureMatch: true,
      userVerificationMatch: true
    }
  };
}

/**
 * Creates a valid synthetic WebAuthn assertion ceremony for automated testing and verifiable demo.
 */
export function createSyntheticWebAuthnAssertion(
  userId: string,
  rpId: string = 'commerce.manifest.internal',
  origin: string = 'https://commerce.manifest.internal'
): {
  challenge: string;
  assertion: WebAuthnAssertion;
  credential: WebAuthnCredential;
  privateKeyPem: string;
} {
  const { challenge } = generateWebAuthnChallenge(userId, rpId, origin);

  // Generate real Ed25519 passkey keypair
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const credential: WebAuthnCredential = {
    credentialId: `cred_passkey_${crypto.randomBytes(16).toString('hex')}`,
    userId,
    publicKeyPem,
    algorithm: 'Ed25519',
    signCount: 1,
    createdAt: new Date()
  };

  const clientDataJson = JSON.stringify({
    type: 'webauthn.get',
    challenge,
    origin,
    crossOrigin: false
  });

  const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
  const flags = Buffer.from([0x01 | 0x04]); // UP (0x01) + UV (0x04)
  const signCountBuf = Buffer.alloc(4);
  signCountBuf.writeUInt32BE(1, 0);

  const authenticatorData = Buffer.concat([rpIdHash, flags, signCountBuf]);
  const clientDataHash = crypto.createHash('sha256').update(clientDataJson).digest();
  const signedData = Buffer.concat([authenticatorData, clientDataHash]);

  const signature = crypto.sign(null, signedData, privateKeyPem);

  const assertion: WebAuthnAssertion = {
    credentialId: credential.credentialId,
    clientDataJson,
    authenticatorData,
    signature,
    userHandle: userId
  };

  return {
    challenge,
    assertion,
    credential,
    privateKeyPem
  };
}
