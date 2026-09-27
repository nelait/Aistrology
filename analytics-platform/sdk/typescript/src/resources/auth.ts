import type { Me, SignupRequest, SignupResponse, TokenPair } from "../types.js";
import { Resource, type CallOptions } from "./base.js";

export interface LoginParams {
  email: string;
  password: string;
  /** TOTP code, required when the account has MFA (`AuthenticationError.code === "mfa_required"`). */
  totp?: string;
}

export class AuthResource extends Resource {
  /** Create an organization and its first admin user. */
  signup(body: SignupRequest, options?: CallOptions): Promise<SignupResponse> {
    return this.http.request({ method: "POST", path: "/v1/auth/signup", body, auth: false, ...options });
  }

  /**
   * Log in with email and password (and TOTP). The returned tokens are stored on the client, used
   * for later calls and refreshed automatically; `onTokens` is notified.
   */
  async login(params: LoginParams, options?: CallOptions): Promise<TokenPair> {
    const body: Record<string, unknown> = { email: params.email, password: params.password };
    if (params.totp !== undefined) body.totp = params.totp;
    const pair = await this.http.request<TokenPair>({ method: "POST", path: "/v1/auth/login", body, auth: false, ...options });
    await this.http.acceptTokens(pair);
    return pair;
  }

  /** Force a token refresh now (normally automatic on 401). Refresh tokens rotate on every use. */
  refresh(): Promise<TokenPair> {
    return this.http.refresh();
  }

  /** Revoke the refresh token (the current one by default) and forget the stored tokens. */
  async logout(refreshToken?: string, options?: CallOptions): Promise<void> {
    const token = refreshToken ?? this.http.getTokens().refreshToken;
    try {
      if (token) {
        await this.http.request<void>({ method: "POST", path: "/v1/auth/logout", body: { refresh_token: token }, auth: false, ...options });
      }
    } finally {
      if (!refreshToken || refreshToken === this.http.getTokens().refreshToken) this.http.setTokens({});
    }
  }

  /** The authenticated principal (user or API key). */
  me(options?: CallOptions): Promise<Me> {
    return this.http.request({ method: "GET", path: "/v1/auth/me", ...options });
  }

  /** Start TOTP enrollment; show `otpauth_uri` as a QR code. */
  mfaSetup(options?: CallOptions): Promise<{ otpauth_uri: string }> {
    return this.http.request({ method: "POST", path: "/v1/auth/mfa/setup", ...options });
  }

  /** Confirm enrollment with a code from the authenticator app. */
  mfaActivate(code: string, options?: CallOptions): Promise<void> {
    return this.http.request({ method: "POST", path: "/v1/auth/mfa/activate", body: { code }, ...options });
  }
}
