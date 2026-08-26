/**
 * WhatsApp Embedded Signup v4 launcher.
 *
 * Off until GET /channels/whatsapp/embedded-signup/config returns enabled.
 * extras is {} (v4). The 30-second code must be POSTed immediately.
 */

const DEFAULT_GRAPH_VERSION = 'v25.0';

export interface WhatsAppEmbeddedSignupSession {
  phone_number_id?: string;
  waba_id?: string;
  event?: string;
}

export interface WhatsAppEmbeddedSignupResult {
  code: string;
  session: WhatsAppEmbeddedSignupSession;
}

interface FacebookLoginResponse {
  authResponse?: { code?: string };
}

interface FacebookSdk {
  init: (opts: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void;
  login: (
    cb: (response: FacebookLoginResponse) => void,
    opts: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: boolean;
      extras: Record<string, never>;
    },
  ) => void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let sdkLoading: Promise<void> | null = null;

function loadFacebookSdk(appId: string, version: string): Promise<void> {
  if (window.FB) {
    window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
    return Promise.resolve();
  }
  if (sdkLoading) return sdkLoading;

  sdkLoading = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      try {
        window.FB?.init({ appId, autoLogAppEvents: true, xfbml: false, version });
        resolve();
      } catch (err) {
        sdkLoading = null;
        reject(err);
      }
    };
    const script = document.createElement('script');
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.onerror = () => {
      sdkLoading = null;
      reject(new Error('Failed to load Facebook SDK'));
    };
    document.head.appendChild(script);
  });
  return sdkLoading;
}

export async function launchWhatsAppEmbeddedSignup(opts: {
  appId: string;
  configId: string;
  graphVersion?: string;
}): Promise<WhatsAppEmbeddedSignupResult> {
  const version = opts.graphVersion || DEFAULT_GRAPH_VERSION;
  await loadFacebookSdk(opts.appId, version);

  let session: WhatsAppEmbeddedSignupSession = {};
  const onMessage = (event: MessageEvent) => {
    if (typeof event.origin !== 'string' || !event.origin.endsWith('facebook.com')) return;
    try {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
      session = {
        phone_number_id: data.data?.phone_number_id,
        waba_id: data.data?.waba_id,
        event: data.event,
      };
    } catch {
      /* ignore parse errors from other facebook.com frames */
    }
  };
  window.addEventListener('message', onMessage);

  try {
    const code = await new Promise<string>((resolve, reject) => {
      if (!window.FB) {
        reject(new Error('Facebook SDK missing'));
        return;
      }
      window.FB.login((response) => {
        const token = response.authResponse?.code;
        if (token) resolve(token);
        else reject(new Error('WhatsApp signup was cancelled'));
      }, {
        config_id: opts.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {},
      });
    });
    return { code, session };
  } finally {
    window.removeEventListener('message', onMessage);
  }
}
