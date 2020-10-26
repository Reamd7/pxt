import { loginCheck } from "./cloudsync";
import * as core from "./core";
import * as data from "./data";

import U = pxt.Util;

/**
 * Virtual API keys
 */
const MODULE = "auth";
const FIELD_USER = "user";
const FIELD_LOGGED_IN = "logged-in";
const FIELD_NEEDS_SETUP = "needs-setup";
export const USER = `${MODULE}:${FIELD_USER}`;
export const LOGGED_IN = `${MODULE}:${FIELD_LOGGED_IN}`;
export const NEEDS_SETUP = `${MODULE}:${FIELD_NEEDS_SETUP}`;

const CSRF_TOKEN = "csrf-token";
const AUTH_STATE = "auth-login-state";

export type UserProfile = {
    id?: string;
    idp?: pxt.IdentityProviderId;
    username?: string;
    avatarUrl?: string;
};

// TODO @darzu
export type UserPreferences = {
    language?: string;
    highContrast?: boolean;
};

/**
 * In-memory auth state. Changes to this state trigger virtual API subscription callbacks.
 */
export type State = {
    user?: UserProfile;
    preferences?: UserPreferences; // TODO @darzu
};

let state_: State = {};

/**
 * Read-only access to current state.
 */
export const getState = (): Readonly<State> => state_;

/**
 * During login, we store some state in local storage so we know where to
 * redirect after login completes. This is the shape of that state.
 */
type AuthState = {
    key: string;
    callbackLocation: string;
    idp: pxt.IdentityProviderId;
};

/**
 * Starts the process of authenticating the user against the given identity
 * provider. Upon success the backend will write an http-only session cookie
 * to the response, containing the authorization token. This cookie is not
 * accessible in code, but will be included in all subsequent http requests.
 * @param idp The id of the identity provider.
 * @param persistent Whether or not to remember this login across sessions.
 * @param callbackLocation The URL fragment to return to after authentication
 *  completes. This may include an optional hash and params.
 */
export async function loginAsync(idp: pxt.IdentityProviderId, persistent: boolean, callbackLocation: string) {
    if (!hasIdentity() || !idpEnabled(idp)) { return; }

    const state = getState();

    // See if we have a valid access token already.
    if (!state.user) {
        await fetchUserAsync();
    }

    const currIdp = state.user?.idp;

    // Check if we're already signed into this identity provider.
    if (currIdp === idp) {
        pxt.debug(`loginAsync: Already signed into ${idp}.`);
        return;
    }

    clearState();

    pxt.tickEvent('auth.login.start', { 'provider': idp });

    const genId = () => (Math.PI * Math.random()).toString(36).slice(2);
    const stateObj: AuthState = {
        key: genId(),
        callbackLocation,
        idp,
    };
    const stateStr = JSON.stringify(stateObj);

    pxt.storage.setLocal(AUTH_STATE, stateStr);

    // Redirect to the login endpoint.
    const loginUrl = core.stringifyQueryString(
        `${pxt.Cloud.getServiceUrl()}/auth/login`, {
        response_type: "token",
        provider: idp,
        persistent,
        redirect_uri: `${window.location.origin}/index.html?authcallback=1&state=${stateObj.key}`
    });

    window.location.href = loginUrl;
}

/**
 * Sign out the user and clear the auth token cookie.
 */
export async function logout() {
    if (!hasIdentity()) { return; }

    pxt.tickEvent('auth.logout');

    // backend will clear the cookie token and pass back the provider logout endpoint.
    await apiAsync('/api/auth/logout');

    // Clear csrf token so we can no longer make authenticated requests.
    pxt.storage.removeLocal(CSRF_TOKEN);

    // Update state and UI to reflect logged out state.
    clearState();

    // Redirect to home screen.
    window.location.href = window.location.origin;
}

/**
 * Checks to see if we're already logged in by trying to fetch user info from
 * the backend. If we have a valid auth token cookie, it will succeed.
 */
export async function authCheck() {
    if (!hasIdentity()) { return; }

    // Fail fast if we don't have csrf token.
    if (!pxt.storage.getLocal(CSRF_TOKEN)) { return; }

    // Optimistically try to fetch user profile. It will succeed if we have a valid
    // session cookie. Upon success, virtual api state will be updated, and the UI
    // will update accordingly.
    await fetchUserAsync();
}

export async function loginCallback(qs: pxt.Map<string>) {
    if (!hasIdentity()) { return; }

    let callbackLocation: string;

    do {
        // Read and remove auth state from local storage
        const stateStr = pxt.storage.getLocal(AUTH_STATE);
        if (!stateStr) {
            pxt.debug("Auth state not found in storge.");
            break;
        }
        pxt.storage.removeLocal(AUTH_STATE);

        const state: AuthState = JSON.parse(stateStr);
        if (typeof state !== 'object') {
            pxt.debug("Failed to parse auth state.");
            break;
        }

        const stateKey = qs['state'];
        if (!stateKey || state.key !== stateKey) {
            pxt.debug("Failed to get auth state for key");
            break;
        }

        callbackLocation = state.callbackLocation;

        const error = qs['error'];
        if (error) {
            // Possible values for 'error':
            //  'invalid_request' -- Something is wrong with the request itself.
            //  'access_denied'   -- The identity provider denied the request, or user canceled it.
            const error_description = qs['error_description'];
            pxt.tickEvent('auth.login.error', { 'error': error, 'provider': state.idp });
            pxt.log(`Auth failed: ${error}:${error_description}`);
            // TODO: Is it correct to clear continuation hash?
            callbackLocation = "";
            // TODO: Show a message to the user (via rewritten continuation path)?
            break;
        }

        const authToken = qs['token'];
        if (!authToken) {
            pxt.debug("Missing authToken in auth callback.")
            break;
        }

        // Store csrf token in local storage. It is ok to do this even when
        // "Remember me" wasn't selected because this token is not usable
        // without its cookie-based counterpart. When "Remember me" is false,
        // the cookie is not persisted.
        pxt.storage.setLocal(CSRF_TOKEN, authToken);

        pxt.tickEvent('auth.login.success', { 'provider': state.idp });
    } while (false);

    // Clear url parameters and redirect to the callback location.
    callbackLocation = callbackLocation ?? "";
    window.location.href = `/${callbackLocation}`;
}

export function identityProviders(): pxt.AppCloudProvider[] {
    return Object.keys(pxt.appTarget.cloud?.cloudProviders)
        .map(id => pxt.appTarget.cloud.cloudProviders[id])
        .filter(prov => prov.identity);
}

export function hasIdentity(): boolean {
    return identityProviders().length > 0;
}

export function loggedIn(): boolean {
    if (!hasIdentity()) { return false; }
    const state = getState();
    return !!state.user?.id;
}

export function profileNeedsSetup(): boolean {
    const state = getState();
    return loggedIn() && !state.user.username;
}

export async function updateUserProfile(opts: {
    username?: string,
    avatarUrl?: string
}) {
    if (!loggedIn()) { return; }
    const state = getState();
    const result = await apiAsync<UserProfile>('/api/user/profile', {
        id: state.user.id,
        username: opts.username,
        avatarUrl: opts.avatarUrl
    } as UserProfile);
    if (result.success) {
        // Set user profile from returned value
        setUser(result.resp);
    }
}

/**
 * Private functions
 */

async function fetchUserAsync() {
    const state = getState();

    // We already have a user, no need to get it again.
    if (state.user) { return; }

    const result = await apiAsync('/api/user/profile');
    if (result.success) {
        setUser(result.resp);
    }
}


export async function updateUserPreferencesAsync(newPref: Partial<UserPreferences>) {
    state_.preferences = { ...(state_.preferences || {}), ...newPref }
    data.invalidate("user-pref");

    if (!loggedIn()) { return; }

    // If the user is logged in, save to cloud
    const result = await apiAsync<UserPreferences>('/api/user/preferences', newPref);
    if (result.success) {
        console.log("updating userpref from POST")
        // Set user profile from returned value
        state_.preferences = { ...state_.preferences, ...result.resp }
        data.invalidate("user-pref");
    } else {
        console.error("fetch failed: ")
        console.dir(result);
    }
}

export async function fetchUserPreferencesAsync() {
    // TODO @darzu: 
    console.log("fetchUserPreferencesAsync")

    const result = await apiAsync<UserPreferences>('/api/user/preferences');
    if (result.success) {
        console.log("updating userpref from GET")
        // Set user profile from returned value
        state_.preferences = result.resp
        data.invalidate("user-pref");
    } else {
        console.error("fetch failed: ")
        console.dir(result);
    }
}


function idpEnabled(idp: pxt.IdentityProviderId): boolean {
    return identityProviders().filter(prov => prov.id === idp).length > 0;
}

function setUser(user: UserProfile) {
    const wasLoggedIn = loggedIn();
    state_.user = user;
    const isLoggedIn = loggedIn();
    const needsSetup = profileNeedsSetup();
    data.invalidate(USER);
    data.invalidate(LOGGED_IN);
    data.invalidate(NEEDS_SETUP);
    if (isLoggedIn && !needsSetup && !wasLoggedIn) {
        core.infoNotification(`Signed in: ${user.username}`);
    }
}

type ApiResult<T> = {
    resp: T;
    statusCode: number;
    success: boolean;
    errmsg: string;
};

async function apiAsync<T = any>(url: string, data?: any): Promise<ApiResult<T>> {
    const headers: pxt.Map<string> = {};
    const csrfToken = pxt.storage.getLocal(CSRF_TOKEN);
    if (csrfToken) {
        headers["authorization"] = `mkcd ${csrfToken}`;
    }
    return U.requestAsync({
        url,
        headers,
        data,
        method: data ? "POST" : "GET",
        withCredentials: true,  // Include cookies and authorization header in request, subject to CORS policy.
    }).then(r => {
        return {
            statusCode: r.statusCode,
            resp: r.json,
            success: Math.floor(r.statusCode / 100) === 2,
            errmsg: null
        }
    }).catch(e => {
        return {
            statusCode: e.statusCode,
            errmsg: e.message,
            resp: null,
            success: false
        }
    });
}

function authApiHandler(p: string) {
    const field = data.stripProtocol(p);
    const state = getState();
    switch (field) {
        case FIELD_USER: return state.user;
        case FIELD_LOGGED_IN: return loggedIn();
        case FIELD_NEEDS_SETUP: return profileNeedsSetup();
    }
    return null;
}

function clearState() {
    state_ = {};
    data.invalidate(USER);
    data.invalidate(LOGGED_IN);
    data.invalidate(NEEDS_SETUP);
}

function userPreferencesHandler(path: string): UserPreferences {
    if (!state_.preferences) {
        // TODO @darzu: what's the right way to handle defaults here?
        state_.preferences = {
            highContrast: false,
            language: "dz2",
        }
        fetchUserPreferencesAsync();
    }
    return state_?.preferences 
}

data.mountVirtualApi("auth", { getSync: authApiHandler });

console.log("mounting user-pref") // TODO @darzu: 
data.mountVirtualApi("user-pref", { getSync: userPreferencesHandler });