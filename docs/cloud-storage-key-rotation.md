# Encryption key rotation for storage connections

Tokens in `knowledge_storage_connections` use `utils/encryption.ts` (AES-256-GCM).
Payloads carry a version byte: `0x02` = PBKDF2 key, `0x01`/untagged = legacy SHA-256.
`decrypt()` picks the derivation automatically from that byte.

## Rotation procedure

1. Add the new key as `ENCRYPTION_KEY_NEXT` in env (do not change `ENCRYPTION_KEY` yet).
2. Extend `getPbkdf2Key` with a `0x03` version that derives from `ENCRYPTION_KEY_NEXT`
   and re-encrypt-on-read: when a row decrypts under an old version, rewrite it with v3
   during the next token refresh (the shared token module already saves on refresh).
3. Wait one refresh cycle (access tokens expire within 1h; all active connections
   refresh within that window via the connections-list health probe).
4. Verify no rows still decrypt under v1/v2:
   `SELECT count(*) FROM knowledge_storage_connections WHERE access_token_enc NOT LIKE ...;`
   (spot-check by decrypting a sample row out of band).
5. Promote: `ENCRYPTION_KEY=$OLD_ENCRYPTION_KEY_NEXT`, remove `_NEXT`. Old versions stay
   supported for decryption only, so a straggler row keeps working until it refreshes.

Never rotate by replacing `ENCRYPTION_KEY` in place: rows encrypted under the old key
would fail GCM auth and every connection would show `reauthRequired`.
