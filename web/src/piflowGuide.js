// What the pi.flow card explains, for PingFederate. Facts come from this lab's live runs against PingFederate
// (2026-10-30: the fields of the first answer, 404 RESOURCE_NOT_FOUND for a flow PingFederate no longer knows) and
// from the statuses this lab's server drives (server/src/piflow.js).
export const PIFLOW_GUIDE = {
  idp: 'PingFederate',
  otherIdp: 'PingOne',
  idea: [
    'A normal sign-in sends the browser to PingFederate\'s own login page and back. With response_mode=pi.flow, the same authorization request gets the sign-in back as JSON instead: a flow with a status that says what PingFederate needs next, and links for the actions it will accept.',
    'The app draws its own form, posts what the person typed to the flow, and repeats until PingFederate says COMPLETED. PingFederate still runs the sign-in: its authentication policy and adapters pick the steps, it checks the password, and it decides on MFA. The app only renders and relays. This is PingFederate\'s Authentication API.',
  ],
  steps: [
    { title: 'Open the flow', detail: 'The authorization request (client, redirect URI, scope, PKCE challenge) with response_mode=pi.flow. PingFederate answers 200 with the flow JSON, not a login page. The client must have "Allow Authentication API OAuth initiation" on.', call: 'GET /as/authorization.oauth2?...&response_mode=pi.flow', onThisCard: true },
    { title: 'Read status', detail: 'status names the form to draw. The flow can be read again at any time; it lives on PingFederate, not in the app.', call: 'GET /pf-ws/authn/flows/{flow id}', onThisCard: true },
    { title: 'Post the next action', detail: 'Pick an action from _links and post it with that action\'s content type, for example the username and password. PingFederate wants the X-XSRF-Header on these calls.', call: 'POST /pf-ws/authn/flows/{flow id}  Content-Type: application/vnd.pingidentity.checkUsernamePassword+json' },
    { title: 'Repeat until COMPLETED', detail: 'Each answer is a new status. After an MFA adapter finishes, the flow reports MFA_COMPLETED and the app posts continueAuthentication.' },
    { title: 'Get the code', detail: 'The COMPLETED answer carries it: authorizeResponse holds the code and the state the app sent, which the app checks.' },
    { title: 'Redeem it', detail: 'The code goes to the token endpoint with the PKCE verifier, as in any authorization-code flow. The ID token says who signed in.', call: 'POST /as/token.oauth2' },
  ],
  stepsNote: 'This card does steps 1 and 2 and sends no password. The Sign in, PKCE, PAR, RAR and DPoP cards run all six; their trace shows each one.',
  differences: [
    { topic: 'Where the code comes from', here: 'inside the COMPLETED answer, as authorizeResponse.', other: 'a separate call to resumeUrl after COMPLETED' },
    { topic: 'Password action', here: 'checkUsernamePassword, posted to /pf-ws/authn/flows/{id} with an X-XSRF-Header.', other: 'usernamePassword.check, posted to /flows/{id}' },
    { topic: 'Identifier-first', here: 'opens straight at USERNAME_PASSWORD_REQUIRED with the HTML form adapter.', other: 'a policy can open at SIGN_ON_REQUIRED and needs user.lookup first' },
    { topic: 'Wrong password', here: '400 with details[].code CREDENTIAL_VALIDATION_FAILED; the flow keeps waiting.', other: 'INVALID_CREDENTIALS' },
  ],
  fields: [
    { key: 'id', meaning: 'The flow id. Whoever holds it can continue this sign-in, so the lab masks it everywhere, including inside links.' },
    { key: 'status', meaning: 'What PingFederate needs next. The app picks the form to draw from this value alone (see the table below).' },
    { key: '_links', meaning: 'The actions PingFederate accepts now, each with the URL to post to. An action that is not listed is refused.' },
    { key: 'pluginTypeId', meaning: 'Which authentication adapter is running this step (here the username and password form). It changes when the policy moves to another adapter.' },
    { key: 'showRememberMyUsername', meaning: 'Whether the form should offer "remember my username"; rememberMyUsernameSelected is its current value.' },
    { key: 'showThisIsMyDevice', meaning: 'Whether the form should offer "this is my device"; thisIsMyDeviceSelected is its current value.' },
    { key: 'showCaptcha', meaning: 'Whether the adapter wants a CAPTCHA with the password.' },
    { key: 'authenticatorEnabled', meaning: 'Whether the adapter offers an authenticator option on this step.' },
  ],
  cookieNote: 'Not in the JSON: PingFederate also sets a session cookie, and every later call must send it back, or PingFederate refuses the step. That cookie ties the flow to the client that opened it. The lab keeps it on its server and shows it as redacted. A flow PingFederate no longer knows (expired, or PingFederate restarted) answers 404 RESOURCE_NOT_FOUND.',
  statuses: [
    { status: 'USERNAME_PASSWORD_REQUIRED', meaning: 'The username and password adapter wants both.', app: 'Draw both fields; post checkUsernamePassword.', lab: 'Drives it (seen live).' },
    { status: 'MFA_COMPLETED', meaning: 'An MFA adapter has finished.', app: 'Post continueAuthentication.', lab: 'Drives it.' },
    { status: 'COMPLETED', meaning: 'Sign-in is done; the answer carries authorizeResponse.', app: 'Check the state, then redeem the code.', lab: 'Drives it.' },
    { status: 'Any other status', meaning: 'Another adapter or step in the policy (for example an MFA prompt).', app: 'Draw that adapter\'s form.', lab: 'Stops and shows the status.' },
  ],
  statusesNote: 'This lab drives the password path only. Which other statuses appear depends on the adapters in your PingFederate\'s authentication policy; keep the lab\'s clients on a password-only policy to stay on the driven path.',
  when: {
    good: [
      'First-party apps: your own mobile, desktop or command-line app that needs its own sign-in screen.',
      'Agents and services you run, which have no browser to redirect.',
      'Embedded experiences where leaving the page would break the journey.',
    ],
    avoid: [
      'Third-party apps: with pi.flow the app sees the person\'s password. Use the redirect sign-in with PKCE so only PingFederate ever sees it.',
      'Apps that cannot draw every status their authentication policy can produce (MFA, other adapters).',
    ],
    note: 'Unlike the old password grant (ROPC), pi.flow keeps PingFederate in charge of every step: the authentication policy, MFA, lockout and risk checks all still apply.',
  },
};
