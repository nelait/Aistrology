package com.analyticsplatform.sdk

/**
 * Where the user session lives between app launches. Refresh tokens rotate on every refresh, so the store
 * is written after login and after every refresh; a stale refresh token is rejected by the server.
 *
 * On Android, back it with EncryptedSharedPreferences / DataStore + Keystore; never plain SharedPreferences.
 */
public interface TokenStore {
    public suspend fun load(): Tokens?

    /** Persist [tokens], or clear the session when `null` (logout, or a refresh token was rejected). */
    public suspend fun save(tokens: Tokens?)
}

/** Keeps the session in memory only (the default): the user logs in again after a restart. */
public class InMemoryTokenStore(initial: Tokens? = null) : TokenStore {
    @Volatile private var tokens: Tokens? = initial

    override suspend fun load(): Tokens? = tokens

    override suspend fun save(tokens: Tokens?) {
        this.tokens = tokens
    }
}
