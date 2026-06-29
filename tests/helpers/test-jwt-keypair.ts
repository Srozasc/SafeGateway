import { generateKeyPair, exportJWK, SignJWT, JWK } from 'jose';

/**
 * Helper para generar un keypair RSA y firmar tokens JWT RS256 en tests.
 *
 * Uso:
 *   const kp = await generateTestKeypair('test-key-1');
 *   const token = await kp.signToken({ sub: 'user-1', iss: 'https://test.com' });
 *   // kp.publicJwk es el JWK público que se publica en el mock JWKS server
 */
export async function generateTestKeypair(kid: string): Promise<TestKeypair> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';

  return {
    kid,
    publicJwk,
    privateKey,
    async signToken(claims: Record<string, unknown>): Promise<string> {
      let builder = new SignJWT(claims as Record<string, unknown> & { [k: string]: unknown })
        .setProtectedHeader({ alg: 'RS256', kid });
      if (claims['iss']) {builder = builder.setIssuer(String(claims['iss']));}
      if (claims['aud']) {builder = builder.setAudience(String(claims['aud']));}
      if (claims['sub']) {builder = builder.setSubject(String(claims['sub']));}
      if (!claims['exp'] && !claims['nbf']) {
        builder = builder.setIssuedAt().setExpirationTime('2h');
      } else {
        if (claims['iat'] !== undefined) {builder = builder.setIssuedAt(Number(claims['iat']));}
        else if (claims['iat'] === undefined) {builder = builder.setIssuedAt();}
        if (claims['exp'] !== undefined) {builder = builder.setExpirationTime(Number(claims['exp']));}
      }
      return builder.sign(privateKey);
    },
  };
}

export interface TestKeypair {
  kid: string;
  publicJwk: JWK;
  privateKey: CryptoKey;
  signToken(claims: Record<string, unknown>): Promise<string>;
}