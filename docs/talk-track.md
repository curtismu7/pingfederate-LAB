# Talk track: PingFederate LAB

About 12 minutes for the core cards; each card also stands alone. Use **Mock** to rehearse or when there is no
PingFederate (nothing leaves the laptop); use **Live** to show your own PingFederate. Say which one is on: the banner
always does, and Presenter mode keeps it on screen.

## Before you start

1. Run `npm run doctor`. Every line should say `ok`.
2. Open http://127.0.0.1:5400. Pick Mock or Live in the header. In Mock the sign-in dialog shows the demo user.
3. Pick a workspace name for this session in the header (for example `acme-demo`). `npm run reset` clears only that workspace,
   so a second presenter on the same laptop keeps their runs.
4. Optional: press **Presenter** to hide the chrome, **Esc** brings it back.

## The story (one minute)

"PingFederate already runs your sign-in. This page shows what it does for AI agents: each card is one standard, run
for real, with every request and response on screen. Secrets are blanked on the server; tokens show their decoded
claims."

## The cards, in shelf order

1. **Sign in (pi.flow).** The app draws its own sign-in; PingFederate still decides. Click Run. Show the first JSON
   (a flow with a status) and the answer after the password. Point at `COMPLETED` and the code. Try a wrong password:
   PingFederate refuses and the flow keeps waiting.
2. **Dynamic client registration.** Four steps: get a one-time token, register a client, use it, delete it. Say:
   "An agent can enrol itself, and you can take it away." If a run stops halfway, the client is still on PingFederate:
   run the Delete step to clean up (a reset from a terminal lists any client left behind).
3. **RAR via PAR.** A transfer of an exact amount between two named accounts. Say: "The consent is for this
   transaction, not a broad scope." Change the amount and run again; tick DPoP to bind the token to a key.
4. **CIBA.** The request starts on the lab; the approval comes from a separate place (the lab's own approve page).
   Say: "The person approves on their phone, not in the agent's window."
5. **DPoP sign-in.** The token only works with the key that asked for it. Show the proof header.
6. **Token exchange, two hops.** The user's token becomes an agent token, then an MCP token. Open the claims and show
   `act`: who is acting for whom.
7. **Userinfo.** Same user, claims straight from PingFederate (needs a sign-in first).
8. **Authentication API.** Opens a pi.flow and reads it without sending a password; the guide beside it explains each
   field.
9. **PAR, PKCE.** The two building blocks the others rely on.
10. **Playground.** Pick a protocol, change a parameter, run it, compare. Good for questions from the room.

## Mock versus live, in one sentence

"Mock is a stand-in so you can rehearse anywhere; Live is your real PingFederate, and then every trace is real."
Switching signs everyone out, on purpose.

## If something goes wrong

- A card says what setting it needs; open Settings from the card.
- "PingFederate no longer knows this sign-in (404)" means the flow expired; press Run again.
- **Reset this card** clears one card's run. From a terminal, `npm run reset` clears every run in the current workspace
  (pass the workspace name, or set `WORKSPACE`); sign-ins and saved settings stay.
