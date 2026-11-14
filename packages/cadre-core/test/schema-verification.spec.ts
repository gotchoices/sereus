import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import {
  signSchema,
  verifySchema,
  assertSchemaSignature,
  SchemaVerificationError
} from '../src/schema-verification.js';
import type { SAppConfig } from '../src/types.js';

describe('schema-verification', () => {
  let authorPrivateKey: string;
  let authorPublicKey: string;
  const testSchema = 'table Chat (Id text primary key, Message text);';
  const testVersion = '1.0.0';
  const testSchemaVersion = 1;
  const signed = { schema: testSchema, version: testVersion, schemaVersion: testSchemaVersion };

  beforeEach(() => {
    authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  });

  describe('signSchema / verifySchema round-trip', () => {
    it('should produce a valid signature', () => {
      const sig = signSchema(signed, authorPrivateKey);
      expect(typeof sig).toBe('string');
      expect(sig.length).toBeGreaterThan(0);
      expect(verifySchema(signed, sig, authorPublicKey)).toBe(true);
    });

    it('should reject a tampered schema', () => {
      const sig = signSchema(signed, authorPrivateKey);
      const tampered = testSchema + ' -- injected';
      expect(verifySchema({ ...signed, schema: tampered }, sig, authorPublicKey)).toBe(false);
    });

    it('should reject a tampered version', () => {
      const sig = signSchema(signed, authorPrivateKey);
      expect(verifySchema({ ...signed, version: '2.0.0' }, sig, authorPublicKey)).toBe(false);
    });

    it('should reject a signature presented with a different schema version', () => {
      const sig = signSchema(signed, authorPrivateKey);
      expect(verifySchema({ ...signed, schemaVersion: 2 }, sig, authorPublicKey)).toBe(false);
    });

    it('should reject a signature from a different key', () => {
      const sig = signSchema(signed, authorPrivateKey);

      const otherPrivate = generatePrivateKey('ed25519', 'base64url') as string;
      const otherPublic = getPublicKey(otherPrivate, 'ed25519', 'base64url', 'base64url') as string;

      expect(verifySchema(signed, sig, otherPublic)).toBe(false);
    });

    it('should return false for malformed signature', () => {
      expect(verifySchema(signed, 'not-a-valid-signature', authorPublicKey)).toBe(false);
    });

    it('should return false for malformed public key', () => {
      const sig = signSchema(signed, authorPrivateKey);
      expect(verifySchema(signed, sig, 'bad-key')).toBe(false);
    });
  });

  describe('assertSchemaSignature', () => {
    it('should not throw for valid config', () => {
      const sig = signSchema(signed, authorPrivateKey);
      const config: SAppConfig = {
        id: authorPublicKey,
        version: testVersion,
        schemaVersion: testSchemaVersion,
        schema: testSchema,
        signature: sig
      };
      expect(() => assertSchemaSignature(config)).not.toThrow();
    });

    it('should throw SchemaVerificationError for invalid signature', () => {
      const config: SAppConfig = {
        id: authorPublicKey,
        version: testVersion,
        schemaVersion: testSchemaVersion,
        schema: testSchema,
        signature: 'invalid-signature'
      };
      expect(() => assertSchemaSignature(config)).toThrow(SchemaVerificationError);
      expect(() => assertSchemaSignature(config)).toThrow('invalid signature');
    });

    it('should throw missing signature when omitted under default (fail-closed) policy', () => {
      const config: SAppConfig = {
        id: authorPublicKey,
        version: testVersion,
        schemaVersion: testSchemaVersion,
        schema: testSchema,
      };
      expect(() => assertSchemaSignature(config)).toThrow(SchemaVerificationError);
      expect(() => assertSchemaSignature(config)).toThrow('missing signature');
    });

    it('should throw missing signature when empty string under default policy', () => {
      const config: SAppConfig = {
        id: authorPublicKey,
        version: testVersion,
        schemaVersion: testSchemaVersion,
        schema: testSchema,
        signature: '',
      };
      expect(() => assertSchemaSignature(config)).toThrow(SchemaVerificationError);
      expect(() => assertSchemaSignature(config)).toThrow('missing signature');
    });

    it('should skip verification when signature omitted and policy relaxed', () => {
      const config: SAppConfig = {
        id: authorPublicKey,
        version: testVersion,
        schemaVersion: testSchemaVersion,
        schema: testSchema,
      };
      expect(() => assertSchemaSignature(config, { requireSignature: false })).not.toThrow();
    });

    it('should still reject an invalid signature even when policy relaxed', () => {
      const config: SAppConfig = {
        id: authorPublicKey,
        version: testVersion,
        schemaVersion: testSchemaVersion,
        schema: testSchema,
        signature: 'invalid-signature',
      };
      expect(() => assertSchemaSignature(config, { requireSignature: false })).toThrow(SchemaVerificationError);
      expect(() => assertSchemaSignature(config, { requireSignature: false })).toThrow('invalid signature');
    });

    it.each([0, 1.5])('should refuse schemaVersion %s even when policy relaxed', (schemaVersion) => {
      const config: SAppConfig = {
        id: authorPublicKey,
        version: testVersion,
        schemaVersion,
        schema: testSchema,
      };
      expect(() => assertSchemaSignature(config, { requireSignature: false })).toThrow(SchemaVerificationError);
      expect(() => assertSchemaSignature(config, { requireSignature: false })).toThrow('invalid schemaVersion');
    });

    it('should throw SchemaVerificationError for missing author key', () => {
      const sig = signSchema(signed, authorPrivateKey);
      const config: SAppConfig = {
        id: '',
        version: testVersion,
        schemaVersion: testSchemaVersion,
        schema: testSchema,
        signature: sig
      };
      expect(() => assertSchemaSignature(config)).toThrow(SchemaVerificationError);
      expect(() => assertSchemaSignature(config)).toThrow('missing author public key');
    });

    it('should include sAppId and version in error', () => {
      const config: SAppConfig = {
        id: 'some-author-key',
        version: '3.0.0',
        schemaVersion: testSchemaVersion,
        schema: testSchema,
        signature: 'bad'
      };
      try {
        assertSchemaSignature(config);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(SchemaVerificationError);
        const err = e as SchemaVerificationError;
        expect(err.sAppId).toBe('some-author-key');
        expect(err.version).toBe('3.0.0');
      }
    });
  });
});
